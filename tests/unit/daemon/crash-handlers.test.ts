import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  crashHistoryPath,
  readCrashHistory,
  writeCrashHistory,
  recordCrash,
  shouldSendCrashLoopAlert,
  countRecentCrashes,
  writeDaemonCrashedMarkers,
  CRASH_HISTORY_MAX,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_COOLDOWN_MS,
  CrashHistory,
} from '../../../src/daemon/index';

// Regression guard for the 2026-04-22 restart storm visibility work. These
// helpers are what let the daemon attribute a crash to itself (not to a
// random agent) and page the operator at 3+ crashes in 15min.

function mkCtxRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortextos-crash-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

describe('crash history persistence', () => {
  let ctxRoot: string;

  beforeEach(() => { ctxRoot = mkCtxRoot(); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('returns empty history when no file exists', () => {
    const h = readCrashHistory(ctxRoot);
    expect(h.crashes).toEqual([]);
    expect(h.lastAlertAt).toBeUndefined();
  });

  it('returns empty history on corrupt JSON', () => {
    writeFileSync(crashHistoryPath(ctxRoot), 'not valid json{{{', 'utf-8');
    const h = readCrashHistory(ctxRoot);
    expect(h.crashes).toEqual([]);
  });

  it('round-trips write → read', () => {
    const original: CrashHistory = {
      crashes: [{ ts: '2026-04-23T01:00:00.000Z', err: 'err1' }],
      lastAlertAt: '2026-04-23T01:05:00.000Z',
    };
    writeCrashHistory(ctxRoot, original);
    expect(readCrashHistory(ctxRoot)).toEqual(original);
  });

  it('recordCrash appends and caps at CRASH_HISTORY_MAX', () => {
    for (let i = 0; i < CRASH_HISTORY_MAX + 5; i++) {
      recordCrash(ctxRoot, `crash ${i}`);
    }
    const h = readCrashHistory(ctxRoot);
    expect(h.crashes.length).toBe(CRASH_HISTORY_MAX);
    // Oldest entries trimmed — last crash should be "crash 24" (MAX+5-1)
    expect(h.crashes[h.crashes.length - 1].err).toContain(`crash ${CRASH_HISTORY_MAX + 4}`);
  });

  it('recordCrash truncates very long error strings', () => {
    const huge = 'x'.repeat(5000);
    recordCrash(ctxRoot, huge);
    const h = readCrashHistory(ctxRoot);
    expect(h.crashes[0].err.length).toBeLessThanOrEqual(2000);
  });
});

describe('shouldSendCrashLoopAlert', () => {
  const now = Date.now();
  const minAgo = (n: number) => new Date(now - n * 60_000).toISOString();

  it('returns false below threshold', () => {
    const h: CrashHistory = {
      crashes: [
        { ts: minAgo(1), err: 'a' },
        { ts: minAgo(2), err: 'b' },
      ],
    };
    expect(shouldSendCrashLoopAlert(h)).toBe(false);
  });

  it('returns true at exactly threshold within window', () => {
    const h: CrashHistory = {
      crashes: Array.from({ length: CRASH_LOOP_THRESHOLD }, (_, i) => ({
        ts: minAgo(i + 1),
        err: `crash${i}`,
      })),
    };
    expect(shouldSendCrashLoopAlert(h)).toBe(true);
  });

  it('ignores crashes older than the 15min window', () => {
    const h: CrashHistory = {
      crashes: [
        { ts: minAgo(20), err: 'old1' },
        { ts: minAgo(18), err: 'old2' },
        { ts: minAgo(16), err: 'old3' },
        { ts: minAgo(2), err: 'recent1' },
      ],
    };
    // Only 1 recent — below threshold
    expect(shouldSendCrashLoopAlert(h)).toBe(false);
  });

  it('respects 30-min cooldown after previous alert', () => {
    const h: CrashHistory = {
      crashes: Array.from({ length: CRASH_LOOP_THRESHOLD + 1 }, (_, i) => ({
        ts: minAgo(i + 1),
        err: `crash${i}`,
      })),
      lastAlertAt: new Date(now - 10 * 60_000).toISOString(), // 10 min ago
    };
    expect(shouldSendCrashLoopAlert(h)).toBe(false);
  });

  it('fires again once cooldown expires', () => {
    const h: CrashHistory = {
      crashes: Array.from({ length: CRASH_LOOP_THRESHOLD }, (_, i) => ({
        ts: minAgo(i + 1),
        err: `crash${i}`,
      })),
      lastAlertAt: new Date(now - CRASH_LOOP_COOLDOWN_MS - 60_000).toISOString(),
    };
    expect(shouldSendCrashLoopAlert(h)).toBe(true);
  });
});

describe('countRecentCrashes', () => {
  const now = Date.now();
  it('counts only crashes inside the 15min window', () => {
    const h: CrashHistory = {
      crashes: [
        { ts: new Date(now - 20 * 60_000).toISOString(), err: 'old' },
        { ts: new Date(now - 10 * 60_000).toISOString(), err: 'inside1' },
        { ts: new Date(now - 5 * 60_000).toISOString(), err: 'inside2' },
        { ts: new Date(now - 16 * 60_000).toISOString(), err: 'just-outside' },
      ],
    };
    expect(countRecentCrashes(h)).toBe(2);
  });
});

describe('writeDaemonCrashedMarkers', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkCtxRoot();
    mkdirSync(join(ctxRoot, 'state', 'boris'), { recursive: true });
    mkdirSync(join(ctxRoot, 'state', 'donna'), { recursive: true });
    mkdirSync(join(ctxRoot, 'state', 'nick'), { recursive: true });
  });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('writes a .daemon-crashed marker in each per-agent state dir', () => {
    writeDaemonCrashedMarkers(ctxRoot);
    for (const name of ['boris', 'donna', 'nick']) {
      const marker = join(ctxRoot, 'state', name, '.daemon-crashed');
      expect(existsSync(marker)).toBe(true);
      // ISO timestamp
      expect(readFileSync(marker, 'utf-8')).toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('skips gracefully when state dir is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cortextos-empty-'));
    expect(() => writeDaemonCrashedMarkers(empty)).not.toThrow();
    rmSync(empty, { recursive: true, force: true });
  });

  it('overwrites existing marker with newer timestamp', () => {
    writeFileSync(join(ctxRoot, 'state', 'boris', '.daemon-crashed'), 'OLD', 'utf-8');
    writeDaemonCrashedMarkers(ctxRoot);
    const content = readFileSync(join(ctxRoot, 'state', 'boris', '.daemon-crashed'), 'utf-8');
    expect(content).not.toBe('OLD');
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
