import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { AgentPTY } from './agent-pty.js';
import { resolveAgentCwd } from '../utils/paths.js';

// Hermes bootstrap signal: the prompt character that appears when Hermes is
// ready for input. The full prompt is "⚔ ❯ " but we check for "❯" as a
// substring since terminal themes may vary. Braille spinner frames and other
// output never contain "❯" so this is a clean idle signal.
const HERMES_BOOTSTRAP_PATTERN = '❯';

// Startup prompt file written to the agent dir and read by Hermes at boot.
// Using a file avoids bracketed paste (ESC[200~) which is buggy in Hermes
// (NousResearch/hermes-agent issue #7316 — leaked markers corrupt input).
const STARTUP_PROMPT_FILE = '.cortextos-startup.md';

// Idle watcher: polls for ❯ and writes last_idle.flag so the daemon's
// isIdle() check works for Hermes agents (which have no Claude Code Stop hook).
const IDLE_POLL_INTERVAL_MS = 5_000;   // check every 5 s
const IDLE_WRITE_DEBOUNCE_MS = 30_000; // write at most every 30 s

/**
 * PTY wrapper for Hermes agents (NousResearch/hermes-agent, Python REPL).
 *
 * Key differences from Claude Code (AgentPTY):
 * - Binary: `hermes` (not `claude`)
 * - Session continuity: `--continue` flag when ~/.hermes/state.db exists
 * - No positional prompt arg: startup prompt written to a temp file and
 *   injected as a short read command after the `❯` prompt appears
 * - Bootstrap signal: `❯` in output (not Claude Code's "permissions" status bar)
 * - No trust-folder prompt: Hermes doesn't ask for folder trust on first run
 * - Exit: Ctrl+D (`\x04`), not `/exit\r\n`
 * - No `--dangerously-skip-permissions` or `--model` flags
 */
