import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { loadAccounts, type AccountsStore } from '../../../src/bus/oauth.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
const OAUTH_MODULE_PATH = join(REPO_ROOT, 'src', 'bus', 'oauth.ts');
const TSX_CJS_PATH = createRequire(import.meta.url).resolve('tsx/cjs');
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));
const WORKER_TIMEOUT_MS = 5_000;
const BRANCH_LOCK_TIMEOUT_MS = 250;
const ROUNDS = 3;

const WORKER_SCRIPT = String.raw`
require(process.env.TSX_CJS_PATH);

const Module = require('module');
const { existsSync, writeFileSync } = require('fs');
const { join } = require('path');

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  if (ms > 0) {
    Atomics.wait(sleeper, 0, 0, ms);
  }
}

const action = process.env.OAUTH_WORKER_ACTION;
const ctxRoot = process.env.OAUTH_CTX_ROOT;
const pauseFile = process.env.OAUTH_PAUSE_FILE;
const releaseFile = process.env.OAUTH_RELEASE_FILE;
const oauthModulePath = process.env.OAUTH_MODULE_PATH;
const accountsFile = join(ctxRoot, 'state', 'oauth', 'accounts.json');
const originalLoad = Module._load;
let paused = false;

Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request === '../utils/atomic.js' || request.endsWith('/utils/atomic.js')) {
    return {
      ...loaded,
      atomicWriteSync(filePath, data, keepBak) {
        if (!paused && filePath === accountsFile) {
          paused = true;
          writeFileSync(pauseFile, 'paused');
          const deadline = Date.now() + 5000;
          while (!existsSync(releaseFile)) {
            if (Date.now() > deadline) {
              throw new Error('Timed out waiting for release signal');
            }
            sleep(10);
          }
        }
        return loaded.atomicWriteSync(filePath, data, keepBak);
      },
    };
  }
  return loaded;
};

global.fetch = async () => {
  if (action === 'check-usage') {
    return {
      ok: true,
      json: async () => ({
        five_hour_utilization: 0.42,
        seven_day_utilization: 0.18,
      }),
    };
  }

  if (action === 'refresh-token') {
    return {
      ok: true,
      json: async () => ({
        access_token: 'NEW_ACCESS_TOKEN',
        refresh_token: 'NEW_REFRESH_TOKEN',
        expires_in: 3600,
      }),
    };
  }

  throw new Error('Unknown worker action: ' + action);
};

(async () => {
  const { checkUsageApi, refreshOAuthToken } = require(oauthModulePath);

  if (action === 'check-usage') {
    await checkUsageApi(ctxRoot, { force: true, account: 'primary' });
    return;
  }

  if (action === 'refresh-token') {
    await refreshOAuthToken(ctxRoot, 'primary');
    return;
  }

  throw new Error('Unsupported worker action: ' + action);
})()
  .then(() => process.exit(0))
  .catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(message);
    process.exit(1);
  });
`;

function sleep(ms: number): void {
  if (ms > 0) {
    Atomics.wait(SLEEP_VIEW, 0, 0, ms);
  }
}

function waitForFile(path: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(path)) return true;
    sleep(10);
  }
  return existsSync(path);
}

function buildStore(): AccountsStore {
  const fourHoursMs = 4 * 60 * 60 * 1000;
  return {
    active: 'primary',
    accounts: {
      primary: {
        label: 'Primary Account',
        access_token: 'OLD_ACCESS_TOKEN',
        refresh_token: 'OLD_REFRESH_TOKEN',
        expires_at: Date.now() + fourHoursMs,
        last_refreshed: '2026-07-06T00:00:00.000Z',
        five_hour_utilization: 0.11,
        seven_day_utilization: 0.07,
      },
    },
    rotation_log: [],
  };
}

function writeStore(ctxRoot: string, store: AccountsStore): void {
  const oauthStateDir = join(ctxRoot, 'state', 'oauth');
  mkdirSync(oauthStateDir, { recursive: true });
  writeFileSync(join(oauthStateDir, 'accounts.json'), JSON.stringify(store, null, 2));
}

