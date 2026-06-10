import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { CodexAppServerPTY } from '../pty/codex-app-server-pty.js';
import { HermesPTY, hermesDbExists } from '../pty/hermes-pty.js';
import { MessageDedup, injectMessage } from '../pty/inject.js';
import type { TelegramAPI } from '../telegram/api.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';
import { getOverdueReminders } from '../bus/reminders.js';
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
  private pty: AgentPTY | CodexAppServerPTY | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private sizeTimer: ReturnType<typeof setInterval> | null = null;
  // In-flight guard for size-aware rotation: prevents a second archiveAndRefresh
  // from overlapping the first (interval re-entrancy / external stop-start race).
  private rotating: boolean = false;
  private crashCount: number = 0;
  private maxCrashesPerDay: number = 10;
  // CrashLoopPauser (instar-inspired): sliding-window crash detection.
  // Timestamps of recent crashes within the configured window. If the
  // window fills, the agent auto-pauses instead of retrying with backoff.
  private crashTimestamps: number[] = [];
  private crashWindowMs: number = 0;
  private crashWindowMax: number = 0;
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
  // Issue #330: held here so CodexAppServerPTY can be re-wired across session refresh
  // (each start() recreates the PTY, but the Telegram handle persists).
  private telegramApi: TelegramAPI | null = null;
  private telegramChatId: string | null = null;
  // Issue #392: tracks whether the most recently built startup prompt consumed
  // a handoff doc marker. start() reads this after spawn to decide whether the
  // daemon should fire the codex-app-server back-online Telegram directly
  // (skipped on handoff restart — the agent sends its own contextual reply).
  private lastSpawnWasHandoff = false;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    if (config.crash_window?.seconds) {
      this.crashWindowMs = config.crash_window.seconds * 1000;
      this.crashWindowMax = config.crash_window.max_crashes ?? 3;
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

    // Create PTY — runtime-specific subclass handles binary, args, bootstrap detection
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);
    this.pty = this.config.runtime === 'hermes'
      ? new HermesPTY(this.env, this.config, logPath)
      : this.config.runtime === 'codex-app-server'
        ? new CodexAppServerPTY(this.env, this.config, logPath)
        : new AgentPTY(this.env, this.config, logPath);

    // Issue #330: re-wire the Telegram handle on every start() (session refresh
    // creates a fresh CodexAppServerPTY). Only CodexAppServerPTY uses this — Claude / Hermes
    // typing indicators flow through fast-checker.
    if (this.config.runtime === 'codex-app-server' && this.telegramApi && this.telegramChatId) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(this.telegramApi, this.telegramChatId);
    }

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
      // Codex exec-per-turn race: the new PTY's onExit can fire BEFORE this
      // line if `codex exec` completes its prompt quickly (CodexAppServerPTY's spawn
      // resolves once exec is launched, but the process may exit moments
      // later as it finishes the bootstrap turn). handleExit() nulls
      // this.pty and schedules crash recovery — we must not claim 'running'
      // or call getPid() on null in that window.
      if (!this.pty) {
        this.log('PTY exited during spawn — handleExit will recover');
        return;
      }
      this.status = 'running';
      this.sessionStart = new Date();
      this.log(`Running (pid: ${this.pty.getPid()})`);

      // Authoritative per-agent liveness record (process_alive monitoring, zeus 1781114839073). The
      // daemon is the ONLY component that knows which pid IS this managed agent — an external /proc scan
      // cannot distinguish the managed agent from a daemon-spawned WORKER in the same cwd, nor honor a
      // custom working_directory / no-skip-flag launch. So the daemon writes the pid here; box-sync
      // readers read THIS file (+ verify the pid is alive) for a definitive UP/DOWN. Removed in
      // handleExit so a dead agent leaves no live pid. Best-effort: never let it block startup.
      this.writeAgentPidFile(this.pty.getPid());

      // Issue #392: codex-app-server does not reliably execute the inline
      // "Send a Telegram message saying you are back online" instruction the
      // way claude-code does, so fire the back-online ping directly from the
      // daemon for that runtime. Skipped on handoff restart — the agent
      // sends its own contextual "back — ..." reply in that case.
      this.maybeSendCodexBootNotification();

      // Start session timer (time cap) + size-aware rotation monitor
      this.startSessionTimer();
      this.startSizeMonitor();

      this.notifyStatusChange();
    } catch (err) {
      this.log(`Failed to start: ${err}`);
      // Clear any timers armed before the failure so a crashed/never-running
      // agent doesn't keep firing the session/size timers in the background.
      this.clearSessionTimer();
      this.clearSizeMonitor();
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
    this.clearSizeMonitor();

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
        } else if (this.config.runtime === 'codex-app-server') {
          // Codex uses an exec-per-turn model — there is no persistent REPL
          // between turns, so /exit + sleep below are no-ops on CodexAppServerPTY
          // (write() just buffers). The only meaningful stop step is
          // pty.kill(), which terminates the in-flight `codex exec` (if any)
          // and flips _alive=false. Skipping the 6s Claude-REPL dance makes
          // `bus hard-restart` feel responsive instead of appearing to do
          // nothing for several seconds.
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
    // Write .session-refresh marker so the SessionEnd crash-alert hook
    // (src/hooks/hook-crash-alert.ts) classifies the imminent PTY exit as a
    // session refresh rather than a crash. The hook's marker handler +
    // quiet-suppression set + message switch were all wired for this type,
    // but no writer existed — every --continue rollover at the session-time
    // cap surfaced as a false-positive 'crash' on chief/analyst + the
    // crashes.log file.
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      writeFileSync(
        join(paths.stateDir, '.session-refresh'),
        'session-time-cap rollover\n',
        'utf-8',
      );
    } catch (err) {
      this.log(`Failed to write .session-refresh marker: ${err}`);
    }
    await this.stop();
    await this.start();
    this.log('Session refreshed');
  }

  /**
   * Inject a message into the agent's PTY — structured outcome.
   *
   * Distinguishes NOT_RUNNING (agent registered but no live PTY) from
   * DEDUPED (content collapsed against the in-process MessageDedup window).
   * See issue #346 — both used to surface as a bare `false` and got mistaken
   * for "agent not found" by operators investigating restart/cron failures.
   */
  injectMessageDetailed(content: string): { ok: true } | { ok: false; code: 'NOT_RUNNING' | 'DEDUPED'; message: string } {
    if (!this.pty || this.status !== 'running') {
      return { ok: false, code: 'NOT_RUNNING', message: `agent "${this.name}" is registered but not running (status: ${this.status})` };
    }

    if (this.dedup.isDuplicate(content)) {
      this.log('Dedup: skipping duplicate message');
      return { ok: false, code: 'DEDUPED', message: `inject for "${this.name}" deduped — content matches MessageDedup hash window` };
    }

    injectMessage((data) => this.pty?.write(data), content);
    return { ok: true };
  }

  /**
   * Inject a message into the agent's PTY (back-compat boolean wrapper).
   * New callers that need to distinguish DEDUPED from NOT_RUNNING should use
   * `injectMessageDetailed()` instead.
   */
  injectMessage(content: string): boolean {
    return this.injectMessageDetailed(content).ok;
  }

  /**
   * Check if the agent has bootstrapped (ready for messages).
   */
  isBootstrapped(): boolean {
    return this.pty?.getOutputBuffer().isBootstrapped() ?? false;
  }

  /** Path to the daemon-written per-agent pidfile (process_alive monitoring). */
  private agentPidFilePath(): string {
    return join(this.env.ctxRoot, 'state', this.name, 'agent.pid');
  }

  /**
   * Read the kernel start-time of a pid, identically derivable by the reader, so a recorded pid that was
   * later RECYCLED to a different process is rejected (the reused pid has a different start-time). Linux:
   * /proc/<pid>/stat field 22 (clock ticks since boot). macOS/other: `ps -o lstart=` (start timestamp).
   * null if undeterminable -> the reader simply skips the start-time check (still has alive+claude+ppid).
   */
  private getProcessStartTime(pid: number): string | null {
    try {
      if (process.platform !== 'darwin' && existsSync(`/proc/${pid}/stat`)) {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        // "pid (comm) state ppid ..."; comm may hold spaces/parens -> fields resume after the LAST ')'.
        // After ')': index0=state(field3); starttime is field22 -> index 19.
        const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        return after[19] || null;
      }
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf-8', timeout: 5000,
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  /**
   * Record THIS managed agent's pid (+ its start-time) so an external reader can derive a definitive
   * UP/DOWN. The daemon is authoritative: it knows the exact pid of the managed agent, which a /proc
   * heuristic cannot tell apart from a daemon-spawned worker in the same cwd. The second line is the
   * process start-time, which binds the record to this exact incarnation (defeats pid-reuse aliasing).
   * Best-effort — a write failure never blocks start.
   */
  private writeAgentPidFile(pid: number | null): void {
    if (!pid || pid <= 0) return;
    try {
      const startTime = this.getProcessStartTime(pid);
      atomicWriteSync(this.agentPidFilePath(), `${pid}\n${startTime ?? ''}\n`);
    } catch (err) {
      this.log(`Could not write agent.pid: ${err}`);
    }
  }

  /** Remove the per-agent pidfile (on exit). Best-effort; absent file is fine. */
  private removeAgentPidFile(): void {
    try {
      const p = this.agentPidFilePath();
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // best-effort: a stale pidfile is caught by the reader's pid-alive + identity check
    }
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
   * Wire the agent's Telegram bot handle. Used by CodexAppServerPTY (issue #330) to
   * fire sendChatAction directly from the JSONL stream. Safe to call before
   * or after start() — the handle is re-applied on every PTY (re)spawn.
   */
  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this.telegramApi = api;
    this.telegramChatId = chatId;
    if (this.config.runtime === 'codex-app-server' && this.pty) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(api, chatId);
    }
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

  /**
   * Read the tail of this agent's stdout.log without loading the whole file.
   * Used by handleExit() to inspect recent output for known-crash signatures
   * (e.g. the image-poison API 400 pattern) so it can decide whether the
   * exit is a real crash or a recoverable upstream artifact.
   *
   * Returns an empty string if the log doesn't exist or can't be read.
   */
  private tailStdoutLog(maxBytes: number): string {
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    try {
      if (!existsSync(logPath)) return '';
      const stats = statSync(logPath);
      const start = Math.max(0, stats.size - maxBytes);
      const len = stats.size - start;
      // Synchronous read of the tail; small and bounded so the cost is fine
      // even in the exit handler.
      const fd = require('fs').openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(len);
        const read = require('fs').readSync(fd, buf, 0, len, start);
        return buf.toString('utf-8', 0, read);
      } finally {
        require('fs').closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /**
   * Match the API 400 image-poison signature in recent stdout.
   *
   * Two variants observed in Anthropic's Messages API responses:
   *   `API Error: 400 messages.N.content.M.image.source.base64.data: Image format image/<fmt> not supported`
   *   `API Error: 400 ... image.source.base64.data: ...`
   *
   * Matching the prefix `image.source.base64` is robust to wording changes
   * in Anthropic's error string; matching `image format image/<fmt>` is the
   * confirmed exact wording today and gives a second signal. Either is enough.
   */
  private detectImagePoisonCrash(recentOutput: string): boolean {
    if (!recentOutput) return false;
    if (recentOutput.includes('API Error: 400') && recentOutput.includes('image.source.base64')) {
      return true;
    }
    if (/image format image\/[a-z]+ not supported/i.test(recentOutput)) {
      return true;
    }
    return false;
  }

  /**
   * Write the `.force-fresh` marker that AgentProcess.shouldContinue() reads
   * on the next start() to force a fresh Claude Code session (no --continue).
   * Used by the image-poison auto-recovery in handleExit().
   */
  private armForceFresh(reason: string): void {
    try {
      const stateDir = join(this.env.ctxRoot, 'state', this.name);
      ensureDir(stateDir);
      const markerPath = join(stateDir, '.force-fresh');
      writeFileSync(markerPath, `${new Date().toISOString()} ${reason}\n`, 'utf-8');
    } catch (err) {
      this.log(`Failed to arm .force-fresh marker: ${err}`);
    }
  }

  private handleExit(exitCode: number): void {
    // Capture last 16KB of the agent's stdout BEFORE nulling pty.
    // Used by the image-poison auto-recovery check below — reads the log
    // file so this works even if the PTY buffer has already been GC'd.
    const recentOutput = this.tailStdoutLog(16384);

    this.pty = null;
    this.removeAgentPidFile();  // the agent process is gone -> no stale live-pid (process_alive monitoring)
    this.clearSessionTimer();
    this.clearSizeMonitor();

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

    // Image-poison auto-recovery (companion to PR #446's photo-injection fix).
    // Checked FIRST so a poisoned-context crash neither trips the crash-loop
    // window nor charges the daily counter — it is an upstream artifact, not
    // an agent malfunction.
    //
    // Claude Code crashes with `API Error: 400 messages.N.content.M.image.source.base64.data:
    // Image format image/<fmt> not supported` when conversation history holds a
    // base64-encoded image whose claimed media_type does not match the actual
    // bytes. The poison is permanent: every `--continue` restart reloads the
    // same conversation history and re-hits the same 400, so the agent
    // crash-loops until it exhausts max_crashes_per_day and the daemon halts.
    //
    // This block covers agents that ALREADY have a poisoned context: detect
    // the 400 signature in the recent stdout, write `.force-fresh` so the next
    // start discards the saved conversation, and respawn WITHOUT charging the
    // crash counter. (The photo-suppression source fix from #446 was superseded
    // by the Track-2 byte-sniff mime reconciliation; this recovery block is the
    // independent resilience half and stands on its own.)
    //
    // Exit is always code 0 in this failure mode (Claude Code surfaces the
    // 400 to the user then exits cleanly), so we gate on both exit code and
    // the error signature to avoid false positives that would skip a real
    // crash counter increment.
    if (exitCode === 0 && this.detectImagePoisonCrash(recentOutput)) {
      this.log('Image-poison crash detected (API 400, unsupported image format). Arming .force-fresh and restarting without counting against max_crashes_per_day.');
      this.armForceFresh('image-poison auto-recovery');
      this.appendCrashToRestartsLog(exitCode, 5000, 'IMAGE_POISON_RECOVERY');
      this.status = 'crashed';
      this.notifyStatusChange();
      setTimeout(() => {
        if (this.status === 'crashed') {
          this.start().catch(err => this.log(`Image-poison restart failed: ${err}`));
        }
      }, 5000);
      return;
    }

    // CrashLoopPauser (instar-inspired): if a sliding window is configured,
    // check whether the agent is crash-looping before falling through to
    // the legacy daily counter. The window is a more precise signal than
    // the per-day count: 3 crashes in 30 minutes is a crash loop even if
    // the daily budget of 10 is far from exhausted.
    if (this.crashWindowMs > 0) {
      const now = Date.now();
      this.crashTimestamps.push(now);
      // Prune timestamps outside the window.
      this.crashTimestamps = this.crashTimestamps.filter(
        (ts) => now - ts <= this.crashWindowMs,
      );
      if (this.crashTimestamps.length >= this.crashWindowMax) {
        this.log(
          `CRASH_LOOP: ${this.crashTimestamps.length} crashes in ${this.crashWindowMs / 1000}s window — auto-pausing`,
        );
        this.appendCrashToRestartsLog(exitCode, 0, 'CRASH_LOOP');
        this.status = 'halted';
        this.notifyStatusChange();
        return;
      }
    }

    // Legacy daily crash counter (fallback when no crash_window is configured,
    // or as a secondary gate when the window hasn't filled yet).
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
    // Hermes: session continuity is determined by whether the SQLite DB exists.
    // HERMES_HOME env var overrides the default ~/.hermes path.
    if (this.config.runtime === 'hermes') {
      const hermesHome = process.env['HERMES_HOME'];
      return hermesDbExists(hermesHome);
    }

    // Check for force-fresh marker (all runtimes honor it).
    const forceFreshPath = join(this.env.ctxRoot, 'state', this.name, '.force-fresh');
    if (existsSync(forceFreshPath)) {
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(forceFreshPath);
      } catch { /* ignore */ }
      return false;
    }

    // codex-app-server: session continuity is tracked by the adapter's own
    // codex-app-server-thread.json under ctxRoot/state/<agent>/. The Claude
    // JSONL check below is meaningless for the codex runtime, and a stale
    // Claude JSONL left over from a prior Claude-runtime tenure caused
    // continue-mode → thread/resume timeout → exit_code=0 crash loop
    // (testorg codex-agent crashed 3x with this signature on 2026-05-09,
    // 05-14, and 05-16 before backoff drained the pending resume RPC).
    if (this.config.runtime === 'codex-app-server') {
      const threadStatePath = join(
        this.env.ctxRoot,
        'state',
        this.name,
        'codex-app-server-thread.json',
      );
      return existsSync(threadStatePath);
    }

    // Default (Claude runtime): existing conversation = JSONL files present.
    const convDir = this.getConversationDir();
    if (!convDir) return false;

    try {
      const files = readdirSync(convDir);
      return files.some((f: string) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
  }

  /**
   * Resolve the Claude conversation directory for this agent, or null if the
   * launch dir is unknown. Claude stores transcripts under
   * ~/.claude/projects/<absolute-launch-dir-with-separators-as-dashes>
   * (leading separator becomes a leading dash). homedir() keeps this
   * cross-platform (HOME is unset on Windows). Shared by shouldContinue()
   * (existence check) and the size-aware rotation monitor (byte total).
   */
  private getConversationDir(): string | null {
    const launchDir = this.config.working_directory || this.env.agentDir;
    if (!launchDir) return null;
    return join(homedir(), '.claude', 'projects', launchDir.split(sep).join('-'));
  }

  /**
   * Size, in bytes, of the ACTIVE conversation transcript — the most-recently-
   * modified .jsonl in the conversation dir.
   *
   * Detection deliberately keys off the ACTIVE session, NOT the directory total.
   * The active session is the one currently being appended to, so by definition
   * it carries the newest mtime; a stale/abandoned session has an older mtime
   * and is not loaded by a --continue resume (which picks up the most-recent
   * conversation). Summing ALL .jsonl caused FALSE rotations: an agent with a
   * small healthy active session but a large stale one got force-fresh-restarted
   * unnecessarily, discarding its --continue context — the opposite of the
   * reliability this guard provides. Only the active session's growth can
   * actually exhaust context on resume, so that is what we measure.
   *
   * Newest-mtime is a robust proxy here because nothing in normal operation
   * touches an old session JSONL: archiveAndRefresh() MOVES stale transcripts
   * out (it does not touch them in place), so a stale file cannot spuriously
   * become "newest". Ties on mtime are broken by larger size so an equal-mtime
   * collision can never cause UNDER-rotation.
   *
   * Returns 0 when the dir is missing/unreadable or has no .jsonl file (treated
   * as "nothing to rotate"). NOTE: archiveAndRefresh() still archives ALL
   * .jsonl files — required so shouldContinue() returns false for a clean fresh
   * start; only the size DETECTION here is active-session-scoped.
   */
  private getActiveConversationBytes(): number {
    const convDir = this.getConversationDir();
    if (!convDir) return 0;
    try {
      let activeMtime = -Infinity;
      let activeSize = 0;
      for (const f of readdirSync(convDir)) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const st = statSync(join(convDir, f));
          if (!st.isFile()) continue;
          // Newest mtime wins (the actively-appended session). Break ties by
          // larger size so an equal-mtime collision can never under-rotate, and
          // so selection is deterministic regardless of readdir() order.
          if (st.mtimeMs > activeMtime || (st.mtimeMs === activeMtime && st.size > activeSize)) {
            activeMtime = st.mtimeMs;
            activeSize = st.size;
          }
        } catch { /* file vanished between readdir and stat — skip */ }
      }
      return activeSize;
    } catch {
      return 0;
    }
  }

  /**
   * Size-aware session rotation monitor. Polls the conversation transcript
   * size on an interval; when it exceeds config.max_session_mb, archives the
   * transcript and restarts FRESH (see archiveAndRefresh). Complements the
   * time-based session timer — the ~71h time cap is too coarse to catch
   * heavy-cron bloat before it stalls the agent (wally hit 91MB in 2 days).
   *
   * No-op (monitor never started) when max_session_mb is absent/<=0, or for
   * non-Claude runtimes (only Claude keeps growing JSONL transcripts).
   */
  private startSizeMonitor(): void {
    // Idempotent: clear any prior interval before arming a new one. start() can
    // be reached without a preceding stop() (crash-recovery / image-poison
    // restart paths both call start() directly), and without this the old
    // interval would leak and could fire a duplicate rotation.
    this.clearSizeMonitor();

    const maxMb = this.config.max_session_mb;
    if (!maxMb || maxMb <= 0) return;
    if (this.config.runtime === 'codex-app-server' || this.config.runtime === 'hermes') return;

    const POLL_MS = 10 * 60 * 1000; // 10 min — bloat accrues over hours, not seconds
    const thresholdBytes = maxMb * 1024 * 1024;

    // Arm log (observability): fires ONLY when the native guard actually arms — i.e. past the
    // absent-maxMb and codex/hermes early-returns above, for a claude agent at boot. Gives a greppable
    // proof the native size-guard is active, so a sidecar->native handoff is demonstrable (0 hits =
    // not-armed) instead of by-construction-only. Pairs with the rotate/disable logs below.
    this.log(`Size guard armed: max=${maxMb}MB, poll ${POLL_MS / 60000}m`);

    this.sizeTimer = setInterval(() => {
      // Only act on a live, settled session — never interrupt start/stop, a
      // daemon shutdown, or a rotation already in flight (the in-flight guard
      // also covers an external stop()/start() racing the interval callback).
      if (this.rotating || this.status !== 'running' || this.stopping || this.isDaemonShuttingDown()) return;

      // Re-read the threshold from config so runtime tuning takes effect without
      // a restart (mirrors the session timer). If the operator removes or zeroes
      // max_session_mb at runtime, disable the monitor entirely — re-enabling
      // requires a restart, symmetric with the monitor only arming at start().
      let currentThreshold = thresholdBytes;
      try {
        const configPath = join(this.env.agentDir, 'config.json');
        if (existsSync(configPath)) {
          const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
          const v = cfg.max_session_mb;
          if (typeof v === 'number' && v > 0) {
            currentThreshold = v * 1024 * 1024;
          } else {
            this.log('Size guard: max_session_mb removed/zeroed in config — disabling monitor');
            this.clearSizeMonitor();
            return;
          }
        }
      } catch { /* transient read error — keep the start-time threshold */ }

      const bytes = this.getActiveConversationBytes();
      if (bytes < currentThreshold) return;

      const mb = (bytes / 1024 / 1024).toFixed(1);
      this.log(`Size guard: active transcript ${mb}MB >= ${(currentThreshold / 1024 / 1024).toFixed(0)}MB cap — archiving + fresh restart`);
      this.archiveAndRefresh().catch(err => this.log(`Size-guard rotation failed: ${err}`));
    }, POLL_MS);

    // Node keeps the event loop alive for active timers; the daemon process is
    // long-lived so this is fine, but unref so the interval can't by itself
    // hold the process open during shutdown.
    this.sizeTimer.unref?.();
  }

  private clearSizeMonitor(): void {
    if (this.sizeTimer) {
      clearInterval(this.sizeTimer);
      this.sizeTimer = null;
    }
  }

  /**
   * Archive the bloated conversation transcript, then restart FRESH.
   *
   * Critical difference from sessionRefresh(): that does a --continue restart,
   * which would reload the very transcript we're rotating away from and stall
   * again. Here we stop the PTY first (releasing the open JSONL), MOVE the
   * transcripts out of the conversation dir so shouldContinue() returns false,
   * then start() — which now launches a fresh session that rebuilds context
   * from memory files. The archived JSONLs are preserved under
   * <convDir>/archived-<timestamp>/ for forensics, not deleted.
   *
   * Writes the .session-refresh marker so the SessionEnd crash-alert hook
   * classifies the PTY exit as a planned rollover, not a crash.
   */
  private async archiveAndRefresh(): Promise<void> {
    // In-flight guard: never overlap two rotations (defensive — the interval
    // also checks this.rotating, and stop() clears the timer).
    if (this.rotating) return;
    this.rotating = true;
    this.log('Size-guard rotation (archive + fresh restart)');
    try {
      // Write both rotation markers BEFORE anything can fail:
      //  - .session-refresh: the SessionEnd crash-alert hook reads this to
      //    classify the imminent PTY exit as a planned rollover, not a crash.
      //  - .force-fresh: shouldContinue() honors this (all runtimes) and starts
      //    FRESH regardless of any leftover transcript. This is the safety net
      //    for the archive step below: if the move partially fails (permission
      //    denied, disk pressure) and leaves a .jsonl behind, the next start()
      //    would otherwise --continue and reload the exact bloated transcript we
      //    are rotating away from — the failure mode that defeats the guard when
      //    it matters most. The marker guarantees fresh start either way.
      try {
        const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
        writeFileSync(join(paths.stateDir, '.session-refresh'), 'size-aware rotation\n', 'utf-8');
      } catch (err) {
        this.log(`Failed to write .session-refresh marker: ${err}`);
      }
      try {
        // Use the exact path shouldContinue() reads, to avoid any path-derivation drift.
        writeFileSync(join(this.env.ctxRoot, 'state', this.name, '.force-fresh'), 'size-aware rotation\n', 'utf-8');
      } catch (err) {
        // If we cannot guarantee fresh start, abort the rotation rather than risk
        // reloading the bloat on --continue. The agent keeps running; next tick retries.
        this.log(`Size-guard: failed to write .force-fresh marker (${err}) — aborting rotation to avoid --continue on bloated transcript`);
        return;
      }

      // Stop FIRST so the Claude process releases its open transcript handle
      // before we move the files (avoids writing into a moved/odd inode).
      await this.stop();

      const convDir = this.getConversationDir();
      if (convDir) {
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archiveDir = join(convDir, `archived-${stamp}`);
          ensureDir(archiveDir);
          let moved = 0;
          for (const f of readdirSync(convDir)) {
            if (!f.endsWith('.jsonl')) continue;
            try {
              renameSync(join(convDir, f), join(archiveDir, f));
              moved++;
            } catch (err) {
              this.log(`Size-guard: failed to archive ${f}: ${err}`);
            }
          }
          this.log(`Size-guard: archived ${moved} transcript file(s) to ${archiveDir}`);
        } catch (err) {
          // .force-fresh (written above) still guarantees a fresh start even if
          // the bloated transcript could not be moved aside — it just won't be
          // archived for forensics. Log so the operator can reclaim disk manually.
          this.log(`Size-guard: archive step failed (${err}) — .force-fresh still guarantees a fresh start`);
        }
      }

      // Re-check shutdown AFTER the awaited stop(): the daemon may have begun
      // its shutdown sequence while we were stopping. Don't resurrect the agent
      // into a shutting-down daemon (the interval's pre-check is now stale).
      if (this.isDaemonShuttingDown()) {
        this.log('Size-guard: daemon shutting down during rotation — leaving agent stopped, skipping fresh start');
        return;
      }

      await this.start();
      this.log('Size-guard rotation complete (fresh session)');
    } finally {
      this.rotating = false;
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
    const handoffBlock = this.consumeHandoffBlock();
    const isHandoffRestart = handoffBlock.length > 0;
    this.lastSpawnWasHandoff = isHandoffRestart;
    // HANDOFF UX: the pickup message MUST be the first action after reading the handoff doc —
    // before cron restoration, before heartbeat, before anything else. Placing this instruction
    // immediately after the handoffBlock in the prompt ensures it is not buried.
    const handoffUxOverride = isHandoffRestart
      ? ' HANDOFF UX: This is a context handoff restart — your memory is intact via the handoff doc. CRITICAL: After reading the handoff document, your VERY FIRST tool call MUST be a Bash call running: cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID \'back — [what you were just working on]\' — replace the brackets with one brief plain-English sentence about your current state. Do this BEFORE running heartbeat, BEFORE any other tool call. No cron IDs, no status report, no cold-boot phrasing. Do NOT send "Booting up... one moment" (skip AGENTS.md step 1 entirely).'
      : '';
    const onlineMessage = isHandoffRestart
      ? ''
      : ' Send a Telegram message to the user saying you are back online.';
    return `You are starting a new session. Current UTC time: ${nowUtc}. Read AGENTS.md and all bootstrap files listed there. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.${reminderBlock}${deliverablesBlock}${handoffBlock}${handoffUxOverride}${onlineMessage}${onboardingAppend}`;
  }

  private buildContinuePrompt(): string {
    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    // Session refresh (--continue) is never a handoff restart.
    this.lastSpawnWasHandoff = false;
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.${reminderBlock}${deliverablesBlock} Check inbox. Resume normal operations. After checking inbox, send a Telegram message to the user saying you are back online.`;
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
   */
  private consumeHandoffBlock(): string {
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.handoff-doc-path');
    if (!existsSync(markerPath)) return '';
    try {
      const docPath = readFileSync(markerPath, 'utf-8').trim();
      unlinkSync(markerPath);
      if (!docPath || !existsSync(docPath)) return '';
      return ` CONTEXT HANDOFF: Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
    } catch {
      return '';
    }
  }

  /**
   * Issue #392: send the back-online Telegram notification directly from the
   * daemon when the codex-app-server runtime spawns. The boot prompt's inline
   * "Send a Telegram message..." instruction reaches the codex thread but is
   * not executed reliably as a tool call, leaving James without the standard
   * post-restart notification claude-code peers send.
   *
   * Skipped when:
   *  - runtime is anything other than codex-app-server (claude-code/hermes
   *    already emit this via the prompt),
   *  - the most recent prompt was built for a handoff restart (the agent
   *    sends its own contextual "back — ..." reply in that case),
   *  - no Telegram handle has been wired (no chat_id configured).
   */
  private maybeSendCodexBootNotification(): void {
    if (this.config.runtime !== 'codex-app-server') return;
    if (this.lastSpawnWasHandoff) return;
    if (!this.telegramApi || !this.telegramChatId) return;
    this.telegramApi
      .sendMessage(this.telegramChatId, `Agent ${this.name} is back online`)
      .catch(() => { /* non-fatal: notification is observability only */ });
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
    kind: 'CRASH' | 'HALTED' | 'CRASH_LOOP' | 'IMAGE_POISON_RECOVERY',
  ): void {
    try {
      const logDir = join(this.env.ctxRoot, 'logs', this.name);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const details =
        kind === 'HALTED'
          ? `exit_code=${exitCode} crash_count=${this.crashCount} max_crashes=${this.maxCrashesPerDay}`
          : kind === 'IMAGE_POISON_RECOVERY'
            ? `exit_code=${exitCode} backoff_s=${backoffMs / 1000} (not counted toward max_crashes)`
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