export class HermesPTY extends AgentPTY {
  private startupPrompt: string = '';
  private agentDir: string;
  private stateDir: string;
  private lastIdleWrittenAt = 0;
  private idleWatcherTimer: ReturnType<typeof setInterval> | null = null;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    super(env, config, logPath, HERMES_BOOTSTRAP_PATTERN);
    // Store agentDir here since AgentPTY.env is private
    this.agentDir = resolveAgentCwd(
      env.agentDir,
      config.working_directory,
      (msg) => console.warn(`[hermes-pty:${env.agentName}] ${msg}`),
    );
    // Compute state dir for last_idle.flag writes (mirrors hook-idle-flag.ts logic)
    const instanceId = env.instanceId || 'default';
    this.stateDir = join(homedir(), '.cortextos', instanceId, 'state', env.agentName);
  }

  /**
   * Returns the hermes binary name.
   * Hermes is a Python package installed via pip — no .cmd wrapper on Windows.
   */
  protected getBinaryName(): string {
    return 'hermes';
  }

  /**
   * Build Hermes CLI args.
   *
   * Hermes session continuity: if ~/.hermes/state.db exists, pass --continue
   * to resume the last session. The SQLite DB persists conversation history
   * across daemon restarts (unlike Claude Code's .jsonl files which live in
   * the working dir).
   *
   * No positional prompt: the startup prompt is injected post-boot via a
   * temp file to avoid bracketed paste issues (see class-level comment).
   */
  protected buildClaudeArgs(mode: 'fresh' | 'continue', _prompt: string): string[] {
    // mode='continue' means shouldContinue() returned true — Hermes DB exists.
    // We pass --continue so Hermes resumes the last session.
    if (mode === 'continue') {
      return ['--continue'];
    }
    return [];
  }

  /**
   * Override spawn to write the startup prompt to a temp file and inject it
   * after Hermes boots to the `❯` prompt.
   *
   * We cannot pass the startup prompt as a CLI arg (Hermes has no such flag)
   * and bracketed paste is buggy in Hermes (issue #7316). Instead:
   *   1. Write prompt to .cortextos-startup.md in the agent dir
   *   2. Spawn Hermes normally
   *   3. After `❯` appears (isBootstrapped), inject a single-line read command
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    this.startupPrompt = prompt;
    // Write startup prompt to temp file BEFORE spawn so Hermes can read it
    this.writeStartupFile(prompt);
    // Spawn Hermes (base class handles PTY setup, env injection, exit handler)
    await super.spawn(mode, prompt);
    // After `❯` appears, inject the read command — base class spawn() returns
    // as soon as the PTY is set up, not when Hermes is ready. We schedule
    // the injection asynchronously so spawn() can return quickly.
    this.scheduleStartupInjection();
    // Start background idle watcher to keep last_idle.flag current.
    // Hermes has no Claude Code Stop hook, so we poll for ❯ instead.
    this.startIdleWatcher();
  }

  /**
   * Write the startup prompt to a temp file in the agent directory.
   * The file is gitignored (.cortextos-startup.md is in .gitignore by convention).
   */
  private writeStartupFile(prompt: string): void {
    try {
      const filePath = join(this.agentDir, STARTUP_PROMPT_FILE);
      writeFileSync(filePath, prompt, 'utf-8');
    } catch (err) {
      // Non-fatal: if the write fails, the injection command will fail gracefully
      console.error(`[hermes-pty] Failed to write startup file: ${err}`);
    }
  }

  /**
   * Wait for Hermes's `❯` prompt, then inject the startup instruction.
   * Runs in the background — does not block spawn().
   */
  private scheduleStartupInjection(): void {
    this.waitForPromptThenInject().catch(err => {
      console.error(`[hermes-pty] Startup injection failed (non-fatal): ${err}`);
    });
  }

  /**
   * Background idle watcher: writes last_idle.flag whenever Hermes is at the
   * ❯ prompt, with a 30 s debounce to avoid thrashing.
   *
   * Without this, isIdle() in agent-process.ts always returns false after the
   * first cron injection (last_idle.flag predates lastInjectedAt), causing the
   * cron-scheduler to defer every subsequent cron by MAX_DEFER_MS (15 min) and
   * making the effective heartbeat interval ~45 min instead of the configured
   * 30 min.
   *
   * Claude Code agents handle this via the Stop hook (hook-idle-flag.ts).
   * Hermes agents do not run Claude Code, so we replicate the same write here.
   */
  private startIdleWatcher(): void {
    if (this.idleWatcherTimer !== null) return; // already running
    const flagPath = join(this.stateDir, 'last_idle.flag');
    this.idleWatcherTimer = setInterval(() => {
      if (!this.isAlive()) {
        clearInterval(this.idleWatcherTimer!);
        this.idleWatcherTimer = null;
        return;
      }
      if (!this.getOutputBuffer().isBootstrapped()) return; // ❯ not visible
      const now = Date.now();
      if (now - this.lastIdleWrittenAt < IDLE_WRITE_DEBOUNCE_MS) return; // debounce
      try {
        mkdirSync(this.stateDir, { recursive: true });
        writeFileSync(flagPath, String(Math.floor(now / 1000)), 'utf-8');
        this.lastIdleWrittenAt = now;
      } catch { /* non-fatal — daemon still falls back to force-inject after MAX_DEFER_MS */ }
    }, IDLE_POLL_INTERVAL_MS);
  }

  private async waitForPromptThenInject(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.getOutputBuffer().isBootstrapped()) {
        // `❯` appeared — Hermes is ready. Inject the read command.
        this.write(`Read ${STARTUP_PROMPT_FILE} and follow the instructions there.\r`);
        return;
      }
      await sleep(500);
    }
    // Timeout: Hermes took too long to boot. Inject anyway and let it handle.
    this.write(`Read ${STARTUP_PROMPT_FILE} and follow the instructions there.\r`);
  }

}

/**
 * Check whether a Hermes session database exists.
 * Used by AgentProcess.shouldContinue() to decide whether to pass --continue.
 * Respects HERMES_HOME environment variable (set in agent .env if non-standard).
 */
export function hermesDbExists(hermesHome?: string): boolean {
  const base = hermesHome || join(homedir(), '.hermes');
  return existsSync(join(base, 'state.db'));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
