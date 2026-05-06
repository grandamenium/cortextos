import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { atomicWriteSync } from '../utils/atomic.js';
import { join, sep } from 'path';
import { homedir } from 'os';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { HermesPTY, hermesDbExists } from '../pty/hermes-pty.js';
import { MessageDedup, injectMessage } from '../pty/inject.js';
import { ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';
import { getOverdueReminders } from '../bus/reminders.js';
import { readCronState, parseDurationMs, cronExpressionMinIntervalMs } from '../bus/cron-state.js';
import { resolvePaths } from '../utils/paths.js';
import type { CronScheduler, ManagedAgent } from './cron-scheduler.js';
import { detectContextCap, archiveCappedSession } from './context-cap-detect.js';

type LogFn = (msg: string) => void;

/**
 * Manages a single agent's lifecycle.
 * Replaces agent-wrapper.sh for one agent.
 */
export class AgentProcess implements ManagedAgent {
  readonly name: string;
  private env: CtxEnv;
  private config: AgentConfig;
  private pty: AgentPTY | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount: number = 0;
  private maxCrashesPerDay: number = 10;
  private sessionStart: Date | null = null;
  private status: AgentStatus['status'] = 'stopped';
  private stopping: boolean = false;
  // Timestamp (epoch ms) of the last successful inject — used by isIdle() to
  // tell the daemon-side CronScheduler whether the agent is still processing
  // a previously-injected message. Cleared when we observe a fresh idle flag.
  private lastInjectedAt: number = 0;
  // BUG-040 fix: persists across stop() return until handleExit clears it.
  // Required because BUG-032's CRLF + 5s wait can cause graceful shutdown to
  // exceed the 5s Promise.race timeout in stop(), which would otherwise reset
  // `stopping=false` BEFORE the PTY actually exits, then handleExit would fire
  // with stopping=false and trigger spurious crash recovery (a partial regression
  // of BUG-011). stopRequested survives the timeout and is only cleared either
  // by handleExit when an intentional exit fires, or by start() at the beginning
  // of a new lifecycle.
  private stopRequested: boolean = false;
  // BUG-040 fix: monotonic generation counter incremented on each successful
  // start(). Each PTY's onExit closure captures the generation at spawn time
  // and bails out if the generation doesn't match — i.e. a NEW PTY has been
  // spawned since this old one was created. Without this guard, a late exit
  // from an old PTY can race past stopRequested and trigger crash recovery on
  // the new agent.
  private lifecycleGeneration: number = 0;
  // Guard: only one cron verification waiter in-flight per agent at a time.
  // Rapid --continue restarts must not stack duplicate waiters. (Issue #182)
  private cronVerificationPending: boolean = false;
  // BUG-011 fix: stop() awaits this promise (resolved by the onExit handler in start())
  // to guarantee the PTY exit has fired before stopping=false is reset. Without
  // this, the exit handler can fire after stopping=false and trigger spurious
  // crash recovery for an agent we just stopped intentionally.
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private dedup: MessageDedup;
  private log: LogFn;
  private onStatusChange: ((status: AgentStatus) => void) | null = null;
  private cronScheduler: CronScheduler | null;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn, cronScheduler?: CronScheduler | null) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));
    this.cronScheduler = cronScheduler ?? null;
  }

  // --- ManagedAgent interface (daemon-side CronScheduler) ---

  get stateDir(): string {
    return join(this.env.ctxRoot, 'state', this.name);
  }

  get configPath(): string {
    return join(this.env.agentDir, 'config.json');
  }

  get timezone(): string | undefined {
    return this.config.timezone || undefined;
  }

  get generation(): number {
    return this.lifecycleGeneration;
  }

  isRunning(): boolean {
    return this.status === 'running' && this.pty !== null;
  }

  /**
   * Idle iff the Stop hook's last_idle.flag timestamp is newer than the most
   * recent inject. Returns true when we have never injected yet (safe to fire).
   * Returns false when we can't read the flag (conservative — defer fires and
   * let maxDeferMs force-inject).
   */
  isIdle(): boolean {
    if (this.lastInjectedAt === 0) return true;
    const flagPath = join(this.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) return false;
      const idleMs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      return idleMs > this.lastInjectedAt;
    } catch {
      return false;
    }
  }

  /** CronScheduler.inject(). Delegates to injectMessage and tracks timestamp. */
  inject(message: string): boolean {
    const ok = this.injectMessage(message);
    if (ok) this.lastInjectedAt = Date.now();
    return ok;
  }

  /**
   * Start the agent. Spawns Claude Code in a PTY.
   */
  async start(): Promise<void> {
    if (this.status === 'running') {
      this.log('Already running');
      return;
    }

    // Apply startup delay
    const delay = this.config.startup_delay || 0;
    if (delay > 0) {
      this.log(`Startup delay: ${delay}s`);
      await sleep(delay * 1000);
    }

    // Write .cortextos-env for backward compat (D6)
    if (this.env.agentDir) {
      writeCortextosEnv(this.env.agentDir, this.env);
    }

    // Determine start mode
    const mode = this.shouldContinue() ? 'continue' : 'fresh';
    const prompt = mode === 'fresh'
      ? this.buildStartupPrompt()
      : this.buildContinuePrompt();

    this.log(`Starting in ${mode} mode`);
    this.status = 'starting';

    // BUG-040 fix: clear any stale stop request from a previous lifecycle
    // (e.g. if the previous stop() timed out before the PTY actually exited).
    // We're starting fresh — the new PTY has no pending stop.
    this.stopRequested = false;
    // BUG-040 fix: bump generation. The onExit closure below captures THIS
    // value and uses it to detect "I'm an old PTY whose exit fired after a
    // new lifecycle began" — in which case it bails out without touching
    // handleExit, preventing spurious crash recovery on the new agent.
    const myGeneration = ++this.lifecycleGeneration;

    // Create PTY — runtime-specific subclass handles binary, args, bootstrap detection
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);
    this.pty = this.config.runtime === 'hermes'
      ? new HermesPTY(this.env, this.config, logPath)
      : new AgentPTY(this.env, this.config, logPath);

    // BUG-011 fix: create a fresh exit signal for this run. resolveExit is
    // called from the onExit handler below; stop() awaits exitPromise to
    // guarantee the exit handler has fired before clearing stopping.
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    // Handle exit
    this.pty.onExit((exitCode, signal) => {
      // BUG-040 fix: if the lifecycle has moved on (a new start() incremented
      // the generation since this PTY was spawned), this is an old PTY's late
      // exit. Ignore it entirely — we don't want it to trigger handleExit on
      // the current PTY's state.
      if (myGeneration !== this.lifecycleGeneration) {
        this.log(`Ignoring late exit from previous lifecycle gen ${myGeneration} (current: ${this.lifecycleGeneration})`);
        return;
      }
      this.log(`Exited with code ${exitCode} signal ${signal}`);
      this.handleExit(exitCode);
      // Signal anyone awaiting this PTY's exit (e.g. stop() — BUG-011 fix)
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      await this.pty.spawn(mode, prompt);
      this.status = 'running';
      this.sessionStart = new Date();
      this.lastInjectedAt = 0;
      this.log(`Running (pid: ${this.pty.getPid()})`);

      // Start session timer
      this.startSessionTimer();

      // Attach to the daemon-side CronScheduler so config.json crons fire
      // via PTY injection regardless of in-session CronCreate state. This is
      // the reliable path that survives --continue restarts and ctx handoffs;
      // the in-session /loop setup remains as a redundant backup (MessageDedup
      // in injectMessage prevents double-firing when both paths are active).
      try {
        this.cronScheduler?.attachAgent(this);
      } catch (err) {
        this.log(`CronScheduler attach failed (non-fatal): ${err}`);
      }

      this.notifyStatusChange();
    } catch (err) {
      this.log(`Failed to start: ${err}`);
      this.status = 'crashed';
      this.notifyStatusChange();
    }
  }

  /**
   * Stop the agent gracefully.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // BUG-040 fix: stopRequested persists ACROSS stop()'s return until
    // handleExit clears it. This is the safety net for the case where the
    // PTY exits later than the Promise.race timeout below.
    this.stopRequested = true;
    this.log('Stopping...');
    this.clearSessionTimer();

    // Capture and null out pty BEFORE any awaits so handleExit() during graceful
    // shutdown doesn't race with us and trigger crash recovery or a double-kill.
    const pty = this.pty;
    this.pty = null;
    // Capture the exit promise before any awaits — we'll wait on this AFTER
    // pty.kill() to guarantee the exit handler has run before stopping=false.
    const exitPromise = this.exitPromise;

    if (pty) {
      try {
        if (this.config.runtime === 'hermes') {
          // Hermes REPL exit: Ctrl+D is the clean exit signal.
          // Hermes has a double-tap guard on Ctrl+C (accidental exit protection),
          // so we use Ctrl+D which exits cleanly on the first press.
          pty.write('\x04'); // Ctrl+D
          await sleep(3000);
        } else {
          // BUG-032 fix: use CRLF (not lone CR) so Claude Code's REPL actually
          // recognizes the /exit line as a complete command, AND wait long
          // enough (5s, was 3s) for the child to flush + exit cleanly. Without
          // these the child often dies from SIGHUP (exit code 129) when the
          // PTY is torn down before /exit has been processed. PR #11's
          // BUG-011 fix already ensured the daemon doesn't misinterpret 129
          // as a real crash, but the underlying graceful-shutdown sequence
          // still wasn't graceful — this PR makes it so.
          pty.write('\x03'); // Ctrl-C
          await sleep(1000);
          pty.write('/exit\r\n');
          await sleep(5000);
        }
      } catch {
        // Ignore write errors during shutdown
      }
      // BUG-032 follow-up: only kill the PTY if the process is still alive.
      // After /exit + 5s wait, the child has usually exited cleanly. Calling
      // pty.kill() on an already-exited PTY tears down the file descriptor,
      // which can send SIGHUP (exit code 129) to a process that was in the
      // middle of flushing. Polling first eliminates the remaining SIGHUP risk.
      if (pty.isAlive()) {
        try {
          pty.kill();
        } catch {
          // PTY may have exited between the check and the kill — ignore
        }
      }

      // BUG-011 fix: AWAIT the exit handler before resolving stop().
      // BUG-040 fix: bumped timeout from 5s to 15s to give the PTY plenty of
      // time to exit cleanly even when BUG-032's slow graceful shutdown stacks
      // on top of pty.kill() lag. The functional correctness no longer depends
      // on this timeout (stopRequested handles late exits), but a generous
      // timeout reduces "Ignoring late exit from previous lifecycle" log noise.
      if (exitPromise) {
        await Promise.race([exitPromise, sleep(15000)]);
      }
    }

    this.stopping = false;
    // NOTE: this.stopRequested is intentionally NOT cleared here. It is
    // cleared by handleExit when the intentional exit fires (or by start()
    // when a new lifecycle begins). See BUG-040 fix in handleExit().
    this.status = 'stopped';
    this.notifyStatusChange();
    this.log('Stopped');
  }

  /**
   * Restart with --continue (session refresh).
   *
   * Delegates to stop() + start() so it inherits the BUG-011 race fix
   * automatically. This also eliminates a separate bug in the previous
   * inline implementation where the OLD pty's exit handler could fire
   * AFTER the NEW pty was set up, nulling out the wrong reference.
   * `start()` will pick up `continue` mode automatically because the
   * conversation directory still has .jsonl files (shouldContinue() is true).
   */
  async sessionRefresh(): Promise<void> {
    this.log('Session refresh (--continue restart)');

    // Write .session-refresh marker BEFORE stop() so hook-crash-alert can
    // classify this exit as a planned session rotation (not a crash).
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.session-refresh');
    try {
      ensureDir(join(this.env.ctxRoot, 'state', this.name));
      writeFileSync(markerPath, 'session timer reached limit', 'utf-8');
    } catch { /* non-fatal */ }

    // Detect context-handoff: fast-checker writes .force-fresh before calling
    // sessionRefresh() for context-exhaustion restarts.
    const forceFreshExists = existsSync(join(this.env.ctxRoot, 'state', this.name, '.force-fresh'));
    const rotationType = forceFreshExists ? 'context-handoff' : 'soft';
    this.writeRotationEvent(rotationType, 'session timer reached limit').catch(() => {});

    await this.stop();
    await this.start();
    this.updateRotationResumeSuccess().catch(() => {});
    this.log('Session refreshed');
  }

  /**
   * Inject a message into the agent's PTY.
   */
  injectMessage(content: string): boolean {
    if (!this.pty || this.status !== 'running') {
      return false;
    }

    if (this.dedup.isDuplicate(content)) {
      this.log('Dedup: skipping duplicate message');
      return false;
    }

    injectMessage((data) => this.pty?.write(data), content);
    return true;
  }

  /**
   * Check if the agent has bootstrapped (ready for messages).
   */
  isBootstrapped(): boolean {
    return this.pty?.getOutputBuffer().isBootstrapped() ?? false;
  }

  /**
   * Get current agent status.
   */
  getStatus(): AgentStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() || undefined,
      uptime: this.sessionStart
        ? Math.floor((Date.now() - this.sessionStart.getTime()) / 1000)
        : undefined,
      sessionStart: this.sessionStart?.toISOString(),
      crashCount: this.crashCount,
      model: this.config.model,
    };
  }

  /**
   * Register a status change handler.
   */
  onStatusChanged(handler: (status: AgentStatus) => void): void {
    this.onStatusChange = handler;
  }

  /**
   * Write raw data to the agent's PTY.
   * Used for TUI navigation (key sequences).
   */
  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    }
  }

  /**
   * Get the output buffer for reading agent output.
   */
  getOutputBuffer() {
    return this.pty?.getOutputBuffer();
  }

  /**
   * Get the agent directory (where config.json and .env live).
   */
  getAgentDir(): string {
    return this.env.agentDir;
  }

  /**
   * Get the current agent config (live reference — fields may be updated in-place).
   */
  getConfig(): AgentConfig {
    return this.config;
  }

  // --- Private methods ---

  private handleExit(exitCode: number): void {
    // Capture rate-limit state from the output buffer BEFORE nulling the PTY.
    // Once this.pty = null, we lose access to the buffer.
    const isRateLimited = this.pty?.getOutputBuffer()?.hasRateLimitSignature() ?? false;
    const rateLimitResetSeconds = isRateLimited
      ? (this.pty?.getOutputBuffer()?.getRateLimitResetSeconds() ?? null)
      : null;

    this.pty = null;
    this.clearSessionTimer();
    // Detach from CronScheduler so no fires race a dead PTY. A subsequent
    // start() (crash recovery, session refresh) re-attaches with the new
    // generation; detaching here also ensures the scheduler doesn't hold a
    // stale ManagedAgent reference if the agent HALTs.
    try {
      this.cronScheduler?.detachAgent(this.name);
    } catch { /* non-fatal */ }

    // When the cortextos daemon is shut down by PM2, SIGTERM propagates to
    // the whole process group and reaches each PTY's Claude Code child
    // BEFORE the daemon's stopAll() loop has a chance to call stopAgent() on
    // it. Those children exit cleanly (code 0) but arrive at handleExit with
    // stopRequested=false, which used to classify the exit as a crash and
    // inflate .crash_count_today by one per agent, per PM2 restart.
    //
    // agent-manager.ts:stopAll() already writes a `.daemon-stop` marker in
    // every agent's state dir at the START of its shutdown loop for an
    // unrelated reason (SessionEnd crash-alert hook). We reuse that marker
    // here as the authoritative "the daemon is going down" signal. If the
    // marker exists AND is recent (written within the last 60s), any PTY
    // exit is a shutdown casualty, not a real crash — swallow it.
    //
    // The 60s window guards against a stale marker from a previous shutdown
    // that wasn't cleaned up: we do NOT want an old marker to silently mask
    // a genuine crash days later. handleExit does NOT delete the marker —
    // cleanup stays with agent-manager / hook-crash-alert per the existing
    // separation of concerns.
    if (this.isDaemonShuttingDown()) {
      return;
    }

    // BUG-040 fix: check stopRequested instead of (only) stopping. The
    // stopping flag is cleared inside stop() after a 15s timeout window —
    // which means a slow PTY shutdown can fire handleExit AFTER stopping is
    // already false, leading to spurious crash recovery. stopRequested is
    // set by stop() at the START of the shutdown sequence and persists across
    // stop()'s return until handleExit clears it (right here). This guarantees
    // that the FIRST exit after a stop() call is treated as intentional, no
    // matter how delayed it is.
    //
    // Also keep the legacy `stopping` check for in-progress detection during
    // the (most common) case where the exit fires while stop() is still
    // awaiting. Either flag short-circuits crash recovery.
    if (this.stopRequested || this.stopping) {
      this.stopRequested = false;
      return;
    }

    // Rate-limit recovery: if the output buffer detected a rate-limit signature,
    // treat this as a controlled pause rather than a crash. Do NOT increment
    // crashCount or call watchdog recordFailure. Write a marker file so the next
    // startup can include RATE-LIMIT RECOVERY context, then schedule a restart
    // after the configured (or default) pause duration.
    if (isRateLimited) {
      this.status = 'rate-limited';
      this.notifyStatusChange();

      // Write .rate-limited marker so the next boot knows this was a rate-limit pause
      const markerPath = join(this.env.ctxRoot, 'state', this.name, '.rate-limited');
      try {
        ensureDir(join(this.env.ctxRoot, 'state', this.name));
        writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
      } catch { /* non-fatal */ }

      // Schedule restart after pause
      const pauseSeconds = rateLimitResetSeconds
        ?? (this.config as Record<string, unknown>).rate_limit_pause_seconds as number | undefined
        ?? 18000;
      this.log(`Rate-limited: pausing ${pauseSeconds}s before restart`);

      setTimeout(() => {
        if (this.status === 'rate-limited') {
          this.start().catch(err => this.log(`Rate-limit restart failed: ${err}`));
        }
      }, pauseSeconds * 1000);

      return;
    }

    // Planned restart: the agent wrote .restart-planned via `cortextos bus hard-restart`
    // (or `bus self-restart`) before the session ended. This is an intentional exit —
    // skip crash counting entirely. The IPC restart-agent handler (triggered by the bus
    // command) will call restartAgent() → stop() + start() to bring the agent back up.
    // We do NOT unlink the marker here — hook-crash-alert.ts owns cleanup on next boot.
    const restartPlannedPath = join(this.env.ctxRoot, 'state', this.name, '.restart-planned');
    if (existsSync(restartPlannedPath)) {
      this.log('Planned restart (.restart-planned) — skipping crash count');
      return;
    }

    // ctx_autoreset (Tier 0): FastChecker writes .silent-restart before triggering
    // forceContextRestart(). Normally stopRequested is set by sessionRefresh() → stop()
    // before handleExit fires, but in edge cases (e.g. Claude Code exits before stop()
    // is called) this marker is the canonical signal. Skip crash counting.
    // Do NOT unlink — consumed by buildStartPrompt() on the next session boot.
    const silentRestartPath = join(this.env.ctxRoot, 'state', this.name, '.silent-restart');
    if (existsSync(silentRestartPath)) {
      this.log('ctx_autoreset (.silent-restart) — skipping crash count, sessionRefresh handles restart');
      return;
    }

    // Check crash limit
    this.crashCount++;
    const today = new Date().toISOString().split('T')[0];
    this.resetCrashCountIfNewDay(today);

    if (this.crashCount >= this.maxCrashesPerDay) {
      this.log(`HALTED: exceeded ${this.maxCrashesPerDay} crashes today`);
      this.appendCrashToRestartsLog(exitCode, 0, 'HALTED');
      this.status = 'halted';
      this.notifyStatusChange();
      return;
    }

    // Exponential backoff restart
    const backoff = Math.min(5000 * Math.pow(2, this.crashCount - 1), 300000);
    this.log(`Crash recovery: restart in ${backoff / 1000}s (crash #${this.crashCount})`);
    this.writeRotationEvent('crash', `exit_code=${exitCode}`).catch(() => {});
    // Persist the crash to restarts.log so operators have a durable audit
    // trail. Previously only planned SELF-RESTART / HARD-RESTART from
    // bus/system.ts wrote here, which left daemon-classified crashes
    // invisible outside the rotating PM2 daemon stdout log.
    this.appendCrashToRestartsLog(exitCode, backoff, 'CRASH');
    this.status = 'crashed';
    this.notifyStatusChange();

    setTimeout(() => {
      if (this.status === 'crashed') {
        this.start()
          .then(() => this.updateRotationResumeSuccess().catch(() => {}))
          .catch(err => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
  }

  private shouldContinue(): boolean {
    // Hermes: session continuity is determined by whether the SQLite DB exists.
    // HERMES_HOME env var overrides the default ~/.hermes path.
    if (this.config.runtime === 'hermes') {
      const hermesHome = process.env['HERMES_HOME'];
      return hermesDbExists(hermesHome);
    }

    // Check for force-fresh marker
    const forceFreshPath = join(this.env.ctxRoot, 'state', this.name, '.force-fresh');
    if (existsSync(forceFreshPath)) {
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(forceFreshPath);
      } catch { /* ignore */ }
      return false;
    }

    // Check for existing conversation
    const launchDir = this.config.working_directory || this.env.agentDir;
    if (!launchDir) return false;

    // Claude projects dir uses the absolute path with all separators replaced by dashes
    // e.g. /Users/foo/agents/boss -> -Users-foo-agents-boss (leading sep becomes -)
    // Use homedir() for cross-platform compatibility (HOME is not set on Windows).
    const convDir = join(
      homedir(),
      '.claude',
      'projects',
      launchDir.split(sep).join('-'),
    );

    try {
      const files = require('fs').readdirSync(convDir);
      if (!files.some((f: string) => f.endsWith('.jsonl'))) return false;
    } catch {
      return false;
    }

    // Context-cap zombie guard: if the most recent session jsonl ends
    // with Claude Code's "Context limit reached" marker, --continue
    // would restore that stuck state and re-zombie the agent on
    // restart. Archive the capped session aside so --continue has
    // nothing to pick up, then force a fresh session. Observed
    // 2026-04-19 with FRIDAY; full incident + design in
    // src/daemon/context-cap-detect.ts.
    const cap = detectContextCap(convDir);
    if (cap.capped && cap.sessionFile) {
      const archivePath = archiveCappedSession(cap.sessionFile);
      if (archivePath) {
        this.log(
          `Context-cap detected in prior session ${cap.sessionFile} — ` +
          `archived to ${archivePath}, forcing fresh session to break zombie loop.`,
        );
      } else {
        this.log(
          `Context-cap detected in ${cap.sessionFile} but archive rename failed — ` +
          `forcing fresh session anyway; --continue may restore the capped state.`,
        );
      }
      // Re-check whether any non-archived jsonl remains. If all sessions
      // were capped (or the only one was), we must start fresh.
      try {
        const remaining = require('fs').readdirSync(convDir);
        if (!remaining.some((f: string) => f.endsWith('.jsonl'))) return false;
      } catch {
        return false;
      }
      // An older non-capped session still exists — safer to start fresh
      // anyway, since --continue would pick up the next-most-recent
      // which may itself be stale. One zombie is enough evidence to
      // distrust the whole recent history for this agent.
      return false;
    }

    return true;
  }

  private buildStartupPrompt(): string {
    const onboardedPath = join(this.env.ctxRoot, 'state', this.name, '.onboarded');
    const onboardingPath = join(this.env.agentDir, 'ONBOARDING.md');
    const heartbeatPath = join(this.env.ctxRoot, 'state', this.name, 'heartbeat.json');
    let onboardingAppend = '';

    // If agent has a heartbeat but no .onboarded marker, they completed onboarding but
    // forgot to write the marker. Auto-write it so they don't re-onboard next restart.
    if (!existsSync(onboardedPath) && existsSync(heartbeatPath)) {
      try {
        const { writeFileSync } = require('fs');
        writeFileSync(onboardedPath, '', 'utf-8');
      } catch { /* ignore */ }
    }

    if (!existsSync(onboardedPath) && existsSync(onboardingPath)) {
      onboardingAppend = ' IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol.';
    }

    // Rate-limit recovery: if .rate-limited marker exists, prepend context
    const rateLimitMarker = join(this.env.ctxRoot, 'state', this.name, '.rate-limited');
    let rateLimitBlock = '';
    if (existsSync(rateLimitMarker)) {
      rateLimitBlock = ' RATE-LIMIT RECOVERY: Your previous session was paused due to API rate limiting. Resume normal operations but be mindful of request volume.';
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(rateLimitMarker);
      } catch { /* ignore */ }
    }

    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const handoffBlock = this.consumeHandoffBlock();
    const isHandoffRestart = handoffBlock.length > 0;
    const isSilentRestart = this.consumeSilentRestartMarker();
    // HANDOFF UX: the pickup message MUST be the first action after reading the handoff doc —
    // before cron restoration, before heartbeat, before anything else. Placing this instruction
    // immediately after the handoffBlock in the prompt ensures it is not buried.
    const handoffUxOverride = isHandoffRestart
      ? ' HANDOFF UX: This is a context handoff restart — your memory is intact via the handoff doc. CRITICAL: After reading the handoff document, your VERY FIRST tool call MUST be a Bash call running: cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID \'back — [what you were just working on]\' — replace the brackets with one brief plain-English sentence about your current state. Do this BEFORE restoring crons, BEFORE running heartbeat, BEFORE any other tool call. No cron IDs, no status report, no cold-boot phrasing. Do NOT send "Booting up... one moment" (skip AGENTS.md step 1 entirely).'
      : '';
    // SILENT AUTO-RESET UX: Tier 0 context auto-reset fires silently by design.
    // The agent should pick up work without any Telegram noise (no boot message,
    // no "back online" message). Crons, inbox, and memory still get restored.
    const silentUxOverride = isSilentRestart && !isHandoffRestart
      ? ' SILENT AUTO-RESET: This session was automatically reset by the daemon at the configured ctx_autoreset_threshold. Do NOT send any Telegram messages about booting, being back online, or restarting — the reset is internal and the user did not ask for it. Skip AGENTS.md step 1 (boot message) and step 14 (online status message) entirely. Restore crons, check inbox, pick up the highest-priority task silently.'
      : '';
    const onlineMessage = isHandoffRestart || isSilentRestart
      ? ''
      : ' After setting up crons, send a Telegram message to the user saying you are back online.';
    return `You are starting a new session. Current UTC time: ${nowUtc}.${rateLimitBlock} Read AGENTS.md and all bootstrap files listed there. Then restore your crons from config.json: CRITICAL DEDUP: Always call CronList BEFORE creating any cron. For each config.json entry, search the CronList output for its prompt text — if the prompt already appears, SKIP that cron entirely. For entries NOT already listed: for each entry with type "recurring" (or no type field), call CronCreate directly (do NOT use /loop — /loop will prompt the user about cloud scheduling which blocks boot in autonomous mode). Convert the interval to a cron expression: 1h→"0 */1 * * *", 2h→"0 */2 * * *", 4h→"0 */4 * * *", 6h→"0 */6 * * *", 12h→"0 */12 * * *", 24h→"0 0 * * *", Nm→"*/N * * * *". Pass recurring:true. For entries with type "once": compare fire_at against the current UTC time — if fire_at is in the future call CronCreate (one-shot, no recurring flag), if in the past delete that entry from config.json.${reminderBlock}${deliverablesBlock}${handoffBlock}${handoffUxOverride}${silentUxOverride}${onlineMessage}${onboardingAppend}`;
  }

  private buildContinuePrompt(): string {
    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. Restore your crons from config.json ONLY if missing. CRITICAL DEDUP: Call CronList FIRST. For each config.json entry, search the CronList output for its prompt text — if the prompt already appears, SKIP that cron. For entries NOT already listed: use CronCreate directly (do NOT use /loop — /loop will prompt about cloud scheduling which blocks autonomous boot). Convert interval to cron expression: 1h→"0 */1 * * *", 6h→"0 */6 * * *", 24h→"0 0 * * *", Nm→"*/N * * * *". Pass recurring:true for recurring entries, no recurring flag for once entries (only if fire_at is in the future). Rapid --continue restarts must not accumulate duplicates.${reminderBlock}${deliverablesBlock} Check inbox. Resume normal operations. After restoring crons and checking inbox, send a Telegram message to the user saying you are back online.`;
  }

  /**
   * Build a reminder block for the boot prompt.
   * If any pending reminders are overdue, include them so the agent handles them
   * even after a hard-restart that cleared in-memory cron state (#69).
   */
  private buildReminderBlock(): string {
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      const overdue = getOverdueReminders(paths);
      if (overdue.length === 0) return '';
      const items = overdue.map(r =>
        `  - [${r.id}] (due ${r.fire_at}): ${r.prompt}`,
      ).join('\n');
      return ` You also have ${overdue.length} overdue persistent reminder(s) from before this restart — handle each one, then run: cortextos bus ack-reminder <id>\n${items}`;
    } catch {
      return '';
    }
  }

  /**
   * Build a deliverable-standard instruction block for the boot prompt.
   * When require_deliverables is enabled in the org's context.json, agents
   * are told that every task submitted for review must have at least one
   * file attached via save-output. The instruction is injected dynamically
   * so existing agents pick up the rule on their next boot with zero file
   * changes, and toggling it off removes it from the next startup prompt.
   */
  private buildDeliverablesBlock(): string {
    try {
      const contextPath = join(this.env.frameworkRoot, 'orgs', this.env.org, 'context.json');
      if (!existsSync(contextPath)) return '';
      const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (!ctx.require_deliverables) return '';
      return ' DELIVERABLE STANDARD: Every task you submit for review MUST have at least one file deliverable attached via the save-output bus command. A task with zero file deliverables will be sent back. Attach files with: cortextos bus save-output <task-id> <file-path> --label "<descriptive label>". Labels must be human-readable at a glance: describe WHAT it is plus enough context to understand at a glance. Good: "Traffic Growth Plan — 10 channels, 30-day launch sequence". Bad: "traffic-growth-plan.md" or "output-1". Notes are for context only, never file paths or URLs.';
    } catch {
      return '';
    }
  }

  /**
   * Consume the .handoff-doc-path marker (written by the context watchdog or the
   * agent itself via `cortextos bus hard-restart --handoff-doc <path>`).
   * Returns a boot-prompt fragment pointing the new session at the handoff doc,
   * or an empty string if no marker exists.
   * The marker is unlinked after reading so it fires only once per restart.
   *
   * Fallback: if no marker exists, scan the agent's memory/handoffs/ directory
   * for any handoff doc written within the last hour and inject the most recent.
   */
  private consumeHandoffBlock(): string {
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.handoff-doc-path');

    // Primary path: explicit marker written by hard-restart or watchdog
    if (existsSync(markerPath)) {
      try {
        const { unlinkSync } = require('fs');
        const docPath = readFileSync(markerPath, 'utf-8').trim();
        unlinkSync(markerPath);
        if (docPath && existsSync(docPath)) {
          return ` CONTEXT HANDOFF: Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
        }
      } catch {
        // fall through to auto-scan
      }
    }

    // Fallback: auto-scan memory/handoffs/ for a recent (< 1 hour old) handoff doc
    try {
      const { readdirSync, statSync } = require('fs');
      const handoffsDir = join(this.env.agentDir, 'memory', 'handoffs');
      if (!existsSync(handoffsDir)) return '';
      const oneHourAgo = Date.now() - 60 * 60_000;
      const candidates = readdirSync(handoffsDir)
        .filter((f: string) => f.startsWith('handoff-') && f.endsWith('.md'))
        .map((f: string) => ({ name: f, path: join(handoffsDir, f), mtime: statSync(join(handoffsDir, f)).mtimeMs }))
        .filter((f: { name: string; path: string; mtime: number }) => f.mtime >= oneHourAgo)
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
      if (candidates.length === 0) return '';
      const docPath = candidates[0].path;
      return ` CONTEXT HANDOFF (auto-detected): Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
    } catch {
      return '';
    }
  }

  /**
   * Consume the `.silent-restart` marker (written by the FastChecker Tier 0
   * auto-reset or the `cortextos bus auto-compact-agent` manual hatch).
   * Returns true when the marker was present — signaling the boot prompt
   * builder to suppress the "booting" and "back online" Telegram messages.
   * Unlinks the marker so the effect lasts exactly one restart.
   */
  private consumeSilentRestartMarker(): boolean {
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.silent-restart');
    if (!existsSync(markerPath)) return false;
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(markerPath);
    } catch { /* ignore — we still treat it as silent */ }
    return true;
  }

  private startSessionTimer(): void {
    const DEFAULT_MAX_SESSION_S = 255600;
    // Node setTimeout uses int32 ms internally. Values > 2^31-1 (~24.8d) silently
    // coerce to 1ms, which combined with the BUG-048 reschedule loop below causes
    // an infinite tight loop. Clamp at the call site so any future misconfigured
    // max_session_seconds (e.g. a stray 3600000s = 1000h) cannot wedge the daemon.
    const MAX_SETTIMEOUT_MS = 2_147_483_647;
    const startedAt = Date.now();
    const initialMs = (this.config.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;

    // BUG-048 fix: re-read max_session_seconds from config.json on each timer
    // fire so that config changes after start() take effect. Without this, a
    // briefly-low max_session_seconds baked at start time causes a fleet-wide
    // simultaneous restart when all agents hit the same stale deadline.
    const scheduleCheck = (delayMs: number): void => {
      this.sessionTimer = setTimeout(() => {
        // Re-read current config from disk
        let currentMaxMs = initialMs;
        try {
          const configPath = join(this.env.agentDir, 'config.json');
          if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
            currentMaxMs = (cfg.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;
          }
        } catch { /* use initial value on read error */ }

        const elapsedMs = Date.now() - startedAt;
        const remainingMs = currentMaxMs - elapsedMs;

        if (remainingMs > 5000) {
          // Config was updated to a longer duration — reschedule for the remaining time.
          this.log(`Session timer: config updated to ${currentMaxMs / 1000}s, rescheduling (${Math.round(remainingMs / 1000)}s remaining)`);
          scheduleCheck(remainingMs);
          return;
        }

        this.log(`Session timer fired after ${Math.round(elapsedMs / 1000)}s (limit: ${currentMaxMs / 1000}s)`);
        this.sessionRefresh().catch(err => this.log(`Session refresh failed: ${err}`));
      }, Math.min(delayMs, MAX_SETTIMEOUT_MS));
    };

    scheduleCheck(initialMs);
  }

  private clearSessionTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  /**
   * Check whether the daemon is currently in its shutdown sequence.
   *
   * Returns true iff a `.daemon-stop` marker exists in this agent's state
   * dir AND was written within the last 60 seconds. The marker is written
   * by AgentManager.stopAll() before it begins iterating stopAgent() calls.
   * A stale marker older than 60s is treated as leftover from a prior
   * shutdown and ignored — real crashes must not be masked indefinitely.
   */
  private isDaemonShuttingDown(): boolean {
    const marker = join(this.env.ctxRoot, 'state', this.name, '.daemon-stop');
    try {
      if (!existsSync(marker)) return false;
      const ageMs = Date.now() - statSync(marker).mtimeMs;
      return ageMs < 60_000;
    } catch {
      return false;
    }
  }

  /**
   * Write a rotation event to the orch_rotation_events Supabase table.
   *
   * Fail-open: all errors are swallowed. This must NEVER block a restart.
   * Called fire-and-forget from sessionRefresh() and handleExit().
   */
  /**
   * Read Supabase credentials and resolve the agent's UUID from orch_agents.
   * Returns [url, key, agentUuid] or null if any step fails.
   * Shared by writeRotationEvent() and updateRotationResumeSuccess().
   */
  private async resolveSupabaseAgent(): Promise<[string, string, string] | null> {
    const envFile = join(this.env.agentDir, '.env');
    if (!existsSync(envFile)) return null;
    const envContent = readFileSync(envFile, 'utf-8');
    const url = envContent.match(/^SUPABASE_RGOS_URL=(.+)$/m)?.[1]?.trim();
    const key = envContent.match(/^SUPABASE_RGOS_SERVICE_KEY=(.+)$/m)?.[1]?.trim();
    if (!url || !key) return null;

    const lookupRes = await fetch(
      `${url}/rest/v1/orch_agents?select=id&title=ilike.${encodeURIComponent(this.name)}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!lookupRes.ok) return null;
    const rows = (await lookupRes.json()) as Array<{ id: string }>;
    const agentId = rows[0]?.id;
    if (!agentId) return null;
    return [url, key, agentId];
  }

  private async writeRotationEvent(rotationType: string, reason: string): Promise<void> {
    try {
      const resolved = await this.resolveSupabaseAgent();
      if (!resolved) return;
      const [url, key, agentId] = resolved;

      // Compute session duration
      const sessionDurationMs = this.sessionStart
        ? Date.now() - this.sessionStart.getTime()
        : null;

      // Read context usage % from context_status.json if available
      let contextUsagePct: number | null = null;
      try {
        const statusPath = join(this.env.ctxRoot, 'state', this.name, 'context_status.json');
        if (existsSync(statusPath)) {
          const data = JSON.parse(readFileSync(statusPath, 'utf-8'));
          if (typeof data.used_percentage === 'number') {
            contextUsagePct = data.used_percentage;
          }
        }
      } catch { /* non-fatal */ }

      // Write to orch_rotation_events
      await fetch(`${url}/rest/v1/orch_rotation_events`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          agent_id: agentId,
          notes: JSON.stringify({
            rotation_type: rotationType,
            reason,
            session_duration_ms: sessionDurationMs,
            context_usage_pct: contextUsagePct,
          }),
        }),
      });
    } catch {
      /* swallow — must never break crash recovery */
    }
  }

  /**
   * Mark the most recent rotation event for this agent as successfully resumed.
   * Called after start() completes in sessionRefresh() and crash recovery.
   * Fail-open: all errors are swallowed — this must NEVER block a restart.
   */
  private async updateRotationResumeSuccess(): Promise<void> {
    try {
      const resolved = await this.resolveSupabaseAgent();
      if (!resolved) return;
      const [url, key, agentId] = resolved;

      // Find the most recent rotation event for this agent that has not yet been
      // marked as resumed (resume_success IS NULL = inserted by writeRotationEvent).
      const selectRes = await fetch(
        `${url}/rest/v1/orch_rotation_events?agent_id=eq.${agentId}&resume_success=is.null&order=rotation_at.desc&limit=1&select=id`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      );
      if (!selectRes.ok) return;
      const rows = (await selectRes.json()) as Array<{ id: string }>;
      const eventId = rows[0]?.id;
      if (!eventId) return;

      // Mark it resumed
      await fetch(
        `${url}/rest/v1/orch_rotation_events?id=eq.${eventId}`,
        {
          method: 'PATCH',
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            resume_success: true,
            resume_at: new Date().toISOString(),
          }),
        },
      );
    } catch {
      /* swallow — must never break restart */
    }
  }

  /**
   * Append an unplanned-exit entry to restarts.log. Complements the planned
   * SELF-RESTART / HARD-RESTART entries written by src/bus/system.ts so that
   * a single file gives the complete restart history for an agent.
   *
   * Format matches bus/system.ts: `[ISO] <KIND>: <details>`. appendFileSync
   * uses write(2) with O_APPEND on Linux, which is atomic for writes under
   * PIPE_BUF (~4KB) — each CRASH line fits comfortably. All errors are
   * swallowed: logging must never break crash recovery.
   */
  private appendCrashToRestartsLog(
    exitCode: number,
    backoffMs: number,
    kind: 'CRASH' | 'HALTED',
  ): void {
    try {
      const logDir = join(this.env.ctxRoot, 'logs', this.name);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const details =
        kind === 'HALTED'
          ? `exit_code=${exitCode} crash_count=${this.crashCount} max_crashes=${this.maxCrashesPerDay}`
          : `exit_code=${exitCode} crash_count=${this.crashCount} backoff_s=${backoffMs / 1000}`;
      const logLine = `[${timestamp}] ${kind}: ${details}\n`;
      appendFileSync(join(logDir, 'restarts.log'), logLine, 'utf-8');
    } catch {
      /* swallow — never break crash recovery on a logging failure */
    }
  }

  private resetCrashCountIfNewDay(today: string): void {
    const crashFile = join(this.env.ctxRoot, 'logs', this.name, '.crash_count_today');
    try {
      if (existsSync(crashFile)) {
        const content = readFileSync(crashFile, 'utf-8').trim();
        const [storedDate, count] = content.split(':');
        if (storedDate === today) {
          this.crashCount = parseInt(count, 10) + 1;
        } else {
          this.crashCount = 1;
        }
      }
      ensureDir(join(this.env.ctxRoot, 'logs', this.name));
      atomicWriteSync(crashFile, `${today}:${this.crashCount}`);
    } catch { /* ignore */ }
  }

  private notifyStatusChange(): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }

  /**
   * Schedule a background cron verification check.
   *
   * Waits for the agent to finish its startup sequence (detected via the
   * last_idle.flag written by the Stop hook after the agent's first turn
   * completes), then injects a lightweight prompt asking the agent to
   * verify its crons match config.json and restore any that are missing.
   *
   * Safe for both fresh starts and --continue restarts: the idle-wait
   * ensures we never inject mid-conversation.
   *
   * Fire-and-forget: errors are logged but never propagated.
   */
  scheduleCronVerification(): void {
    // Hermes owns its cron scheduler natively — no CronList / /loop needed.
    // Verification via injected prompts would interfere with Hermes's own cron system.
    if (this.config.runtime === 'hermes') return;

    const crons = this.config.crons;
    if (!crons || crons.length === 0) return;

    const recurringNames = crons
      .filter(c => c.type !== 'once' && c.type !== 'disabled')
      .map(c => c.name);
    if (recurringNames.length === 0) return;

    // Dedup: only one waiter in-flight per agent. Rapid --continue restarts
    // would otherwise stack multiple concurrent waiters. (Issue #182)
    if (this.cronVerificationPending) {
      this.log('Cron verification already pending — skipping duplicate');
      return;
    }

    const generation = this.lifecycleGeneration;

    // Run in background — don't block startup
    this.cronVerificationPending = true;
    this.verifyCronsAfterIdle(recurringNames, generation)
      .catch(err => { this.log(`Cron verification failed (non-fatal): ${err}`); })
      .finally(() => { this.cronVerificationPending = false; });
  }

  /**
   * Starts a background gap-detection loop for recurring interval-based crons.
   * Reads cron-state.json every 10 minutes; injects a nudge if any cron has
   * been silent for >2x its expected interval.
   *
   * Fire-and-forget: errors are logged but never propagated.
   */
  scheduleGapDetection(): void {
    const crons = this.config.crons;
    if (!crons || crons.length === 0) return;

    // Monitor recurring crons with either a parseable interval or a cron expression
    const monitorable = crons.filter(c => {
      if (c.type === 'once' || c.type === 'disabled') return false;
      if (c.interval && !isNaN(parseDurationMs(c.interval))) return true;
      if (c.cron) return true;
      return false;
    });
    if (monitorable.length === 0) return;

    const generation = this.lifecycleGeneration;
    const loopStartedAt = Date.now();

    this.runGapDetectionLoop(monitorable, generation, loopStartedAt).catch(err => {
      this.log(`Cron gap detection failed (non-fatal): ${err}`);
    });
  }

  private async runGapDetectionLoop(
    crons: Array<{ name: string; interval?: string; cron?: string }>,
    generation: number,
    loopStartedAt: number,
  ): Promise<void> {
    const GAP_POLL_MS = 10 * 60 * 1000;   // poll every 10 minutes
    const GAP_MULTIPLIER = 2.0;            // nudge when gap > 2x expected interval
    // Nudge-gating thresholds (issue #200 — gap-nudge-starves-scheduler).
    // Rationale: injecting a nudge into the PTY keeps the Claude Code session busy,
    // which prevents its internal CronCreate scheduler from firing. Back-to-back
    // nudges across multiple stale crons cascade this starvation fleet-wide.
    //
    // NOTE: both thresholds are tuned for ≥4h cron cadences (current fleet norm).
    // If sub-minute crons are introduced, revisit: a short-turn agent may never
    // hit a 60s idle window, and a cron with interval < CRON_STATE_FRESH_MS would
    // be suppressed on every poll even when genuinely dead.
    const IDLE_WINDOW_MS = 60 * 1000;          // agent must have been idle in the last 60s
    const CRON_STATE_FRESH_MS = 2 * 60 * 1000; // skip entire poll if cron-state was just written

    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const idleFlagPath = join(stateDir, 'last_idle.flag');

    // Initial wait — give the agent time to boot and register crons before first check
    await sleep(GAP_POLL_MS);

    while (true) {
      if (generation !== this.lifecycleGeneration || this.status !== 'running') return;

      const now = Date.now();
      const state = readCronState(stateDir);

      // Gate 1 — cron-state freshness: if the agent wrote cron-state.json within
      // the last CRON_STATE_FRESH_MS, its cron scheduler is demonstrably working.
      // Skip the entire poll to avoid piling nudges on top of live cron cycles.
      const stateUpdatedAt = Date.parse(state.updated_at);
      if (!isNaN(stateUpdatedAt) && (now - stateUpdatedAt) < CRON_STATE_FRESH_MS) {
        this.log(`Gap detector: cron-state fresh (${Math.round((now - stateUpdatedAt) / 1000)}s old), skipping nudges`);
        await sleep(GAP_POLL_MS);
        continue;
      }

      // Gate 2 — idle check: last_idle.flag is written (in Unix seconds) by the
      // Stop hook (src/hooks/hook-idle-flag.ts) when Claude Code finishes a turn.
      // If the flag is missing or stale, the agent is actively processing — nudging
      // now would extend the busy window, prevent internal cron scheduling, and
      // compound the problem.
      let lastIdleMs = 0;
      try {
        if (existsSync(idleFlagPath)) {
          const sec = parseInt(readFileSync(idleFlagPath, 'utf-8').trim(), 10);
          if (!isNaN(sec)) lastIdleMs = sec * 1000;
        }
      } catch { /* ignore */ }
      if (lastIdleMs === 0 || (now - lastIdleMs) > IDLE_WINDOW_MS) {
        const idleAge = lastIdleMs ? `${Math.round((now - lastIdleMs) / 1000)}s` : 'never';
        this.log(`Gap detector: agent not idle (last idle ${idleAge}), skipping nudges`);
        await sleep(GAP_POLL_MS);
        continue;
      }

      for (const cronDef of crons) {
        const intervalMs = cronDef.interval
          ? parseDurationMs(cronDef.interval)
          : cronExpressionMinIntervalMs(cronDef.cron!);

        const record = state.crons.find(r => r.name === cronDef.name);
        let lastFireMs: number;
        if (!record) {
          lastFireMs = loopStartedAt;
        } else {
          lastFireMs = Date.parse(record.last_fire);
          if (isNaN(lastFireMs)) continue;
          // If the recorded fire time pre-dates this daemon start (e.g. stale timestamp
          // from before a restart storm), clamp to loopStartedAt so we don't fire false
          // gap nudges for crons that simply haven't had a chance to run since the restart.
          lastFireMs = Math.max(lastFireMs, loopStartedAt);
        }

        const gapMs = now - lastFireMs;
        const threshold = intervalMs * GAP_MULTIPLIER;

        if (gapMs > threshold) {
          const gapMin = Math.round(gapMs / 60_000);
          const expectedMin = Math.round(intervalMs / 60_000);
          const restoreHint = cronDef.interval
            ? `If missing, restore it from config.json: /loop ${cronDef.interval} <cron prompt>.`
            : `If missing, restore it from config.json using the cron expression in your config.`;
          const nudge = `[SYSTEM] Cron gap detected for "${cronDef.name}": last fired ${gapMin} minutes ago (expected every ${expectedMin} minutes). Run CronList to verify the cron is still active. ${restoreHint}`;

          this.log(`Gap nudge: ${cronDef.name} silent ${gapMin}min (threshold: ${Math.round(threshold / 60_000)}min)`);
          if (this.pty && this.status === 'running') {
            injectMessage((data) => this.pty?.write(data), nudge);
            // Stagger: wait between nudges so the agent can process each one
            // before the next arrives. Without this, N simultaneous stale crons
            // fire N back-to-back injections, spiking context and triggering
            // ctx-watchdog restarts. (Issue #182)
            await sleep(30_000);
          }
        }
      }

      await sleep(GAP_POLL_MS);
    }
  }

  private async verifyCronsAfterIdle(
    expectedCrons: string[],
    generation: number,
  ): Promise<void> {
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const flagPath = join(stateDir, 'last_idle.flag');

    // Record the idle flag timestamp at boot so we can detect the NEXT idle
    // (i.e. after the agent has finished processing its startup prompt).
    let bootIdleTs = 0;
    try {
      if (existsSync(flagPath)) {
        bootIdleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10);
      }
    } catch { /* ignore */ }

    // Wait up to 30 minutes for the agent to finish its startup turn.
    // 10 min was too short — agents busy processing gap nudge bursts would
    // never go idle in time and the verification would silently drop. (Issue #182)
    const maxWaitMs = 30 * 60 * 1000;
    const pollMs = 15_000;
    const startTime = Date.now();
    let foundIdle = false;

    while (Date.now() - startTime < maxWaitMs) {
      // Bail if this lifecycle is stale (agent restarted or stopped)
      if (generation !== this.lifecycleGeneration || this.status !== 'running') {
        return;
      }

      await sleep(pollMs);

      try {
        if (existsSync(flagPath)) {
          const currentIdleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10);
          if (currentIdleTs > bootIdleTs) {
            // Agent has gone idle after boot — safe to inject
            foundIdle = true;
            break;
          }
        }
      } catch { /* ignore read errors, keep polling */ }
    }

    // If the loop timed out without detecting an idle transition, do not inject:
    // the agent never finished its startup turn (e.g. stuck on a very long boot).
    if (!foundIdle) {
      this.log('Cron verification: timed out waiting for idle flag, skipping injection');
      return;
    }

    // Final stale check
    if (generation !== this.lifecycleGeneration || this.status !== 'running') {
      return;
    }

    // Inject the verification prompt
    const cronList = expectedCrons.join(', ');
    const verifyPrompt = `[SYSTEM] Cron verification: your config.json defines these recurring crons: ${cronList}. Run CronList now. If any are missing, restore them from config.json using /loop. This is an automated safety check.`;

    this.log(`Injecting cron verification (expecting: ${cronList})`);
    if (this.pty) {
      injectMessage((data) => this.pty?.write(data), verifyPrompt);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
