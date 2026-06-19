import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VaultLivenessWatchdog } from '../../../src/daemon/vault-liveness-watchdog';
import { PLACEHOLDER } from '../../../src/bus/active-tasks';
import type { Task } from '../../../src/types';

function mkTask(p: Partial<Task>): Task {
  return {
    id: 'task_1', title: 'a task', description: '', type: 'agent', needs_approval: false,
    status: 'in_progress', assigned_to: 'agentX', created_by: 'creator', org: 'o',
    priority: 'normal', project: '', kpi_key: null,
    created_at: '2026-06-01T10:00:00Z', updated_at: '2026-06-01T11:00:00Z',
    completed_at: null, due_date: null, archived: false, ...p,
  };
}

const BASE = 1_750_000_000_000; // fixed epoch (ms) — injected as the clock
const MIN = 60_000;

function writeProjectState(vaultRoot: string, mtimeMs: number): void {
  const dir = join(vaultRoot, 'agent-shared');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'project-state.md');
  writeFileSync(p, '# project state\n', 'utf-8');
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

describe('VaultLivenessWatchdog', () => {
  let vaultRoot: string;
  let alerts: string[];

  function makeWatchdog(opts: {
    loadTasks?: () => Task[];
    now?: number;
    staleThresholdMs?: number;
    alertCooldownMs?: number;
  } = {}): VaultLivenessWatchdog {
    return new VaultLivenessWatchdog('default', 'testorg', '/no/such/framework', {
      vaultRoot,
      loadTasks: opts.loadTasks ?? (() => [mkTask({ id: 'live1' })]),
      alert: (m) => alerts.push(m),
      now: () => opts.now ?? BASE,
      log: () => {},
      staleThresholdMs: opts.staleThresholdMs ?? 60 * MIN,
      alertCooldownMs: opts.alertCooldownMs ?? 30 * MIN,
    });
  }

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), 'cortextos-wd-'));
    alerts = [];
  });
  afterEach(() => rmSync(vaultRoot, { recursive: true, force: true }));

  it('regenerates active-tasks.md from the live bus each tick (heals the placeholder)', () => {
    writeProjectState(vaultRoot, BASE); // fresh narrative so only the board matters
    const wd = makeWatchdog({ now: BASE + 5 * MIN });
    wd.tick();
    const board = readFileSync(join(vaultRoot, 'agent-shared', 'active-tasks.md'), 'utf-8');
    expect(board).toContain('live1');
    expect(board).not.toContain(PLACEHOLDER);
    expect(alerts).toEqual([]);
  });

  it('alerts (without throwing) when board regeneration fails', () => {
    writeProjectState(vaultRoot, BASE);
    const wd = makeWatchdog({
      now: BASE + 5 * MIN,
      loadTasks: () => { throw new Error('bus unreadable'); },
    });
    expect(() => wd.tick()).not.toThrow();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/failed to regenerate active-tasks\.md.*bus unreadable/);
  });

  it('alerts when project-state.md is missing', () => {
    // No project-state written; loadTasks ok so the only alert is the missing-narrative one.
    const wd = makeWatchdog({ now: BASE });
    wd.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/project-state\.md is missing/);
  });

  it('alerts when project-state.md is stale, but not when fresh', () => {
    writeProjectState(vaultRoot, BASE);

    // Fresh: 5 min old, threshold 60 min → no alert.
    makeWatchdog({ now: BASE + 5 * MIN }).tick();
    expect(alerts).toEqual([]);

    // Stale: 90 min old → alert.
    makeWatchdog({ now: BASE + 90 * MIN }).tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/project-state\.md is stale .*90m ago/);
  });

  it('respects the alert cooldown per key', () => {
    writeProjectState(vaultRoot, BASE);
    const wd = makeWatchdog({ now: BASE + 90 * MIN, alertCooldownMs: 30 * MIN });

    wd.tick(); // first stale alert
    wd.tick(); // within cooldown (same now) → suppressed
    expect(alerts).toHaveLength(1);
  });

  it('start() runs an immediate tick then stop() tears down the timer', () => {
    writeProjectState(vaultRoot, BASE);
    const wd = new VaultLivenessWatchdog('default', 'testorg', '/no/such/framework', {
      vaultRoot,
      loadTasks: () => [mkTask({ id: 'boot1' })],
      alert: (m) => alerts.push(m),
      now: () => BASE + 5 * MIN,
      log: () => {},
      checkIntervalMs: 60 * MIN, // large — interval must not fire during the test
    });
    wd.start();
    expect(existsSync(join(vaultRoot, 'agent-shared', 'active-tasks.md'))).toBe(true);
    expect(readFileSync(join(vaultRoot, 'agent-shared', 'active-tasks.md'), 'utf-8')).toContain('boot1');
    wd.stop(); // no throw, clears the interval
  });
});
