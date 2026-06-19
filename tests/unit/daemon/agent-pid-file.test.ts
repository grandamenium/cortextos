import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeAgentPidFile,
  readAgentPidFile,
  clearAgentPidFile,
  listAgentPidFiles,
  agentPidFilePath,
  classifyOrphan,
  parseEtimeMs,
  type AgentPidRecord,
  type OrphanProbe,
  type LiveProcessInfo,
} from '../../../src/daemon/agent-pid-file.js';

// SYS-DAEMON-RESILIENCE-01 Part A — Fix 2 pid-file persistence + orphan classifier.
// classifyOrphan is pure (injectable probe) so the 3-part PID-REUSE guard is
// validated deterministically with no real processes/signals.

describe('agent-pid-file persistence', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-pidfile-')); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('write -> read round-trips the record', () => {
    writeAgentPidFile(ctxRoot, 'inst', 'alice', 4242, '2026-06-18T10:00:00.000Z');
    const rec = readAgentPidFile(agentPidFilePath(ctxRoot, 'alice'));
    expect(rec).toEqual({ instanceId: 'inst', agent: 'alice', pid: 4242, spawnedAt: '2026-06-18T10:00:00.000Z' });
  });

  it('clear removes the pid-file (and is safe when absent)', () => {
    writeAgentPidFile(ctxRoot, 'inst', 'bob', 7, '2026-06-18T10:00:00.000Z');
    expect(existsSync(agentPidFilePath(ctxRoot, 'bob'))).toBe(true);
    clearAgentPidFile(ctxRoot, 'bob');
    expect(existsSync(agentPidFilePath(ctxRoot, 'bob'))).toBe(false);
    expect(() => clearAgentPidFile(ctxRoot, 'bob')).not.toThrow();
  });

  it('list scans every agent of the instance, ignoring dirs without a pid-file', () => {
    writeAgentPidFile(ctxRoot, 'inst', 'alice', 1, '2026-06-18T10:00:00.000Z');
    writeAgentPidFile(ctxRoot, 'inst', 'bob', 2, '2026-06-18T10:00:00.000Z');
    mkdirSync(join(ctxRoot, 'state', 'carol'), { recursive: true }); // dir, no pid-file
    const found = listAgentPidFiles(ctxRoot).map(f => f.record.agent).sort();
    expect(found).toEqual(['alice', 'bob']);
  });

  it('readAgentPidFile returns null on corrupt JSON', () => {
    mkdirSync(join(ctxRoot, 'state', 'dave'), { recursive: true });
    writeFileSync(agentPidFilePath(ctxRoot, 'dave'), '{ not json');
    expect(readAgentPidFile(agentPidFilePath(ctxRoot, 'dave'))).toBeNull();
  });
});

describe('parseEtimeMs (locale-independent ps elapsed-time)', () => {
  it('parses ss / mm:ss / hh:mm:ss / dd-hh:mm:ss', () => {
    expect(parseEtimeMs('05')).toBe(5_000);
    expect(parseEtimeMs('01:23')).toBe(83_000);
    expect(parseEtimeMs('12:34:56')).toBe(((12 * 3600) + (34 * 60) + 56) * 1000);
    expect(parseEtimeMs('3-01:23:45')).toBe(((3 * 86400) + (1 * 3600) + (23 * 60) + 45) * 1000);
  });
  it('returns null on garbage', () => {
    expect(parseEtimeMs('')).toBeNull();
    expect(parseEtimeMs('abc')).toBeNull();
  });
});

describe('classifyOrphan — 3-part PID-reuse guard', () => {
  const SPAWN = '2026-06-18T10:00:00.000Z';
  const SPAWN_MS = Date.parse(SPAWN);
  const rec = (over: Partial<AgentPidRecord> = {}): AgentPidRecord =>
    ({ instanceId: 'inst', agent: 'alice', pid: 5000, spawnedAt: SPAWN, ...over });

  // probe builder: alive + a live-process info (command + startedAtMs)
  const probe = (opts: { alive?: boolean; info?: LiveProcessInfo | null }): OrphanProbe => ({
    isAlive: () => opts.alive ?? true,
    getLiveProcess: () => (opts.info === undefined ? { command: '/usr/bin/claude --continue', startedAtMs: SPAWN_MS } : opts.info),
  });

  it('REAPS a confirmed own live agent: kill-0 + claude command + start-time match', () => {
    const v = classifyOrphan(rec(), 'inst', [99], probe({ alive: true }));
    expect(v).toBe('reap');
  });

  it('stale-unlink when the PID is dead (kill-0 false)', () => {
    expect(classifyOrphan(rec(), 'inst', [99], probe({ alive: false }))).toBe('stale-unlink');
  });

  it('stale-unlink (NEVER kill) when PID recycled to an UNRELATED process (command mismatch)', () => {
    const v = classifyOrphan(rec(), 'inst', [99], probe({ alive: true, info: { command: '/usr/bin/vim notes.txt', startedAtMs: SPAWN_MS } }));
    expect(v).toBe('stale-unlink');
  });

  it('stale-unlink (NEVER kill) when PID recycled to ANOTHER agent (command matches but start-time mismatches) — PD bulletproof case', () => {
    const laterStart = SPAWN_MS + 60 * 60 * 1000; // another claude started an hour later took the PID
    const v = classifyOrphan(rec(), 'inst', [99], probe({ alive: true, info: { command: '/usr/bin/claude --continue', startedAtMs: laterStart } }));
    expect(v).toBe('stale-unlink');
  });

  it('start-time within tolerance still reaps (ps second-granularity + spawn latency)', () => {
    const v = classifyOrphan(rec(), 'inst', [99], probe({ alive: true, info: { command: 'claude', startedAtMs: SPAWN_MS + 3000 } }));
    expect(v).toBe('reap');
  });

  it('stale-unlink when the record points at a daemon PID (never kill a daemon)', () => {
    expect(classifyOrphan(rec({ pid: 99 }), 'inst', [99], probe({ alive: true }))).toBe('stale-unlink');
  });

  it('foreign-skip when the pid-file belongs to another instance', () => {
    expect(classifyOrphan(rec({ instanceId: 'other' }), 'inst', [99], probe({ alive: true }))).toBe('foreign-skip');
  });

  it('stale-unlink when ps returns no info (process vanished between kill-0 and ps)', () => {
    expect(classifyOrphan(rec(), 'inst', [99], probe({ alive: true, info: null }))).toBe('stale-unlink');
  });

  it('stale-unlink on an unparseable spawnedAt', () => {
    expect(classifyOrphan(rec({ spawnedAt: 'not-a-date' }), 'inst', [99], probe({ alive: true }))).toBe('stale-unlink');
  });
});
