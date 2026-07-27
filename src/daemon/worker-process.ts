import { join } from 'path';
import { mkdirSync } from 'fs';
import type { CtxEnv, WorkerStatus, WorkerStatusValue } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { injectMessage } from '../pty/inject.js';

/**
 * WorkerProcess — ephemeral Claude Code session for parallelized tasks.
 *
 * Differences from AgentProcess:
 * - No crash recovery (exit = done, success or failure)
 * - No session timer (workers run until task is complete)
 * - No Telegram integration
 * - No fast-checker or inbox polling
 * - Working directory is the project dir, not the agent dir
 * - Status is exposed for IPC list-workers queries
 */
export class WorkerProcess {
  readonly name: string;
  readonly dir: string;
  readonly parent: string | undefined;

  private pty: AgentPTY | null = null;
  private status: WorkerStatusValue = 'starting';
  private spawnedAt: string;
  private exitCode: number | undefined;
  private onDoneCallback: ((name: string, exitCode: number) => void) | null = null;
  private log: (msg: string) => void;
  private maxRuntimeTimer: NodeJS.Timeout | null = null;
  private finished = false;

  constructor(
    name: string,
    dir: string,
    parent: string | undefined,
    log?: (msg: string) => void,
  ) {
    this.name = name;
    this.dir = dir;
    this.parent = parent;
    this.spawnedAt = new Date().toISOString();
    this.log = log || ((msg) => console.log(`[worker:${name}] ${msg}`));
  }

  /**
   * Spawn the worker Claude Code session with the given task prompt.
   */
  async spawn(env: CtxEnv, prompt: string, config: { model?: string } = {}): Promise<void> {
    // Ensure bus dirs exist so the worker can use cortextos bus commands
    try {
      mkdirSync(join(env.ctxRoot, 'inbox', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'state', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'logs', this.name), { recursive: true });
    } catch { /* ignore */ }

    const logPath = join(env.ctxRoot, 'logs', this.name, 'stdout.log');
    this.pty = new AgentPTY(env, config, logPath);

    this.status = 'running';
    this.pty.onExit((code) => this.finish(code));

    const maxSeconds = parseMaxRuntimeSeconds(process.env.CTX_WORKER_MAX_SECONDS);
    this.maxRuntimeTimer = setTimeout(() => {
      if (this.finished) return;
      this.log(`Hard timeout after ${maxSeconds}s; force-terminating PTY`);
      const pty = this.pty;
      this.finish(124);
      try { pty?.kill(); } catch { /* already exited */ }
    }, maxSeconds * 1000);
    this.maxRuntimeTimer.unref();

    // LOCAL PATCH (Ops Command Part B, 2026-07-24) - re-apply on upstream sync.
    // Native --print is a reliable completion boundary; unlike TUI output
    // detection it preserves CLI success/failure exit codes and stdout logging.
    try {
      await this.pty.spawnOneShot(prompt);
      this.log(`Running one-shot (pid: ${this.pty?.getPid()}, dir: ${this.dir}, max: ${maxSeconds}s)`);
    } catch (err) {
      this.finish(1);
      throw err;
    }
  }

  /**
   * Terminate the worker session.
   */
  async terminate(): Promise<void> {
    if (!this.pty) return;
    this.log('Terminating...');
    const pty = this.pty;
    try {
      pty.write('\x03'); // Ctrl-C
      await sleep(500);
      pty.kill();
    } catch { /* ignore */ }
    this.finish(143);
  }

  /**
   * Inject text into the worker's PTY (equivalent to tmux send-keys).
   * Use to nudge a stuck worker without restarting it.
   */
  inject(text: string): boolean {
    if (!this.pty || this.status !== 'running') return false;
    injectMessage((data) => this.pty?.write(data), text);
    return true;
  }

  /**
   * Get current worker status snapshot.
   */
  getStatus(): WorkerStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() ?? undefined,
      dir: this.dir,
      parent: this.parent,
      spawnedAt: this.spawnedAt,
      exitCode: this.exitCode,
    };
  }

  isFinished(): boolean {
    return this.status === 'completed' || this.status === 'failed';
  }

  /**
   * Register a callback that fires when the worker exits.
   */
  onDone(cb: (name: string, exitCode: number) => void): void {
    this.onDoneCallback = cb;
  }

  private finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    if (this.maxRuntimeTimer) {
      clearTimeout(this.maxRuntimeTimer);
      this.maxRuntimeTimer = null;
    }
    this.exitCode = code;
    this.status = code === 0 ? 'completed' : 'failed';
    this.pty = null;
    this.log(`Exited with code ${code} → ${this.status}`);
    this.onDoneCallback?.(this.name, code);
  }
}

export function parseMaxRuntimeSeconds(raw: string | undefined): number {
  if (!raw) return 1800;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 1800;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
