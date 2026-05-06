/**
 * tests/unit/bus/execution-log-pagination.test.ts — Subtask 4.3
 *
 * Unit tests for getExecutionLog + getExecutionLogPage (offset, statusFilter,
 * pagination edge cases).  Tests both the convenience wrapper and the full
 * page-returning function.
 *
 * Uses a fresh per-test tempdir CTX_ROOT, same pattern as crons-io.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronExecutionLogEntry } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'exec-log-page-test-'));
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

const LOG_DIR = '.cortextOS/state/agents';

function writeLogEntries(agentName: string, entries: CronExecutionLogEntry[]): void {
  const dir = join(tmpRoot, LOG_DIR, agentName);
  mkdirSync(dir, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, 'cron-execution.log'), lines, 'utf-8');
}

function makeEntry(
  cronName: string,
  status: 'fired' | 'retried' | 'failed',
  tsOffset = 0,
): CronExecutionLogEntry {
  return {
    ts: new Date(1000000 + tsOffset * 1000).toISOString(),
    cron: cronName,
    status,
    attempt: 1,
    duration_ms: 100 + tsOffset,
    error: status === 'fired' ? null : `err-${tsOffset}`,
  };
}

async function importCrons() {
  return import('../../../src/bus/crons.js');
}

// ---------------------------------------------------------------------------
// getExecutionLogPage — basic pagination
// ---------------------------------------------------------------------------

describe('getExecutionLogPage — basic pagination', () => {
  it('returns all entries when limit=0 and offset=0', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 0, 0, 'all');
    expect(page.entries).toHaveLength(10);
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(false);
  });

  it('returns most-recent N entries at offset=0', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 5, 0, 'all');
    expect(page.entries).toHaveLength(5);
    expect(page.total).toBe(20);
    expect(page.hasMore).toBe(true);
    // Most recent entries have the highest tsOffset values (15-19)
    const durations = page.entries.map(e => e.duration_ms);
    expect(durations).toEqual([115, 116, 117, 118, 119]);
  });

  it('paginates correctly: offset=5 returns entries 15 back from the start', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 5, 5, 'all');
    expect(page.entries).toHaveLength(5);
    expect(page.total).toBe(20);
    expect(page.hasMore).toBe(true);
    // With offset=5 we skip the 5 most recent; entries 10-14 from the list
    const durations = page.entries.map(e => e.duration_ms);
    expect(durations).toEqual([110, 111, 112, 113, 114]);
  });

  it('hasMore=false when offset reaches near the start', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    // offset=8, limit=5 → only 2 entries remain
    const page = getExecutionLogPage('boris', 'heartbeat', 5, 8, 'all');
    expect(page.entries).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it('offset > total returns empty entries and hasMore=false', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 10, 100, 'all');
    expect(page.entries).toHaveLength(0);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(false);
  });

  it('limit > total returns all entries', async () => {
    const entries = Array.from({ length: 3 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 1000, 0, 'all');
    expect(page.entries).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it('returns empty page for missing log file', async () => {
    const { getExecutionLogPage } = await importCrons();
    const page = getExecutionLogPage('ghost-agent', 'any-cron', 10, 0, 'all');
    expect(page.entries).toHaveLength(0);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getExecutionLogPage — status filter
// ---------------------------------------------------------------------------

describe('getExecutionLogPage — statusFilter', () => {
  it('success filter returns only "fired" entries', async () => {
    const entries = [
      makeEntry('heartbeat', 'fired', 0),
      makeEntry('heartbeat', 'failed', 1),
      makeEntry('heartbeat', 'fired', 2),
      makeEntry('heartbeat', 'retried', 3),
      makeEntry('heartbeat', 'fired', 4),
    ];
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 100, 0, 'success');
    expect(page.entries.every(e => e.status === 'fired')).toBe(true);
    expect(page.total).toBe(3); // 3 fired entries
  });

  it('failure filter returns only "failed" entries', async () => {
    const entries = [
      makeEntry('heartbeat', 'fired', 0),
      makeEntry('heartbeat', 'failed', 1),
      makeEntry('heartbeat', 'failed', 2),
      makeEntry('heartbeat', 'fired', 3),
    ];
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 100, 0, 'failure');
    expect(page.entries.every(e => e.status === 'failed')).toBe(true);
    expect(page.total).toBe(2);
  });

  it('all filter returns all statuses', async () => {
    const entries = [
      makeEntry('heartbeat', 'fired', 0),
      makeEntry('heartbeat', 'failed', 1),
      makeEntry('heartbeat', 'retried', 2),
    ];
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 100, 0, 'all');
    expect(page.total).toBe(3);
  });

  it('success filter with no matches returns empty entries', async () => {
    const entries = [
      makeEntry('heartbeat', 'failed', 0),
      makeEntry('heartbeat', 'retried', 1),
    ];
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 100, 0, 'success');
    expect(page.entries).toHaveLength(0);
    expect(page.total).toBe(0);
  });

  it('statusFilter + cronName filter compose correctly', async () => {
    const entries = [
      makeEntry('heartbeat', 'fired', 0),
      makeEntry('daily-report', 'fired', 1),
      makeEntry('heartbeat', 'failed', 2),
      makeEntry('daily-report', 'failed', 3),
    ];
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    const page = getExecutionLogPage('boris', 'heartbeat', 100, 0, 'failure');
    expect(page.total).toBe(1);
    expect(page.entries[0].cron).toBe('heartbeat');
    expect(page.entries[0].status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// getExecutionLogPage — 100-entry default limit
// ---------------------------------------------------------------------------

describe('getExecutionLogPage — 100-entry default', () => {
  it('defaults to limit=100 (most recent 100 of 150)', async () => {
    const entries = Array.from({ length: 150 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLogPage } = await importCrons();

    // Default limit is 100
    const page = getExecutionLogPage('boris', 'heartbeat');
    expect(page.entries).toHaveLength(100);
    expect(page.total).toBe(150);
    expect(page.hasMore).toBe(true);
    // Should be entries 50–149 (the 100 most recent)
    expect(page.entries[0].duration_ms).toBe(150); // tsOffset=50 → 100+50
    expect(page.entries[99].duration_ms).toBe(249); // tsOffset=149 → 100+149
  });
});

// ---------------------------------------------------------------------------
// getExecutionLog — backward compat wrapper
// ---------------------------------------------------------------------------

describe('getExecutionLog — backward compat', () => {
  it('returns array (not page object) identical to old behavior', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLog } = await importCrons();

    const result = getExecutionLog('boris', 'heartbeat', 5);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(5);
  });

  it('returns last N entries (most recent) when limit is provided', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLog } = await importCrons();

    const result = getExecutionLog('boris', 'heartbeat', 3);
    // Should be entries with tsOffset 7, 8, 9
    expect(result.map(e => e.duration_ms)).toEqual([107, 108, 109]);
  });

  it('returns all entries when limit=0', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => makeEntry('heartbeat', 'fired', i));
    writeLogEntries('boris', entries);
    const { getExecutionLog } = await importCrons();

    const result = getExecutionLog('boris', 'heartbeat', 0);
    expect(result).toHaveLength(8);
  });
});
