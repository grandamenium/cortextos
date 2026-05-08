import { join } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { AgentPTY } from './agent-pty.js';
import { OutputBuffer } from './output-buffer.js';
import type { TelegramAPI } from '../telegram/api.js';

// node-pty types (same as agent-pty.ts)
interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

/**
 * Codex PTY adapter for cortextOS daemon.
 *
 * Codex uses a turn-based exec model — each conversation turn spawns a new
 * process (`codex exec` or `codex exec resume --last`). There is no persistent
 * interactive PTY between turns. This class wraps that model to satisfy the
 * AgentPTY interface expected by agent-process.ts and fast-checker.ts.
 *
 * Key design decisions:
 * - _alive stays true until explicit kill() — daemon never sees "crashed" between turns
 * - write() accumulates bracketed-paste input until Enter, then queues an exec
 * - drainQueue() serializes: one exec process at a time, no concurrent spawns
 * - --json flag gives structured JSONL output: bootstrap on thread.started, idle on turn.completed
 * - last_idle.flag written on turn.completed (not process exit) for fast-checker typing indicator
 */
export class CodexPTY {
  private _alive = false;          // true after first spawn, false only after kill()
  private _executing = false;      // true while a codex exec process is running
  private _writeBuffer = '';       // accumulates write() calls between Enter signals
  private _execQueue: string[] = []; // pending messages awaiting exec
  private _spawnFn: SpawnFn | null = null;
  private _currentPty: IPty | null = null;
  private _onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private _outputBuffer: OutputBuffer;
  private _env: CtxEnv;
  private _config: AgentConfig;
  private _stateDir: string;
  private _cwd: string;
  // Issue #330: direct typing-indicator firing from the JSONL stream.
  // Without this CodexPTY relied on fast-checker's last_idle.flag mechanism,
  // which races on short turns: idle flag lands before the typing pollCycle
  // wakes, so the user never sees "typing..." for fast codex turns.
  private _telegramApi: TelegramAPI | null = null;
  private _chatId: string | null = null;
  private _typingLastSent = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    this._env = env;
    this._config = config;
    this._cwd = config.working_directory || env.agentDir || process.cwd();
    this._stateDir = join(env.ctxRoot, 'state', env.agentName);

