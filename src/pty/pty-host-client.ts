/**
 * pty-host-client — daemon-side proxy that forks pty-host-entry.ts.
 *
 * Presents the same IPty interface that AgentPTY and CodexAppServerPTY
 * expect, but delegates ALL node-pty allocation to a forked child process
 * so the daemon itself holds zero /dev/ptmx file descriptors.
 *
 * The child exits when the pty exits, which causes the kernel to reclaim
 * the /dev/ptmx devices that would otherwise accumulate and exhaust
 * kern.tty.ptmx_max=511 (the macOS crash-loop trigger).
 */

import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import type { PtyClientMsg, PtyHostMsg, PtySpawnMsg } from './pty-ipc.js';

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

interface PtyDisposable {
  dispose(): void;
}

/**
 * IPty — the interface node-pty's ITypePty exposes.
 * Reproduced here so we can implement it without importing node-pty.
 */
export interface IPty {
  readonly pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): PtyDisposable;
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): PtyDisposable;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
  destroy?(): void;
}

/**
 * Resolve the path to the compiled host entry point.
 * tsup emits it to dist/pty/pty-host-entry.js, but pty-host-client is BUNDLED
 * into dist/daemon.js and dist/cli.js — so at runtime __dirname is dist/, not
 * dist/pty/. Try both layouts and pick the one that exists, so the resolution
 * is correct whether this module runs bundled (dist/) or standalone (dist/pty/).
 */
function resolveHostEntry(): string {
  const candidates = [
    join(__dirname, 'pty', 'pty-host-entry.js'), // bundled: __dirname = dist/
    join(__dirname, 'pty-host-entry.js'),        // standalone: __dirname = dist/pty/
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to the bundled layout so the error message names a real expected path.
  return candidates[0];
}

class PtyHostProxy implements IPty {
  private _child: ChildProcess;
  private _pid = 0;
  private _dataListeners: Array<(data: string) => void> = [];
  private _exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  private _ready: Promise<void>;
  private _resolveReady!: () => void;
  private _rejectReady!: (err: Error) => void;
  private _exited = false;

  constructor(child: ChildProcess) {
    this._child = child;
    this._ready = new Promise<void>((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });

    child.on('message', (raw: unknown) => this._handleHostMsg(raw));
    child.on('exit', (code, sig) => {
      if (!this._exited) {
        this._exited = true;
        const exitCode = code ?? 1;
        const signal = sig ? (typeof sig === 'string' ? parseInt(sig, 10) : sig as number) : undefined;
        for (const cb of this._exitListeners) {
          try { cb({ exitCode, signal }); } catch { /* listener errors must not crash host */ }
        }
      }
    });
    child.on('error', (err) => {
      this._rejectReady(err);
    });
  }

  private _handleHostMsg(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as PtyHostMsg;

    switch (msg.type) {
      case 'pty-ready':
        this._pid = msg.pid;
        this._resolveReady();
        break;

      case 'pty-data':
        for (const cb of this._dataListeners) {
          try { cb(msg.data); } catch { /* listener errors must not crash host */ }
        }
        break;

      case 'pty-exit':
        if (!this._exited) {
          this._exited = true;
          const { exitCode, signal } = msg;
          for (const cb of this._exitListeners) {
            try { cb({ exitCode, signal }); } catch { /* listener errors must not crash host */ }
          }
        }
        break;

      case 'pty-error':
        this._rejectReady(new Error(msg.message));
        break;

      default:
        break;
    }
  }

  get pid(): number {
    return this._pid;
  }

  write(data: string): void {
    this._send({ type: 'pty-write', data });
  }

  onData(callback: (data: string) => void): PtyDisposable {
    this._dataListeners.push(callback);
    return {
      dispose: () => {
        const idx = this._dataListeners.indexOf(callback);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      },
    };
  }

  onExit(callback: (e: { exitCode: number; signal?: number }) => void): PtyDisposable {
    this._exitListeners.push(callback);
    return {
      dispose: () => {
        const idx = this._exitListeners.indexOf(callback);
        if (idx !== -1) this._exitListeners.splice(idx, 1);
      },
    };
  }

  kill(signal?: string): void {
    this._send({ type: 'pty-kill', signal });
  }

  resize(cols: number, rows: number): void {
    this._send({ type: 'pty-resize', cols, rows });
  }

  destroy(): void {
    // Killing the child process releases all its file descriptors
    try { this._child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /** Wait for the pty to be allocated (pty-ready received from host) */
  waitReady(): Promise<void> {
    return this._ready;
  }

  private _send(msg: PtyClientMsg): void {
    if (this._exited) return;
    try {
      this._child.send(msg);
    } catch {
      // Child may have already exited — ignore send errors
    }
  }
}

/**
 * Spawn a pty via a forked host child process.
 *
 * Returns a Promise<IPty> that resolves once the child confirms the pty
 * is allocated (pty-ready message received).
 */
export async function hostSpawn(
  file: string,
  args: string[],
  options: IPtySpawnOptions,
): Promise<IPty> {
  const hostEntry = resolveHostEntry();
  const child = fork(hostEntry, [], {
    silent: false,
    // Ensure the child inherits a clean module environment
    execArgv: [],
  });

  const proxy = new PtyHostProxy(child);

  const spawnMsg: PtySpawnMsg = {
    type: 'pty-spawn',
    file,
    args,
    options,
  };
  child.send(spawnMsg);

  await proxy.waitReady();
  return proxy;
}
