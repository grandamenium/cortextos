import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
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
  private static readonly MAX_WORKER_LIFETIME_MS = 10 * 60_000;

  readonly name: string;
  readonly dir: string;
  readonly parent: string | undefined;

  private pty: AgentPTY | null = null;
  private status: WorkerStatusValue = 'starting';
  private spawnedAt: string;
  private exitCode: number | undefined;
  private onDoneCallback: ((name: string, exitCode: number) => void) | null = null;
  private log: (msg: string) => void;
  private maxLifetimeTimer: ReturnType<typeof setTimeout> | null = null;

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
      // Write a marker so the crash-alert hook can identify this as a worker
      // session and suppress Telegram/bus alerts on normal exit. Workers are
      // designed to have no Telegram integration (see class doc above).
      writeFileSync(join(env.ctxRoot, 'state', this.name, '.is-worker'), this.name);
    } catch { /* ignore */ }

    const logPath = join(env.ctxRoot, 'logs', this.name, 'stdout.log');
    this.pty = new AgentPTY(env, config, logPath);

    this.pty.onExit((code) => {
      this.clearMaxLifetimeTimer();
      this.exitCode = code;
      this.status = code === 0 ? 'completed' : 'failed';
      this.log(`Exited with code ${code} → ${this.status}`);
      if (this.onDoneCallback) {
        this.onDoneCallback(this.name, code);
      }
      this.pty = null;
    });

    await this.pty.spawn('fresh', prompt);
    this.status = 'running';
    this.log(`Running (pid: ${this.pty.getPid()}, dir: ${this.dir})`);
    this.maxLifetimeTimer = setTimeout(() => {
      if (!this.isFinished()) {
        this.log(`Max lifetime (${WorkerProcess.MAX_WORKER_LIFETIME_MS}ms) exceeded — reaping`);
        void this.terminate();
      }
    }, WorkerProcess.MAX_WORKER_LIFETIME_MS);
    this.maxLifetimeTimer.unref?.();
  }

  /**
   * Terminate the worker session.
   */
  async terminate(): Promise<void> {
    this.clearMaxLifetimeTimer();
    if (!this.pty) return;
    this.log('Terminating...');
    try {
      this.pty.write('\x03'); // Ctrl-C
      await sleep(500);
      this.pty.kill();
    } catch { /* ignore */ }
    this.status = 'completed';
    this.pty = null;
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

  private clearMaxLifetimeTimer(): void {
    if (this.maxLifetimeTimer) {
      clearTimeout(this.maxLifetimeTimer);
      this.maxLifetimeTimer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
