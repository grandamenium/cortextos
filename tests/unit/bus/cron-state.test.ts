import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  updateCronFire,
  readCronState,
  parseDurationMs,
  pruneCronState,
  DEFAULT_PRUNE_MIN_STALE_MS,
} from '../../../src/bus/cron-state';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cron-state-test-'));
});

function cleanup() {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

describe('parseDurationMs', () => {
  it('parses minutes', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('6h')).toBe(6 * 3_600_000);
    expect(parseDurationMs('24h')).toBe(24 * 3_600_000);
  });

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  it('parses weeks', () => {
    expect(parseDurationMs('2w')).toBe(2 * 604_800_000);
  });

  it('returns NaN for cron expressions', () => {
    expect(parseDurationMs('0 8 * * *')).toBeNaN();
    expect(parseDurationMs('*/5 * * * *')).toBeNaN();
  });

  it('returns NaN for empty string', () => {
    expect(parseDurationMs('')).toBeNaN();
  });

  it('returns NaN for unknown unit', () => {
    expect(parseDurationMs('5y')).toBeNaN();
    expect(parseDurationMs('10s')).toBeNaN();
  });
});

describe('readCronState', () => {
  it('returns empty state when file does not exist', () => {
    const state = readCronState(tmpDir);
    expect(state.crons).toEqual([]);
    cleanup();
  });
});

describe('updateCronFire', () => {
  it('creates a record when none exists', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(1);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBe('6h');
    expect(Date.parse(state.crons[0].last_fire)).not.toBeNaN();
    cleanup();
  });

  it('updates existing record for the same cron name', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const first = readCronState(tmpDir).crons[0].last_fire;

    // Ensure time advances
    const before = Date.now();
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const second = readCronState(tmpDir).crons[0].last_fire;

    expect(Date.parse(second)).toBeGreaterThanOrEqual(before);
    expect(readCronState(tmpDir).crons).toHaveLength(1); // no duplicate
    cleanup();
  });

  it('accumulates records for different cron names', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    updateCronFire(tmpDir, 'autoresearch', '24h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(2);
    const names = state.crons.map(r => r.name);
    expect(names).toContain('heartbeat');
    expect(names).toContain('autoresearch');
    cleanup();
  });

  it('works without interval argument', () => {
    updateCronFire(tmpDir, 'heartbeat');
    const state = readCronState(tmpDir);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBeUndefined();
    cleanup();
  });

  it('survives a read-write-read cycle with correct values', () => {
    updateCronFire(tmpDir, 'inbox-triage', '2h');
    updateCronFire(tmpDir, 'heartbeat', '4h');
    const state = readCronState(tmpDir);
    const inbox = state.crons.find(r => r.name === 'inbox-triage');
    const hb = state.crons.find(r => r.name === 'heartbeat');
    expect(inbox?.interval).toBe('2h');
    expect(hb?.interval).toBe('4h');
    cleanup();
  });
});

describe('pruneCronState', () => {
  /** Write a cron-state.json with explicit records (lets us backdate last_fire). */
  function seedState(records: Array<{ name: string; last_fire: string; interval?: string }>) {
    writeFileSync(
      join(tmpDir, 'cron-state.json'),
      JSON.stringify({ updated_at: new Date().toISOString(), crons: records }, null, 2) + '\n',
      'utf-8',
    );
  }

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const DAY = 86_400_000;

  it('prunes a stale orphan absent from the live set', () => {
    seedState([
      { name: 'heartbeat', last_fire: ago(5 * 60_000), interval: '30m' },
      { name: 'retired-sync', last_fire: ago(40 * DAY), interval: '2h' }, // orphan, very stale
    ]);

    const pruned = pruneCronState(tmpDir, ['heartbeat']);

    expect(pruned).toEqual(['retired-sync']);
    const names = readCronState(tmpDir).crons.map(r => r.name);
    expect(names).toEqual(['heartbeat']);
    cleanup();
  });

  it('keeps a live cron even if its last_fire is ancient', () => {
    seedState([{ name: 'weekly-report', last_fire: ago(60 * DAY), interval: '1w' }]);

    const pruned = pruneCronState(tmpDir, ['weekly-report']);

    expect(pruned).toEqual([]);
    expect(readCronState(tmpDir).crons.map(r => r.name)).toEqual(['weekly-report']);
    cleanup();
  });

  // The load-bearing safety guarantee from the ticket: a manage-cycle cron that
  // is transiently MISSING from the live crons.json set (e.g. config.json updated
  // a beat before crons.json) must NOT be pruned, because its recent last_fire
  // proves it is alive. Only the staleness floor protects it here.
  it('keeps a recently-fired orphan (manage-cycle survival)', () => {
    seedState([
      { name: 'cortextos-src-watch', last_fire: ago(11 * 60_000), interval: '10m' }, // fired 11m ago, not in live set
      { name: 'vault-task-reconcile', last_fire: ago(20 * 60_000), interval: '15m' },
    ]);

    // Neither name is in the live set, yet both fired minutes ago → both survive.
    const pruned = pruneCronState(tmpDir, ['heartbeat']);

    expect(pruned).toEqual([]);
    const names = readCronState(tmpDir).crons.map(r => r.name);
    expect(names).toContain('cortextos-src-watch');
    expect(names).toContain('vault-task-reconcile');
    cleanup();
  });

  it('treats a disabled-but-present cron as live (caller includes its name)', () => {
    seedState([{ name: 'paused-cron', last_fire: ago(30 * DAY), interval: '1h' }]);

    // Caller passes the union of enabled + disabled names → disabled cron kept.
    const pruned = pruneCronState(tmpDir, new Set(['paused-cron']));

    expect(pruned).toEqual([]);
    expect(readCronState(tmpDir).crons.map(r => r.name)).toEqual(['paused-cron']);
    cleanup();
  });

  it('is a no-op (no records pruned) when every entry is live', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    updateCronFire(tmpDir, 'upstream-watch', '4h');

    const pruned = pruneCronState(tmpDir, ['heartbeat', 'upstream-watch']);

    expect(pruned).toEqual([]);
    expect(readCronState(tmpDir).crons).toHaveLength(2);
    cleanup();
  });

  it('honors a custom staleness floor', () => {
    seedState([{ name: 'orphan', last_fire: ago(2 * DAY), interval: '1h' }]);

    // Default 14d floor → 2d-old orphan survives.
    expect(pruneCronState(tmpDir, [])).toEqual([]);
    // 1d floor → now eligible.
    expect(pruneCronState(tmpDir, [], { minStaleMs: DAY })).toEqual(['orphan']);
    expect(readCronState(tmpDir).crons).toHaveLength(0);
    cleanup();
  });

  it('prunes an orphan with an unparseable last_fire (treated as infinitely stale)', () => {
    seedState([
      { name: 'live', last_fire: ago(60_000), interval: '5m' },
      { name: 'garbage', last_fire: 'not-a-date', interval: '1h' },
    ]);

    const pruned = pruneCronState(tmpDir, ['live']);

    expect(pruned).toEqual(['garbage']);
    expect(readCronState(tmpDir).crons.map(r => r.name)).toEqual(['live']);
    cleanup();
  });

  it('exposes a sane default staleness floor', () => {
    expect(DEFAULT_PRUNE_MIN_STALE_MS).toBe(14 * 86_400_000);
  });
});
