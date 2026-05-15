import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../src/types/index.js';

const TICK_MS = 30_000;
const ONE_MIN = 60_000;

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

let writeCrons: typeof import('../../src/bus/crons.js').writeCrons;
let CronScheduler: typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;

async function reloadModules(): Promise<void> {
  vi.resetModules();
  const cronsModule = await import('../../src/bus/crons.js');
  writeCrons = cronsModule.writeCrons;
  const schedulerModule = await import('../../src/daemon/cron-scheduler.js');
  CronScheduler = schedulerModule.CronScheduler;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-reload-race-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.useFakeTimers();
  await reloadModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

function ensureAgentDir(agentName: string): void {
  mkdirSync(join(tmpRoot, '.cortextOS', 'state', 'agents', agentName), { recursive: true });
}

function makeCronDef(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'reload-race',
    prompt: 'Exercise reload while firing.',
    schedule: '1m',
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('cron scheduler reload race regression', () => {
  it('3 fires with reload during each fire window: fire count reaches 3, no freeze', async () => {
    const agent = 'cron-reload-race-agent';
    ensureAgentDir(agent);

    const logs: string[] = [];
    const firedAt: number[] = [];
    let resolveActiveFire: (() => void) | null = null;

    writeCrons(agent, [
      makeCronDef({
        last_fired_at: new Date(Date.now() - 2 * ONE_MIN).toISOString(),
        fire_count: 1,
      }),
    ]);

    const scheduler = new CronScheduler({
      agentName: agent,
      logger: (msg) => logs.push(msg),
      onFire: async () => {
        firedAt.push(Date.now());
        await new Promise<void>((resolve) => {
          resolveActiveFire = resolve;
        });
      },
    });

    scheduler.start();

    async function fireWithInterleavedReload(advanceMs: number, expectedCount: number) {
      await vi.advanceTimersByTimeAsync(advanceMs);
      expect(firedAt).toHaveLength(expectedCount);
      expect(resolveActiveFire).not.toBeNull();

      scheduler.reload();

      const [duringFire] = scheduler.getNextFireTimes();
      expect(duringFire).toBeDefined();

      resolveActiveFire!();
      resolveActiveFire = null;
      await vi.advanceTimersByTimeAsync(0);

      const [afterFire] = scheduler.getNextFireTimes();
      expect(afterFire).toBeDefined();
      expect(afterFire.nextFireAt).toBeGreaterThan(Date.now());
    }

    await fireWithInterleavedReload(TICK_MS, 1);
    await fireWithInterleavedReload(ONE_MIN, 2);
    await fireWithInterleavedReload(ONE_MIN, 3);

    await vi.advanceTimersByTimeAsync(ONE_MIN);
    expect(firedAt).toHaveLength(4);
    expect(resolveActiveFire).not.toBeNull();
    resolveActiveFire!();
    await vi.advanceTimersByTimeAsync(0);

    const [afterFourth] = scheduler.getNextFireTimes();
    expect(afterFourth).toBeDefined();
    expect(afterFourth.nextFireAt).toBeGreaterThan(Date.now());
    expect(logs.some((line) => line.includes('reload deferred for "reload-race"'))).toBe(true);

    scheduler.stop();
  });
});