function releaseWorker(path: string): void {
  writeFileSync(path, 'release');
}

function waitForExit(proc: ChildProcess, stderrChunks: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = stderrChunks.join('').trim();
      reject(new Error(stderr || `worker exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`));
    };

    const handleError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const cleanup = (): void => {
      proc.off('exit', handleExit);
      proc.off('error', handleError);
    };

    proc.once('exit', handleExit);
    proc.once('error', handleError);
  });
}

function spawnOauthWorker(
  helperPath: string,
  action: 'check-usage' | 'refresh-token',
  ctxRoot: string,
  pauseFile: string,
  releaseFile: string,
): { proc: ChildProcess; exit: Promise<void> } {
  const proc = spawn(process.execPath, [helperPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OAUTH_WORKER_ACTION: action,
      OAUTH_CTX_ROOT: ctxRoot,
      OAUTH_PAUSE_FILE: pauseFile,
      OAUTH_RELEASE_FILE: releaseFile,
      OAUTH_MODULE_PATH,
      TSX_CJS_PATH,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const stderrChunks: string[] = [];
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    stderrChunks.push(chunk);
  });

  return {
    proc,
    exit: waitForExit(proc, stderrChunks),
  };
}

describe('oauth accounts locked RMW', () => {
  let tmpRoot = '';
  let helperPath = '';
  const workers: ChildProcess[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cortextos-oauth-race-'));
    helperPath = join(tmpRoot, 'oauth-race-worker.cjs');
    writeFileSync(helperPath, WORKER_SCRIPT);
  });

  afterEach(() => {
    for (const worker of workers) {
      try {
        worker.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    workers.length = 0;
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('preserves rotated refresh tokens when usage and refresh writes race', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const ctxRoot = join(tmpRoot, `round-${round}`);
      writeStore(ctxRoot, buildStore());

      const utilPauseFile = join(ctxRoot, 'util.paused');
      const utilReleaseFile = join(ctxRoot, 'util.release');
      const refreshPauseFile = join(ctxRoot, 'refresh.paused');
      const refreshReleaseFile = join(ctxRoot, 'refresh.release');

      const utilWorker = spawnOauthWorker(
        helperPath,
        'check-usage',
        ctxRoot,
        utilPauseFile,
        utilReleaseFile,
      );
      workers.push(utilWorker.proc);
      expect(waitForFile(utilPauseFile, WORKER_TIMEOUT_MS)).toBe(true);

      const refreshWorker = spawnOauthWorker(
        helperPath,
        'refresh-token',
        ctxRoot,
        refreshPauseFile,
        refreshReleaseFile,
      );
      workers.push(refreshWorker.proc);

      const refreshPausedWhileUtilHeldWrite = waitForFile(
        refreshPauseFile,
        BRANCH_LOCK_TIMEOUT_MS,
      );

      if (refreshPausedWhileUtilHeldWrite) {
        releaseWorker(refreshReleaseFile);
        await refreshWorker.exit;
        releaseWorker(utilReleaseFile);
        await utilWorker.exit;
      } else {
        releaseWorker(utilReleaseFile);
        expect(waitForFile(refreshPauseFile, WORKER_TIMEOUT_MS)).toBe(true);
        releaseWorker(refreshReleaseFile);
        await Promise.all([utilWorker.exit, refreshWorker.exit]);
      }

      const store = loadAccounts(ctxRoot);
      expect(store?.accounts.primary.refresh_token).toBe('NEW_REFRESH_TOKEN');
      expect(store?.accounts.primary.access_token).toBe('NEW_ACCESS_TOKEN');
      expect(store?.accounts.primary.five_hour_utilization).toBe(0.42);
      expect(store?.accounts.primary.seven_day_utilization).toBe(0.18);
    }
  }, 20_000);
});
