import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { fork, spawn, spawnSync, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { acquireLock, releaseLock, withFileLockSync } from '../../../src/utils/lock';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
const LOCK_MODULE_PATH = join(REPO_ROOT, 'src', 'utils', 'lock.ts');
const TSX_CJS_PATH = createRequire(import.meta.url).resolve('tsx/cjs');
const DEAD_PID = 2_147_483_647;
const STALE_AGE_MS = 2_000;
const LOCK_TEST_TIMEOUT_MS = 5_000;

const HELPER_SCRIPT = String.raw`
require(process.env.TSX_CJS_PATH);

const { readFileSync, writeFileSync } = require('fs');
const { acquireLock, releaseLock, withFileLockSync } = require(process.env.LOCK_MODULE_PATH);

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  if (ms > 0) {
    Atomics.wait(sleeper, 0, 0, ms);
  }
}

function waitUntil(startAt) {
  const delay = startAt - Date.now();
  if (delay > 0) {
    sleep(delay);
  }
}

function readCounter(counterFile) {
  try {
    const raw = readFileSync(counterFile, 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

function send(message) {
  if (process.send) {
    process.send(message);
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') {
    return;
  }

  const { id, action, startAt = 0 } = message;

  try {
    waitUntil(startAt);

    if (action === 'rmw') {
      let enter = null;
      let exit = null;
      withFileLockSync(
        message.dir,
        () => {
          enter = Date.now();
          const current = readCounter(message.counterFile);
          sleep(message.holdMs);
          writeFileSync(message.counterFile, String(current + 1));
          exit = Date.now();
        },
        {
          timeoutMs: message.timeoutMs,
          initialBackoffMs: message.initialBackoffMs,
          maxBackoffMs: message.maxBackoffMs,
        },
      );
      send({ type: 'result', id, pid: process.pid, enter, exit, acquired: true, error: null });
      return;
    }

    if (action === 'acquire-once') {
      const acquired = acquireLock(message.dir);
      let enter = null;
      let exit = null;
      if (acquired) {
        enter = Date.now();
        sleep(message.holdMs);
        exit = Date.now();
      }
      send({ type: 'result', id, pid: process.pid, enter, exit, acquired, error: null });
      return;
    }

    send({ type: 'result', id, pid: process.pid, acquired: false, error: 'unknown action' });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    send({ type: 'result', id, pid: process.pid, acquired: false, error: messageText });
  }
});

send({ type: 'ready', pid: process.pid });
`;

const STAT_ENOENT_HELPER_SCRIPT = String.raw`
const Module = require('module');
const originalLoad = Module._load;
let threwEnoent = false;

Module._load = function(request, parent, isMain) {
  if (request === 'fs') {
    const actualFs = originalLoad.call(this, request, parent, isMain);
    return {
      ...actualFs,
      statSync(...args) {
        if (!threwEnoent) {
          threwEnoent = true;
          const err = new Error('lock vanished');
          err.code = 'ENOENT';
          throw err;
        }
        return actualFs.statSync(...args);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

require(process.env.TSX_CJS_PATH);

const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { acquireLock } = require(process.env.LOCK_MODULE_PATH);

const dir = process.argv[2];
const lockDir = join(dir, '.lock.d');
mkdirSync(lockDir, { recursive: true });
writeFileSync(join(lockDir, 'pid'), String(process.pid));

try {
  const result = acquireLock(dir);
  process.stdout.write(JSON.stringify({ result }));
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(message);
  process.exit(2);
}
`;

const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

interface ReadyMessage {
  type: 'ready';
  pid: number;
}

interface ResultMessage {
  type: 'result';
  id: number;
  pid: number;
  acquired: boolean;
  enter: number | null;
  exit: number | null;
  error: string | null;
}

interface RmwCommand {
  action: 'rmw';
  dir: string;
  counterFile: string;
  holdMs: number;
  startAt: number;
  timeoutMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}

interface AcquireOnceHoldCommand {
  action: 'acquire-once';
  dir: string;
  holdMs: number;
  startAt: number;
}

type WorkerCommand = RmwCommand | AcquireOnceHoldCommand;

function sleep(ms: number): void {
  if (ms > 0) {
    Atomics.wait(SLEEP_VIEW, 0, 0, ms);
  }
}

function isReadyMessage(message: unknown): message is ReadyMessage {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as { type?: unknown; pid?: unknown };
  return candidate.type === 'ready' && typeof candidate.pid === 'number';
}

function isResultMessage(message: unknown): message is ResultMessage {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as {
    type?: unknown;
    id?: unknown;
    pid?: unknown;
    acquired?: unknown;
    enter?: unknown;
    exit?: unknown;
    error?: unknown;
  };
  const validNumber = (value: unknown): value is number | null =>
    value === null || typeof value === 'number';
  return (
    candidate.type === 'result' &&
    typeof candidate.id === 'number' &&
    typeof candidate.pid === 'number' &&
    typeof candidate.acquired === 'boolean' &&
    validNumber(candidate.enter) &&
    validNumber(candidate.exit) &&
    (candidate.error === null || typeof candidate.error === 'string')
  );
}

class LockWorker {
  private readonly proc: ChildProcess;
  private readonly readyPromise: Promise<void>;
  private readonly pending = new Map<
    number,
    {
      resolve: (message: ResultMessage) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextId = 1;

  constructor(helperPath: string) {
    this.proc = fork(helperPath, [], {
      cwd: REPO_ROOT,
      env: { ...process.env, LOCK_MODULE_PATH, TSX_CJS_PATH },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const handleMessage = (message: unknown): void => {
        if (isReadyMessage(message)) {
          this.proc.off('message', handleMessage);
          resolve();
        }
      };

      this.proc.on('message', handleMessage);
      this.proc.on('error', reject);
      this.proc.on('exit', (code, signal) => {
        if (code !== null || signal !== null) {
          reject(new Error(`worker exited before ready (code=${code}, signal=${signal})`));
        }
      });
    });

    this.proc.on('message', (message: unknown) => {
      if (!isResultMessage(message)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    });

    this.proc.on('exit', (code, signal) => {
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id);
        pending.reject(new Error(`worker exited during command (code=${code}, signal=${signal})`));
      }
    });
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  run(command: WorkerCommand): Promise<ResultMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.send({ ...command, id }, error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.killed) return;

    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 500);

      this.proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        this.proc.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }
}