    // Bootstrap pattern: detect "thread.started" in JSONL output
    // Codex outputs JSONL with --json flag; we store raw for parseability
    this._outputBuffer = new OutputBuffer(1000, logPath, '"type":"thread.started"');
  }

  /**
   * Spawn the first Codex exec turn.
   * mode='fresh': new session; mode='continue': resume prior session for this cwd.
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this._alive) {
      throw new Error('CodexPTY already spawned. Kill first.');
    }

    if (!this._spawnFn) {
      const nodePty = require('node-pty');
      this._spawnFn = nodePty.spawn;
    }

    this._alive = true;

    const args = mode === 'continue' && this.hasExistingSession()
      ? this.buildResumeArgs(prompt)
      : this.buildFreshArgs(prompt);

    await this.runExec(args);
  }

  /**
   * Write data to the PTY (bracketed paste input from fast-checker / inject.ts).
   * Accumulates chunks until Enter ('\r'), then queues an exec resume turn.
   * Bracketed paste markers (ESC[200~ / ESC[201~) are stripped.
   */
  write(data: string): void {
    if (!this._alive) return;

    if (data === '\r') {
      // Enter received — flush accumulated buffer as a new exec turn
      const content = this._writeBuffer
        .replace(/\x1b\[200~/g, '') // PASTE_START
        .replace(/\x1b\[201~/g, '') // PASTE_END
        .trim();
      this._writeBuffer = '';
      if (content) {
        this.queueExec(content);
      }
    } else {
      this._writeBuffer += data;
    }
  }

  /**
   * Kill the current exec process and stop the queue.
   * Sets _alive=false so the daemon knows the session is terminated.
   */
  kill(): void {
    this._alive = false;
    this._execQueue = [];
    if (this._currentPty) {
      try {
        this._currentPty.kill();
      } catch { /* ignore */ }
      this._currentPty = null;
    }
    this._onExitHandler?.(0, undefined);
    this._onExitHandler = null;
  }

  /**
   * Whether the session is alive (not killed).
   * Stays true between exec turns — the daemon uses this for crash detection.
   */
  isAlive(): boolean {
    return this._alive;
  }

  /**
   * PID of the currently running exec process, or null between turns.
   */
  getPid(): number | null {
    return this._currentPty?.pid ?? null;
  }

  /**
   * Register an exit handler. Called only when kill() is invoked explicitly.
   */
  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this._onExitHandler = handler;
  }

  /**
   * Output buffer containing raw JSONL output from the most recent exec turn.
   * isBootstrapped() returns true when "thread.started" appears.
   */
  getOutputBuffer(): OutputBuffer {
    return this._outputBuffer;
  }

  /**
   * Provide the Telegram API handle + chatId used to fire typing indicators
   * directly from the JSONL stream (issue #330). Called by AgentProcess when
   * the daemon has loaded the agent's bot credentials. Without this, typing
   * still falls back to fast-checker's last_idle.flag path.
   */
  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this._telegramApi = api;
    this._chatId = chatId;
  }

  /**
   * Queue a message for exec. Starts draining immediately if not already running.
   */
  private queueExec(message: string): void {
    this._execQueue.push(message);
    if (!this._executing) {
      this.drainQueue().catch(err => {
        console.warn(`[codex-pty] drainQueue error: ${err}`);
      });
    }
  }

  /**
   * Drain the exec queue serially: one codex exec resume at a time.
   * Writes last_idle.flag after each turn.completed JSONL event.
   */
  private async drainQueue(): Promise<void> {
    while (this._alive && this._execQueue.length > 0) {
      const msg = this._execQueue.shift()!;
      this._executing = true;
      try {
        await this.runExec(this.buildResumeArgs(msg));
      } catch (err) {
        console.warn(`[codex-pty] exec failed: ${err}`);
      } finally {
        this._executing = false;
      }
    }
  }

  /**
   * Spawn a single codex exec process, capture output, wait for exit.
   * Parses JSONL output for turn.completed → writes last_idle.flag.
   */
  private runExec(args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this._spawnFn) {
        reject(new Error('spawn function not loaded'));
        return;
      }

      const ptyEnv = this.buildEnv();

      const pty = this._spawnFn('codex', args, {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: this._cwd,
        env: ptyEnv,
      });

      this._currentPty = pty;

      pty.onData((data: string) => {
        this._outputBuffer.push(data);
        // Detect turn.completed in JSONL output → write last_idle.flag
        if (data.includes('"turn.completed"') || data.includes('"type":"turn.completed"')) {
          this.writeIdleFlag();
        } else if (data.includes('"type":"')) {
          // Issue #330: any other JSONL event during the turn → fire typing
          this.maybeFireTyping();
        }
      });

      pty.onExit(({ exitCode }) => {
        if (this._currentPty === pty) {
          this._currentPty = null;
        }
        // Write idle flag on process exit as fallback (catches turn.completed race)
        this.writeIdleFlag();
        resolve();
      });
    });
  }

  /**
   * Write last_idle.flag for fast-checker typing indicator.
   * fast-checker.isAgentActive() checks: lastMessageInjectedAt > idleTs
   * Writing this flag signals that the agent has finished its turn.
   */
  private writeIdleFlag(): void {
    try {
      const flagPath = join(this._stateDir, 'last_idle.flag');
      writeFileSync(flagPath, Math.floor(Date.now() / 1000).toString(), 'utf-8');
    } catch { /* non-fatal */ }
  }

  /**
   * Fire a Telegram "typing..." indicator, rate-limited to one call per 4s
   * (matches fast-checker.sendTyping cadence; Telegram clears the indicator
   * automatically after ~5s, so 4s spacing keeps it on continuously).
   * No-op when the Telegram handle hasn't been wired in.
   */
  private maybeFireTyping(): void {
    if (!this._telegramApi || !this._chatId) return;
    const now = Date.now();
    if (now - this._typingLastSent < 4000) return;
    this._typingLastSent = now;
    this._telegramApi.sendChatAction(this._chatId, 'typing').catch(() => { /* non-fatal */ });
  }

  /**
   * Default Codex feature flags enabled for every cortextOS-managed codex agent.
   * Currently: `goals` (native goal tracking surface). Per-agent overrides can
   * be added via the optional `codex_features` array on AgentConfig in future.
   */
  private getEnabledFeatures(): string[] {
    const fromConfig = (this._config as AgentConfig & { codex_features?: string[] }).codex_features;
    return Array.isArray(fromConfig) && fromConfig.length > 0 ? fromConfig : ['goals'];
  }

  private featureFlagArgs(): string[] {
    const args: string[] = [];
    for (const f of this.getEnabledFeatures()) {
      args.push('--enable', f);
    }
    return args;
  }

  /**
   * Build args for a fresh exec (new session).
   * --skip-git-repo-check: skip trust check for daemon-managed directories
   * --sandbox workspace-write: sets approval=never + safe sandbox level
   * --json: structured JSONL output for reliable event detection
   * --enable <feature>: codex feature flags defaulted on for cortextOS agents
   */
  private buildFreshArgs(prompt: string): string[] {
    return [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      '--json',
      ...this.featureFlagArgs(),
      prompt,
    ];
  }

  /**
   * Build args for resuming the most recent session in this cwd.
   * --last: pick most recent thread for current cwd (cwd-filtered by default)
   * --dangerously-bypass-approvals-and-sandbox: required for exec resume (--sandbox not available)
   * --enable <feature>: codex feature flags defaulted on for cortextOS agents
   */
  private buildResumeArgs(prompt: string): string[] {
    return [
      'exec',
      'resume',
      '--last',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      ...this.featureFlagArgs(),
      prompt,
    ];
  }

  /**
   * Check if a prior Codex session exists for this cwd.
   * Queries state_5.sqlite threads table (cwd-filtered, non-archived).
   */
  private hasExistingSession(): boolean {
    const dbPath = join(homedir(), '.codex', 'state_5.sqlite');
    if (!existsSync(dbPath)) return false;
    try {
      // Use synchronous sqlite3 via child_process to avoid adding a dependency
      const { execFileSync } = require('child_process');
      const query = `SELECT id FROM threads WHERE cwd = '${this._cwd.replace(/'/g, "''")}' AND archived = 0 ORDER BY updated_at DESC LIMIT 1;`;
      const result = execFileSync('sqlite3', [dbPath, query], { encoding: 'utf-8', timeout: 3000 }).trim();
      return result.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Build environment variables for the Codex exec process.
   * Matches AgentPTY.getBaseEnv() + CTX_* variables pattern.
   */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    // Base environment
    const keepVars = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR'];
    for (const key of keepVars) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    // CTX_* variables
    env['CTX_INSTANCE_ID'] = this._env.instanceId;
    env['CTX_ROOT'] = this._env.ctxRoot;
    env['CTX_FRAMEWORK_ROOT'] = this._env.frameworkRoot;
    env['CTX_AGENT_NAME'] = this._env.agentName;
    env['CTX_ORG'] = this._env.org;
    env['CTX_AGENT_DIR'] = this._env.agentDir;
    env['CTX_PROJECT_ROOT'] = this._env.projectRoot;

    // Load org secrets.env
    if (this._env.org && this._env.projectRoot) {
      this.loadEnvFile(join(this._env.projectRoot, 'orgs', this._env.org, 'secrets.env'), env);
    }

    // Load agent .env (overrides org secrets)
    this.loadEnvFile(join(this._env.agentDir, '.env'), env);

    // Convenience aliases
    if (env['CHAT_ID']) env['CTX_TELEGRAM_CHAT_ID'] = env['CHAT_ID'];
    if (this._config.timezone) {
      env['CTX_TIMEZONE'] = this._config.timezone;
      env['TZ'] = this._config.timezone;
    }

    return env;
  }

  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    try {
      const { readFileSync } = require('fs');
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    } catch { /* ignore */ }
  }
}
