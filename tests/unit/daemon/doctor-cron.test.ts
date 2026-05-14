/**
 * Fleet-resilience plan #4 — doctor cron diff + alert behavior.
 *
 * We don't run the real runAllChecks here (it shells out to claude/pm2/gh
 * which would be slow + non-deterministic in CI). Instead we test:
 *   (a) computeDelta (pure) on synthetic snapshots
 *   (b) runOnce baseline emit + suppression + transition emit, with
 *       runAllChecks mocked to return a fixed Check[] per invocation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Check } from '../../../src/utils/health-checks';

const runAllChecksMock = vi.fn();
vi.mock('../../../src/utils/health-checks', () => ({
  runAllChecks: (opts: { instanceId: string; frameworkRoot: string }) => runAllChecksMock(opts),
}));

const spawnSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

import {
  DoctorCron,
  computeDelta,
  readLastRun,
  doctorLastRunPath,
} from '../../../src/daemon/doctor-cron';

let ctxRoot: string;
let frameworkRoot: string;

const ORIG_ENV_CHAT = process.env.CTX_OPERATOR_CHAT_ID;
const ORIG_ENV_TOKEN = process.env.CTX_OPERATOR_BOT_TOKEN;

function chk(name: string, status: Check['status']): Check {
  return { name, status, message: name + ' message' };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-doctor-cron-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-doctor-cron-fw-'));
  mkdirSync(join(ctxRoot, 'state'), { recursive: true });
  runAllChecksMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  process.env.CTX_OPERATOR_CHAT_ID = '12345';
  process.env.CTX_OPERATOR_BOT_TOKEN = '99999:fakefakefakefakefakeABCDEFGHIJ';
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(frameworkRoot, { recursive: true, force: true });
  if (ORIG_ENV_CHAT === undefined) delete process.env.CTX_OPERATOR_CHAT_ID;
  else process.env.CTX_OPERATOR_CHAT_ID = ORIG_ENV_CHAT;
  if (ORIG_ENV_TOKEN === undefined) delete process.env.CTX_OPERATOR_BOT_TOKEN;
  else process.env.CTX_OPERATOR_BOT_TOKEN = ORIG_ENV_TOKEN;
});

describe('computeDelta (pure)', () => {
  it('returns empty delta when nothing changed', () => {
    const current: Check[] = [chk('a', 'pass'), chk('b', 'warn')];
    const previous = { a: 'pass' as const, b: 'warn' as const };
    expect(computeDelta(current, previous)).toEqual({
      newFailures: [], newWarnings: [], resolved: [],
    });
  });

  it('pass→warn shows up as newWarnings', () => {
    const current: Check[] = [chk('a', 'warn')];
    expect(computeDelta(current, { a: 'pass' })).toEqual({
      newFailures: [], newWarnings: ['a'], resolved: [],
    });
  });

  it('pass→fail and warn→fail both show up as newFailures', () => {
    const current: Check[] = [chk('a', 'fail'), chk('b', 'fail')];
    expect(computeDelta(current, { a: 'pass', b: 'warn' })).toEqual({
      newFailures: ['a', 'b'], newWarnings: [], resolved: [],
    });
  });

  it('warn→pass and fail→pass show up as resolved', () => {
    const current: Check[] = [chk('a', 'pass'), chk('b', 'pass')];
    expect(computeDelta(current, { a: 'warn', b: 'fail' })).toEqual({
      newFailures: [], newWarnings: [], resolved: ['a', 'b'],
    });
  });

  it('previously unknown check is silently ignored (no spurious newWarnings)', () => {
    const current: Check[] = [chk('a', 'warn')];
    expect(computeDelta(current, {})).toEqual({
      newFailures: [], newWarnings: [], resolved: [],
    });
  });
});

describe('DoctorCron.runOnce', () => {
  it('first run with current warn/fail emits a baseline alert', async () => {
    runAllChecksMock.mockResolvedValue([chk('a', 'warn'), chk('b', 'fail'), chk('c', 'pass')]);
    const cron = new DoctorCron({
      ctxRoot, frameworkRoot, instanceId: 'test',
      intervalMinutes: 30, logger: () => {},
    });
    const r = await cron.runOnce();
    expect(r.baselineEmitted).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(existsSync(doctorLastRunPath(ctxRoot))).toBe(true);
    const snapshot = readLastRun(ctxRoot);
    expect(snapshot?.checks).toEqual({ a: 'warn', b: 'fail', c: 'pass' });
  });

  it('first run with everything passing is silent', async () => {
    runAllChecksMock.mockResolvedValue([chk('a', 'pass'), chk('b', 'pass')]);
    const cron = new DoctorCron({
      ctxRoot, frameworkRoot, instanceId: 'test',
      intervalMinutes: 30, logger: () => {},
    });
    const r = await cron.runOnce();
    expect(r.baselineEmitted).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('second run with identical state is silent (the common case)', async () => {
    runAllChecksMock.mockResolvedValue([chk('a', 'warn'), chk('b', 'pass')]);
    const cron = new DoctorCron({
      ctxRoot, frameworkRoot, instanceId: 'test',
      intervalMinutes: 30, logger: () => {},
    });
    await cron.runOnce();
    spawnSyncMock.mockClear();
    await cron.runOnce();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('new fail in second run emits a delta alert', async () => {
    runAllChecksMock
      .mockResolvedValueOnce([chk('a', 'pass'), chk('b', 'pass')])
      .mockResolvedValueOnce([chk('a', 'pass'), chk('b', 'fail')]);
    const cron = new DoctorCron({
      ctxRoot, frameworkRoot, instanceId: 'test',
      intervalMinutes: 30, logger: () => {},
    });
    await cron.runOnce(); // baseline (all pass — silent)
    spawnSyncMock.mockClear();
    const r = await cron.runOnce();
    expect(r.delta.newFailures).toEqual(['b']);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('resolved check emits a delta entry on the next run', async () => {
    runAllChecksMock
      .mockResolvedValueOnce([chk('a', 'fail')])
      .mockResolvedValueOnce([chk('a', 'pass')]);
    const cron = new DoctorCron({
      ctxRoot, frameworkRoot, instanceId: 'test',
      intervalMinutes: 30, logger: () => {},
    });
    await cron.runOnce(); // baseline emit (we're tracking that elsewhere)
    spawnSyncMock.mockClear();
    const r = await cron.runOnce();
    expect(r.delta.resolved).toEqual(['a']);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('intervalMinutes=0 makes start() a no-op (no initial tick)', () => {
    const cron = new DoctorCron({
      ctxRoot, frameworkRoot, instanceId: 'test',
      intervalMinutes: 0, logger: () => {},
    });
    cron.start();
    expect(runAllChecksMock).not.toHaveBeenCalled();
    cron.stop();
  });

  it('persists snapshot to disk for future runs', async () => {
    runAllChecksMock.mockResolvedValue([chk('a', 'pass')]);
    const cron = new DoctorCron({
      ctxRoot, frameworkRoot, instanceId: 'test',
      intervalMinutes: 30, logger: () => {},
    });
    await cron.runOnce();
    const onDisk = JSON.parse(readFileSync(doctorLastRunPath(ctxRoot), 'utf-8'));
    expect(onDisk.ranAt).toBeTruthy();
    expect(onDisk.checks).toEqual({ a: 'pass' });
  });
});