let testDir: string;
let helperPath: string;
let statEnoentHelperPath: string;
let activeWorkers: LockWorker[] = [];

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  helperPath = join(testDir, 'lock-worker.cjs');
  statEnoentHelperPath = join(testDir, 'lock-stat-enoent.cjs');
  writeFileSync(helperPath, HELPER_SCRIPT);
  writeFileSync(statEnoentHelperPath, STAT_ENOENT_HELPER_SCRIPT);
});

afterEach(async () => {
  await Promise.allSettled(activeWorkers.map(worker => worker.stop()));
  activeWorkers = [];
  rmSync(testDir, { recursive: true, force: true });
});

async function startWorkers(count: number): Promise<LockWorker[]> {
  const workers = Array.from({ length: count }, () => new LockWorker(helperPath));
  activeWorkers.push(...workers);
  await Promise.all(workers.map(worker => worker.ready()));
  return workers;
}

function seedDeadPidLock(dir: string): void {
  const lockDir = join(dir, '.lock.d');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'pid'), String(DEAD_PID));
}

function seedMissingPidLock(dir: string, ageMs: number): void {
  const lockDir = join(dir, '.lock.d');
  mkdirSync(lockDir, { recursive: true });
  const staleAt = new Date(Date.now() - ageMs);
  utimesSync(lockDir, staleAt, staleAt);
}

function readCounter(counterFile: string): number {
  return parseInt(readFileSync(counterFile, 'utf-8').trim(), 10);
}

