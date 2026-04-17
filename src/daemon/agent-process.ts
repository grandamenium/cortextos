import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { homedir } from 'os';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { MessageDedup, injectMessage } from '../pty/inject.js';
import { ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';
import { getOverdueReminders } from '../bus/reminders.js';
import { readCronState, parseDurationMs } from '../bus/cron-state.js';
import { resolvePaths } from '../utils/paths.js';

type LogFn = (msg: string) => void;

/**
 * Manages a single agent's lifecycle.
 * Replaces agent-wrapper.sh for one agent.
 */
export class AgentProcess {
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
  // BUG-011 fix: stop() awaits this promise (resolved by the onExit handler in start())
  // to guarantee the PTY exit has fired before stopping=false is reset. Without
  // this, the exit handler can fire after stopping=false and trigger spurious
  // crash recovery for an agent we just stopped intentionally.
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private dedup: MessageDedup;
  private log: LogFn;
  private onStatusChange: ((status: AgentStatus) => void) | null = null;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));
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

    // Create PTY
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);
    this.pty = new AgentPTY(this.env, this.config, logPath);

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
      this.log(`Running (pid: ${this.pty.getPid()})`);

      // Start session timer
      this.startSessionTimer();

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
    await this.stop();
    await this.start();
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

    injectMessage((data) => this.pty!.write(data), content);
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

  // --- Private methods ---

  private handleExit(exitCode: number): void {
    this.pty = null;
    this.clearSessionTimer();

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
    // Persist the crash to restarts.log so operators have a durable audit
    // trail. Previously only planned SELF-RESTART / HARD-RESTART from
    // bus/system.ts wrote here, which left daemon-classified crashes
    // invisible outside the rotating PM2 daemon stdout log.
    this.appendCrashToRestartsLog(exitCode, backoff, 'CRASH');
    this.status = 'crashed';
    this.notifyStatusChange();

    setTimeout(() => {
      if (this.status === 'crashed') {
        this.start().catch(err => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
  }

  private shouldContinue(): boolean {
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
      return files.some((f: string) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
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

    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    return `You are starting a new session. Current UTC time: ${nowUtc}. Read AGENTS.md and all bootstrap files listed there. Then restore your crons from config.json: for each entry with type "recurring" (or no type field), call /loop {interval} {prompt}; for each entry with type "once", compare fire_at against the current UTC time above — if fire_at is still in the future recreate the CronCreate, if fire_at is in the past delete that entry from config.json. Run CronList first to avoid duplicates.${reminderBlock}${deliverablesBlock} After setting up crons, send a Telegram message to the user saying you are back online.${onboardingAppend}`;
  }

  private buildContinuePrompt(): string {
    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. Restore your crons from config.json: recurring entries use /loop, once entries use CronCreate only if fire_at is still in the future (delete expired ones from config.json). Run CronList first — no duplicates.${reminderBlock}${deliverablesBlock} Check inbox. Resume normal operations. After restoring crons and checking inbox, send a Telegram message to the user saying you are back online.`;
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

  private startSessionTimer(): void {
    const DEFAULT_MAX_SESSION_S = 255600;
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
      }, delayMs);
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
      writeFileSync(crashFile, `${today}:${this.crashCount}`, 'utf-8');
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
    const crons = this.config.crons;
    if (!crons || crons.length === 0) return;

    const recurringNames = crons
      .filter(c => c.type !== 'once')
      .map(c => c.name);
    if (recurringNames.length === 0) return;

    const generation = this.lifecycleGeneration;

    // Run in background — don't block startup
    this.verifyCronsAfterIdle(recurringNames, generation).catch(err => {
      this.log(`Cron verification failed (non-fatal): ${err}`);
    });
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

    // Only monitor recurring crons with a parseable interval (skip cron expressions)
    const monitorable = crons.filter(
      c => c.type !== 'once' && c.interval && !isNaN(parseDurationMs(c.interval)),
    );
    if (monitorable.length === 0) return;

    const generation = this.lifecycleGeneration;
    const loopStartedAt = Date.now();

    this.runGapDetectionLoop(monitorable, generation, loopStartedAt).catch(err => {
      this.log(`Cron gap detection failed (non-fatal): ${err}`);
    });
  }

  private async runGapDetectionLoop(
    crons: Array<{ name: string; interval?: string }>,
    generation: number,
    loopStartedAt: number,
  ): Promise<void> {
    const GAP_POLL_MS = 10 * 60 * 1000;   // poll every 10 minutes
    const GAP_MULTIPLIER = 2.0;            // nudge when gap > 2x expected interval

    const stateDir = join(this.env.ctxRoot, 'state', this.name);

    // Initial wait — give the agent time to boot and register crons before first check
    await sleep(GAP_POLL_MS);

    while (true) {
      if (generation !== this.lifecycleGeneration || this.status !== 'running') return;

      const now = Date.now();
      const state = readCronState(stateDir);

      for (const cronDef of crons) {
        const intervalMs = parseDurationMs(cronDef.interval!);

        const record = state.crons.find(r => r.name === cronDef.name);
        let lastFireMs: number;
        if (!record) {
          // No fire record yet (cold start or daemon restart before first cron fire).
          // Treat the loop start time as the implicit last fire. This means gap
          // detection will nudge if the cron hasn't fired within 2x its interval
          // AFTER the daemon restarted — preventing dead zones on cold starts.
          lastFireMs = loopStartedAt;
        } else {
          lastFireMs = Date.parse(record.last_fire);
          if (isNaN(lastFireMs)) continue;
        }

        const gapMs = now - lastFireMs;
        const threshold = intervalMs * GAP_MULTIPLIER;

        if (gapMs > threshold) {
          const gapMin = Math.round(gapMs / 60_000);
          const expectedMin = Math.round(intervalMs / 60_000);
          const nudge = `[SYSTEM] Cron gap detected for "${cronDef.name}": last fired ${gapMin} minutes ago (expected every ${expectedMin} minutes). Run CronList to verify the cron is still active. If missing, restore it from config.json: /loop ${cronDef.interval} <cron prompt>.`;

          this.log(`Gap nudge: ${cronDef.name} silent ${gapMin}min (threshold: ${Math.round(threshold / 60_000)}min)`);
          if (this.pty && this.status === 'running') {
            injectMessage((data) => this.pty!.write(data), nudge);
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

    // Wait up to 10 minutes for the agent to finish its startup turn.
    // Poll every 15s. Bail if the agent stopped or a new lifecycle started.
    const maxWaitMs = 10 * 60 * 1000;
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
      injectMessage((data) => this.pty!.write(data), verifyPrompt);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
