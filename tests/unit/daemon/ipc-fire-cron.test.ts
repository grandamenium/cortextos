/**
 * tests/unit/daemon/ipc-fire-cron.test.ts — Subtask 4.5
 *
 * Unit tests for the fire-cron IPC handler:
 *   - handleFireCron
 *   - manualFireCooldownRemaining
 *   - MANUAL_FIRE_COOLDOWN_MS constant
 *   - _manualFireLastFired in-memory map
 *   - manualFireDisabled opt-out
 *   - Cooldown enforcement
 *   - Missing agent/cron validation
 *   - happy path (injection called, firedAt returned)
 *
 * Uses fresh per-test CTX_ROOT + vi.resetModules() to isolate module state
 * (including the cooldown map).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Per-test tempdir + module isolation
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ipc-fire-test-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRONS_DIR = '.cortextOS/state/agents';

function writeCronsJson(agentName: string, crons: CronDefinition[]): void {
  const dir = join(tmpRoot, CRONS_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), crons }, null, 2),
  );
}

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'heartbeat',
    prompt: 'Run heartbeat workflow.',
    schedule: '6h',
    enabled: true,
    created_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeInjectFn(results: boolean[] = [true]) {
  const calls: Array<{ agent: string; text: string }> = [];
  let callCount = 0;
  const fn = (agent: string, text: string) => {
    calls.push({ agent, text });
    const result = results[callCount] ?? results[results.length - 1];
    callCount++;
    return result;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// MANUAL_FIRE_COOLDOWN_MS constant
// ---------------------------------------------------------------------------

describe('MANUAL_FIRE_COOLDOWN_MS', () => {
  it('is 30000 (30 seconds)', async () => {
    const { MANUAL_FIRE_COOLDOWN_MS } = await import('../../../src/daemon/ipc-server.js');
    expect(MANUAL_FIRE_COOLDOWN_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// manualFireCooldownRemaining
// ---------------------------------------------------------------------------

describe('manualFireCooldownRemaining', () => {
  it('returns 0 when never fired (no entry in map)', async () => {
    const { manualFireCooldownRemaining } = await import('../../../src/daemon/ipc-server.js');
    const remaining = manualFireCooldownRemaining('boris', 'heartbeat', Date.now());
    expect(remaining).toBe(0);
  });

  it('returns remaining ms immediately after fire', async () => {
    const { manualFireCooldownRemaining, _manualFireLastFired, MANUAL_FIRE_COOLDOWN_MS } =
      await import('../../../src/daemon/ipc-server.js');
    const now = Date.now();
    _manualFireLastFired.set('boris::heartbeat', now);
    const remaining = manualFireCooldownRemaining('boris', 'heartbeat', now + 5_000);
    expect(remaining).toBe(MANUAL_FIRE_COOLDOWN_MS - 5_000);
  });

  it('returns 0 when cooldown has fully elapsed', async () => {
    const { manualFireCooldownRemaining, _manualFireLastFired, MANUAL_FIRE_COOLDOWN_MS } =
      await import('../../../src/daemon/ipc-server.js');
    const now = 1_000_000;
    _manualFireLastFired.set('boris::heartbeat', now);
    const remaining = manualFireCooldownRemaining('boris', 'heartbeat', now + MANUAL_FIRE_COOLDOWN_MS);
    expect(remaining).toBe(0);
  });

  it('returns 0 after cooldown + 1ms (boundary)', async () => {
    const { manualFireCooldownRemaining, _manualFireLastFired, MANUAL_FIRE_COOLDOWN_MS } =
      await import('../../../src/daemon/ipc-server.js');
    const now = 1_000_000;
    _manualFireLastFired.set('boris::heartbeat', now);
    const remaining = manualFireCooldownRemaining('boris', 'heartbeat', now + MANUAL_FIRE_COOLDOWN_MS + 1);
    expect(remaining).toBe(0);
  });

  it('tracks per (agent, cronName) independently', async () => {
    const { manualFireCooldownRemaining, _manualFireLastFired } =
      await import('../../../src/daemon/ipc-server.js');
    const now = 1_000_000;
    _manualFireLastFired.set('boris::heartbeat', now);
    // Different cron — no cooldown
    const remaining = manualFireCooldownRemaining('boris', 'daily-report', now + 1_000);
    expect(remaining).toBe(0);
    // Same cron — still on cooldown
    const remaining2 = manualFireCooldownRemaining('boris', 'heartbeat', now + 1_000);
    expect(remaining2).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// handleFireCron — validation
// ---------------------------------------------------------------------------

describe('handleFireCron — input validation', () => {
  it('returns error when agent is missing', async () => {
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn();
    const result = handleFireCron(undefined, 'heartbeat', fn);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/agent/i);
  });

  it('returns error when agent is empty string', async () => {
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn();
    const result = handleFireCron('', 'heartbeat', fn);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/agent/i);
  });

  it('returns error when cronName is missing', async () => {
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn();
    const result = handleFireCron('boris', undefined, fn);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cron/i);
  });

  it('returns error when cronName is empty string', async () => {
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn();
    const result = handleFireCron('boris', '', fn);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cron/i);
  });
});

// ---------------------------------------------------------------------------
// handleFireCron — cron not found
// ---------------------------------------------------------------------------

describe('handleFireCron — cron not found', () => {
  it('returns error when cron does not exist for agent', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn();
    const result = handleFireCron('boris', 'nonexistent', fn);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nonexistent');
    expect(result.error).toContain('boris');
  });

  it('returns error when agent has no crons at all', async () => {
    writeCronsJson('boris', []);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn();
    const result = handleFireCron('boris', 'heartbeat', fn);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('heartbeat');
  });
});

// ---------------------------------------------------------------------------
// handleFireCron — manualFireDisabled
// ---------------------------------------------------------------------------

describe('handleFireCron — manualFireDisabled', () => {
  it('refuses when manualFireDisabled is true', async () => {
    writeCronsJson('boris', [makeCron({ manualFireDisabled: true })]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn, calls } = makeInjectFn();
    const result = handleFireCron('boris', 'heartbeat', fn);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Manual fire disabled');
    expect(calls).toHaveLength(0);
  });

  it('allows when manualFireDisabled is false', async () => {
    writeCronsJson('boris', [makeCron({ manualFireDisabled: false })]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true]);
    const result = handleFireCron('boris', 'heartbeat', fn, 1_000_000);
    expect(result.ok).toBe(true);
  });

  it('allows when manualFireDisabled is absent (default allow)', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true]);
    const result = handleFireCron('boris', 'heartbeat', fn, 1_000_000);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleFireCron — cooldown
// ---------------------------------------------------------------------------

describe('handleFireCron — cooldown', () => {
  it('refuses second fire within 30s', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true, true]);

    const t0 = 1_000_000_000;
    const first = handleFireCron('boris', 'heartbeat', fn, t0);
    expect(first.ok).toBe(true);

    // 15s later — still on cooldown
    const second = handleFireCron('boris', 'heartbeat', fn, t0 + 15_000);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('Cooldown active');
    expect(second.error).toMatch(/\d+s/); // should mention remaining seconds
  });

  it('allows fire after 30s cooldown elapses', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron, MANUAL_FIRE_COOLDOWN_MS } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true, true]);

    const t0 = 1_000_000_000;
    handleFireCron('boris', 'heartbeat', fn, t0);

    // Exactly at cooldown expiry
    const second = handleFireCron('boris', 'heartbeat', fn, t0 + MANUAL_FIRE_COOLDOWN_MS);
    expect(second.ok).toBe(true);
  });

  it('cooldown is per-cron — different cron not affected', async () => {
    writeCronsJson('boris', [
      makeCron({ name: 'heartbeat' }),
      makeCron({ name: 'daily-report', schedule: '24h' }),
    ]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true, true]);

    const t0 = 1_000_000_000;
    handleFireCron('boris', 'heartbeat', fn, t0);

    // daily-report — different cron, no cooldown
    const result = handleFireCron('boris', 'daily-report', fn, t0 + 5_000);
    expect(result.ok).toBe(true);
  });

  it('cooldown error message includes remaining seconds', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true, true]);

    const t0 = 1_000_000_000;
    handleFireCron('boris', 'heartbeat', fn, t0);

    const second = handleFireCron('boris', 'heartbeat', fn, t0 + 10_000);
    expect(second.ok).toBe(false);
    // Should say "20s" remaining (30 - 10)
    expect(second.error).toContain('20s');
  });
});

// ---------------------------------------------------------------------------
// handleFireCron — happy path
// ---------------------------------------------------------------------------

describe('handleFireCron — happy path', () => {
  it('injects correct [CRON: name] prompt format', async () => {
    writeCronsJson('boris', [makeCron({ prompt: 'Run heartbeat workflow.' })]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn, calls } = makeInjectFn([true]);
    handleFireCron('boris', 'heartbeat', fn, 1_000_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('boris');
    expect(calls[0].text).toBe('[CRON: heartbeat] Run heartbeat workflow.');
  });

  it('returns ok:true with firedAt timestamp', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true]);
    const now = 1_234_567_890;
    const result = handleFireCron('boris', 'heartbeat', fn, now);
    expect(result.ok).toBe(true);
    expect(result.firedAt).toBe(now);
  });

  it('records fire time in cooldown map', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron, _manualFireLastFired } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true]);
    const now = 1_234_567_890;
    handleFireCron('boris', 'heartbeat', fn, now);
    expect(_manualFireLastFired.get('boris::heartbeat')).toBe(now);
  });

  it('returns error when inject returns false (agent not running)', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([false]);
    const result = handleFireCron('boris', 'heartbeat', fn, 1_000_000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found or not running');
  });

  it('does NOT record fire time in cooldown map when injection fails', async () => {
    writeCronsJson('boris', [makeCron()]);
    const { handleFireCron, _manualFireLastFired } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([false]);
    const now = 1_000_000;
    handleFireCron('boris', 'heartbeat', fn, now);
    expect(_manualFireLastFired.has('boris::heartbeat')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleAddCron — manualFireDisabled round-trip
// ---------------------------------------------------------------------------

describe('handleAddCron — manualFireDisabled round-trip', () => {
  it('stores manualFireDisabled:true through add', async () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify({ boris: { enabled: true } }),
    );
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const { readCrons } = await import('../../../src/bus/crons.js');

    handleAddCron('boris', {
      name: 'secure-cron',
      prompt: 'Do not fire manually.',
      schedule: '1d',
      manualFireDisabled: true,
    });

    const crons = readCrons('boris');
    expect(crons).toHaveLength(1);
    expect(crons[0].manualFireDisabled).toBe(true);
  });

  it('stores manualFireDisabled:false (explicit) through add', async () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify({ boris: { enabled: true } }),
    );
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const { readCrons } = await import('../../../src/bus/crons.js');

    handleAddCron('boris', {
      name: 'normal-cron',
      prompt: 'Can fire manually.',
      schedule: '6h',
      manualFireDisabled: false,
    });

    const crons = readCrons('boris');
    expect(crons[0].manualFireDisabled).toBe(false);
  });

  it('does not set manualFireDisabled when absent from definition', async () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify({ boris: { enabled: true } }),
    );
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const { readCrons } = await import('../../../src/bus/crons.js');

    handleAddCron('boris', {
      name: 'default-cron',
      prompt: 'Default.',
      schedule: '6h',
    });

    const crons = readCrons('boris');
    // When not specified, should be absent (or falsy)
    expect(crons[0].manualFireDisabled ?? false).toBe(false);
  });

  it('updates manualFireDisabled through update-cron patch', async () => {
    const dir = join(tmpRoot, CRONS_DIR, 'boris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'crons.json'),
      JSON.stringify({ updated_at: new Date().toISOString(), crons: [makeCron()] }, null, 2),
    );
    const { handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const { getCronByName } = await import('../../../src/bus/crons.js');

    const result = handleUpdateCron('boris', 'heartbeat', { manualFireDisabled: true });
    expect(result.ok).toBe(true);
    const updated = getCronByName('boris', 'heartbeat');
    expect(updated?.manualFireDisabled).toBe(true);
  });

  it('round-trip: add with manualFireDisabled:true → fire → refused', async () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify({ boris: { enabled: true } }),
    );
    const { handleAddCron, handleFireCron } = await import('../../../src/daemon/ipc-server.js');
    const { fn } = makeInjectFn([true]);

    handleAddCron('boris', {
      name: 'locked-cron',
      prompt: 'Should not fire manually.',
      schedule: '6h',
      manualFireDisabled: true,
    });

    const result = handleFireCron('boris', 'locked-cron', fn, 1_000_000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Manual fire disabled');
  });
});