function countOverlaps(results: ResultMessage[]): number {
  const windows = results
    .filter(result => result.enter !== null && result.exit !== null)
    .map(result => ({ enter: result.enter as number, exit: result.exit as number }))
    .sort((left, right) => left.enter - right.enter || left.exit - right.exit);

  let overlaps = 0;
  for (let index = 1; index < windows.length; index++) {
    if (windows[index].enter < windows[index - 1].exit) {
      overlaps++;
    }
  }
  return overlaps;
}

describe('mkdir-based locking', () => {
  it('acquires lock on empty directory', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('prevents double acquire', () => {
    expect(acquireLock(testDir)).toBe(true);
    expect(acquireLock(testDir)).toBe(false);
    releaseLock(testDir);
  });

  it('releases lock correctly', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('serializes N=8 stale-lock contenders with no overlapping hold windows', async () => {
    const workers = await startWorkers(8);
    const rounds = 4;

    for (let round = 0; round < rounds; round++) {
      const roundDir = join(testDir, `rmw-round-${round}`);
      const counterFile = join(roundDir, 'counter.txt');
      mkdirSync(roundDir, { recursive: true });
      writeFileSync(counterFile, '0');
      seedDeadPidLock(roundDir);

      const startAt = Date.now() + 75;
      const results = await Promise.all(
        workers.map(worker => worker.run({
          action: 'rmw',
          dir: roundDir,
          counterFile,
          holdMs: 12,
          startAt,
          timeoutMs: LOCK_TEST_TIMEOUT_MS,
          initialBackoffMs: 1,
          maxBackoffMs: 5,
        })),
      );

      for (const result of results) {
        expect(result.error).toBeNull();
        expect(result.acquired).toBe(true);
      }
      expect(readCounter(counterFile)).toBe(workers.length);
      expect(countOverlaps(results)).toBe(0);
    }
  }, 20_000);

  it('allows only one immediate stale-lock stealer per round', async () => {
    const workers = await startWorkers(4);
    const rounds = 20;

    for (let round = 0; round < rounds; round++) {
      const roundDir = join(testDir, `steal-round-${round}`);
      mkdirSync(roundDir, { recursive: true });
      seedDeadPidLock(roundDir);

      const startAt = Date.now() + 75;
      const results = await Promise.all(
        workers.map(worker => worker.run({
          action: 'acquire-once',
          dir: roundDir,
          holdMs: 50,
          startAt,
        })),
      );

      for (const result of results) {
        expect(result.error).toBeNull();
      }
      const winners = results.filter(result => result.acquired);
      expect(winners).toHaveLength(1);
      expect(countOverlaps(winners)).toBe(0);
    }
  }, 20_000);

  it('recovers stale missing-pid locks but refuses fresh missing-pid locks', () => {
    const staleDir = join(testDir, 'stale-missing-pid');
    const staleMarker = join(staleDir, 'marker.txt');
    mkdirSync(staleDir, { recursive: true });
    seedMissingPidLock(staleDir, STALE_AGE_MS);

    expect(() => withFileLockSync(
      staleDir,
      () => writeFileSync(staleMarker, 'recovered'),
      { timeoutMs: 100, initialBackoffMs: 1, maxBackoffMs: 5 },
    )).not.toThrow();
    expect(readFileSync(staleMarker, 'utf-8')).toBe('recovered');

    const freshDir = join(testDir, 'fresh-missing-pid');
    mkdirSync(freshDir, { recursive: true });
    seedMissingPidLock(freshDir, 0);
    expect(acquireLock(freshDir)).toBe(false);
  });

  it('retries instead of throwing when lockDir disappears before statSync', () => {
    const result = spawnSync(
      process.execPath,
      [statEnoentHelperPath, testDir],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, LOCK_MODULE_PATH, TSX_CJS_PATH },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(JSON.stringify({ result: false }));
  });

  it('does not let a non-owner release a live foreign-owned lock', async () => {
    const foreign = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 1000)'], {
      stdio: 'ignore',
    });

    try {
      const foreignPid = foreign.pid;
      if (foreignPid === undefined) {
        throw new Error('failed to start foreign owner process');
      }

      const lockDir = join(testDir, '.lock.d');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'pid'), String(foreignPid));
      sleep(25);

      releaseLock(testDir);
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      try { foreign.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });
});
