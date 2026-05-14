import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readHeartbeatStatus,
  readLastInboxMessageAge,
  readCrashBudget,
  readLastRestart,
  readLastSpawnFailureAge,
} from '../../../src/utils/agent-status';

describe('agent-status helpers', () => {
  let ctxRoot: string;
  const AGENT = 'boss';

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-agent-status-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  // ── readHeartbeatStatus ────────────────────────────────────────────────────
  describe('readHeartbeatStatus', () => {
    it('returns empty fields when heartbeat.json is missing', () => {
      expect(readHeartbeatStatus(ctxRoot, AGENT)).toEqual({});
    });

    it('parses age + task from a fresh heartbeat', () => {
      const now = Date.parse('2026-05-15T12:00:00Z');
      const tsAgo = new Date(now - 45_000).toISOString();
      mkdirSync(join(ctxRoot, 'state', AGENT), { recursive: true });
      writeFileSync(
        join(ctxRoot, 'state', AGENT, 'heartbeat.json'),
        JSON.stringify({ last_heartbeat: tsAgo, current_task: 'cycle complete', status: 'healthy' }),
      );
      const out = readHeartbeatStatus(ctxRoot, AGENT, now);
      expect(out.lastHeartbeatAgeSeconds).toBe(45);
      expect(out.lastHeartbeatTask).toBe('cycle complete');
    });

    it('falls back to legacy `timestamp` field', () => {
      const now = Date.parse('2026-05-15T12:00:00Z');
      const tsAgo = new Date(now - 10_000).toISOString();
      mkdirSync(join(ctxRoot, 'state', AGENT), { recursive: true });
      writeFileSync(
        join(ctxRoot, 'state', AGENT, 'heartbeat.json'),
        JSON.stringify({ timestamp: tsAgo, current_task: 'legacy' }),
      );
      const out = readHeartbeatStatus(ctxRoot, AGENT, now);
      expect(out.lastHeartbeatAgeSeconds).toBe(10);
      expect(out.lastHeartbeatTask).toBe('legacy');
    });

    it('omits task when current_task is empty', () => {
      const now = Date.parse('2026-05-15T12:00:00Z');
      const tsAgo = new Date(now - 1000).toISOString();
      mkdirSync(join(ctxRoot, 'state', AGENT), { recursive: true });
      writeFileSync(
        join(ctxRoot, 'state', AGENT, 'heartbeat.json'),
        JSON.stringify({ last_heartbeat: tsAgo, current_task: '' }),
      );
      expect(readHeartbeatStatus(ctxRoot, AGENT, now).lastHeartbeatTask).toBeUndefined();
    });

    it('returns {} for corrupt JSON without throwing', () => {
      mkdirSync(join(ctxRoot, 'state', AGENT), { recursive: true });
      writeFileSync(join(ctxRoot, 'state', AGENT, 'heartbeat.json'), '{not json');
      expect(readHeartbeatStatus(ctxRoot, AGENT)).toEqual({});
    });
  });

  // ── readLastInboxMessageAge ───────────────────────────────────────────────
  describe('readLastInboxMessageAge', () => {
    it('returns undefined when inbox dir does not exist', () => {
      expect(readLastInboxMessageAge(ctxRoot, AGENT)).toBeUndefined();
    });

    it('returns undefined when inbox is empty', () => {
      mkdirSync(join(ctxRoot, 'inbox', AGENT), { recursive: true });
      expect(readLastInboxMessageAge(ctxRoot, AGENT)).toBeUndefined();
    });

    it('finds newest mtime across multiple files', () => {
      mkdirSync(join(ctxRoot, 'inbox', AGENT), { recursive: true });
      const now = Date.parse('2026-05-15T12:00:00Z');
      const aPath = join(ctxRoot, 'inbox', AGENT, 'a.json');
      const bPath = join(ctxRoot, 'inbox', AGENT, 'b.json');
      writeFileSync(aPath, '{}');
      writeFileSync(bPath, '{}');
      // a is 300s old, b is 50s old → newest is b.
      utimesSync(aPath, new Date(now - 300_000), new Date(now - 300_000));
      utimesSync(bPath, new Date(now - 50_000), new Date(now - 50_000));
      expect(readLastInboxMessageAge(ctxRoot, AGENT, now)).toBe(50);
    });
  });

  // ── readCrashBudget ────────────────────────────────────────────────────────
  describe('readCrashBudget', () => {
    it('falls back to in-memory crashCount when file is missing', () => {
      const out = readCrashBudget(ctxRoot, AGENT, 10, 3);
      expect(out).toEqual({ crashCountToday: 3, maxCrashesPerDay: 10, crashesRemaining: 7 });
    });

    it('parses today\'s count when stored date matches', () => {
      mkdirSync(join(ctxRoot, 'logs', AGENT), { recursive: true });
      writeFileSync(join(ctxRoot, 'logs', AGENT, '.crash_count_today'), '2026-05-15:4');
      const out = readCrashBudget(ctxRoot, AGENT, 10, 0, '2026-05-15');
      expect(out).toEqual({ crashCountToday: 4, maxCrashesPerDay: 10, crashesRemaining: 6 });
    });

    it('treats yesterday\'s stored count as 0', () => {
      mkdirSync(join(ctxRoot, 'logs', AGENT), { recursive: true });
      writeFileSync(join(ctxRoot, 'logs', AGENT, '.crash_count_today'), '2026-05-14:9');
      const out = readCrashBudget(ctxRoot, AGENT, 10, 0, '2026-05-15');
      expect(out).toEqual({ crashCountToday: 0, maxCrashesPerDay: 10, crashesRemaining: 10 });
    });

    it('clamps crashesRemaining at 0 when over budget', () => {
      mkdirSync(join(ctxRoot, 'logs', AGENT), { recursive: true });
      writeFileSync(join(ctxRoot, 'logs', AGENT, '.crash_count_today'), '2026-05-15:15');
      const out = readCrashBudget(ctxRoot, AGENT, 10, 0, '2026-05-15');
      expect(out.crashesRemaining).toBe(0);
    });
  });

  // ── readLastRestart ────────────────────────────────────────────────────────
  describe('readLastRestart', () => {
    it('returns empty when restarts.log is missing', () => {
      expect(readLastRestart(ctxRoot, AGENT)).toEqual({});
    });

    it('parses kind + reason from the last line', () => {
      mkdirSync(join(ctxRoot, 'logs', AGENT), { recursive: true });
      const lines = [
        '[2026-05-14T08:00:00Z] SELF-RESTART: 6h session refresh',
        '[2026-05-14T14:00:00Z] CRASH: exit_code=1 crash_count=2 backoff_s=10',
        '',
      ].join('\n');
      writeFileSync(join(ctxRoot, 'logs', AGENT, 'restarts.log'), lines);
      const out = readLastRestart(ctxRoot, AGENT);
      expect(out.lastRestartKind).toBe('CRASH');
      expect(out.lastRestartReason).toBe('exit_code=1 crash_count=2 backoff_s=10');
    });

    it('recognizes all canonical kinds', () => {
      const cases: Array<[string, string]> = [
        ['SELF-RESTART', 'reason'],
        ['HARD-RESTART', 'reason'],
        ['CRASH', 'exit_code=1'],
        ['HALTED', 'exit_code=1'],
        ['SPAWN-FAIL', 'posix_spawnp'],
        ['SPAWN-FAIL-HALTED', 'budget exhausted'],
      ];
      for (const [kind, details] of cases) {
        mkdirSync(join(ctxRoot, 'logs', AGENT), { recursive: true });
        writeFileSync(
          join(ctxRoot, 'logs', AGENT, 'restarts.log'),
          `[2026-05-15T12:00:00Z] ${kind}: ${details}\n`,
        );
        const out = readLastRestart(ctxRoot, AGENT);
        expect(out.lastRestartKind).toBe(kind);
        expect(out.lastRestartReason).toBe(details);
      }
    });

    it('treats unknown kind tokens as untyped reason text', () => {
      mkdirSync(join(ctxRoot, 'logs', AGENT), { recursive: true });
      writeFileSync(
        join(ctxRoot, 'logs', AGENT, 'restarts.log'),
        '[2026-05-15T12:00:00Z] WHIMSICAL: unexpected\n',
      );
      const out = readLastRestart(ctxRoot, AGENT);
      expect(out.lastRestartKind).toBeUndefined();
      expect(out.lastRestartReason).toContain('WHIMSICAL');
    });

    it('returns {} for empty file', () => {
      mkdirSync(join(ctxRoot, 'logs', AGENT), { recursive: true });
      writeFileSync(join(ctxRoot, 'logs', AGENT, 'restarts.log'), '');
      expect(readLastRestart(ctxRoot, AGENT)).toEqual({});
    });
  });

  // ── readLastSpawnFailureAge ────────────────────────────────────────────────
  describe('readLastSpawnFailureAge', () => {
    it('returns null when the history file is absent', () => {
      expect(readLastSpawnFailureAge(ctxRoot, AGENT)).toBeNull();
    });

    it('returns null when no events match the agent', () => {
      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      writeFileSync(
        join(ctxRoot, 'state', '.spawn-failure-history.json'),
        JSON.stringify({ events: [{ ts: '2026-05-15T12:00:00Z', agent: 'other', err: 'x' }] }),
      );
      expect(readLastSpawnFailureAge(ctxRoot, AGENT)).toBeNull();
    });

    it('returns age in seconds of the newest matching event', () => {
      const now = Date.parse('2026-05-15T12:00:00Z');
      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      writeFileSync(
        join(ctxRoot, 'state', '.spawn-failure-history.json'),
        JSON.stringify({
          events: [
            { ts: new Date(now - 600_000).toISOString(), agent: AGENT, err: 'old' },
            { ts: new Date(now - 120_000).toISOString(), agent: AGENT, err: 'new' },
            { ts: new Date(now - 60_000).toISOString(), agent: 'other', err: 'unrelated' },
          ],
        }),
      );
      expect(readLastSpawnFailureAge(ctxRoot, AGENT, now)).toBe(120);
    });

    it('returns undefined (not null) on corrupt JSON so caller can distinguish', () => {
      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      writeFileSync(join(ctxRoot, 'state', '.spawn-failure-history.json'), '{not json');
      expect(readLastSpawnFailureAge(ctxRoot, AGENT)).toBeUndefined();
    });
  });
});
