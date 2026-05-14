/**
 * Unit tests for src/bus/event.ts — logEvent()
 *
 * Coverage targets:
 *   - JSONL line is appended to the correct daily file path
 *   - Event record fields (id, agent, org, timestamp, category, event, severity, metadata)
 *   - Metadata as object vs JSON string vs undefined
 *   - Invalid JSON string metadata falls back to {}
 *   - Category and severity validation (throws on invalid)
 *   - Multiple calls append multiple lines, each parseable
 *   - Fire-and-forget mirrorEventToRgos is called (never throws)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../../../src/types/index';

// Mock mirrorEventToRgos so tests don't attempt Supabase connections.
vi.mock('../../../src/bus/rgos-mirror.js', () => ({
  mirrorEventToRgos: vi.fn().mockResolvedValue(undefined),
}));

import { logEvent } from '../../../src/bus/event';
import { mirrorEventToRgos } from '../../../src/bus/rgos-mirror';
const mockMirror = vi.mocked(mirrorEventToRgos);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  };
}

function todayDate(): string {
  return new Date().toISOString().split('T')[0];
}

function readEventLines(root: string, agentName: string): Record<string, unknown>[] {
  const file = join(root, 'analytics', 'events', agentName, `${todayDate()}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testRoot: string;
let paths: BusPaths;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cortextos-event-test-'));
  paths = makePaths(testRoot);
  vi.clearAllMocks();
});

function cleanup() {
  rmSync(testRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('logEvent — file output', () => {
  it('creates the daily JSONL file and appends a valid record', () => {
    logEvent(paths, 'dev', 'revops-global', 'action', 'test_event', 'info');
    const lines = readEventLines(testRoot, 'dev');
    cleanup();
    expect(lines).toHaveLength(1);
    const rec = lines[0];
    expect(rec.agent).toBe('dev');
    expect(rec.org).toBe('revops-global');
    expect(rec.category).toBe('action');
    expect(rec.event).toBe('test_event');
    expect(rec.severity).toBe('info');
  });
});

describe('logEvent — JSONL record structure', () => {
  afterEach(cleanup);

  it('includes id, agent, org, timestamp, category, event, severity, metadata', () => {
    logEvent(paths, 'dev', 'revops-global', 'action', 'task_completed', 'info', { task_id: 'abc' });
    const [rec] = readEventLines(testRoot, 'dev');
    expect(typeof rec.id).toBe('string');
    expect(rec.id).toMatch(/^\d+-dev-[a-z0-9]+$/);
    expect(rec.agent).toBe('dev');
    expect(rec.org).toBe('revops-global');
    expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(rec.category).toBe('action');
    expect(rec.event).toBe('task_completed');
    expect(rec.severity).toBe('info');
    expect((rec.metadata as Record<string, unknown>).task_id).toBe('abc');
  });

  it('metadata as object is preserved verbatim', () => {
    const meta = { source: 'test', count: 42 };
    logEvent(paths, 'dev', 'revops-global', 'action', 'ev', 'info', meta);
    const [rec] = readEventLines(testRoot, 'dev');
    expect(rec.metadata).toMatchObject(meta);
  });

  it('metadata as valid JSON string is parsed', () => {
    logEvent(paths, 'dev', 'revops-global', 'action', 'ev', 'info', '{"key":"value"}');
    const [rec] = readEventLines(testRoot, 'dev');
    expect((rec.metadata as Record<string, unknown>).key).toBe('value');
  });

  it('metadata as invalid JSON string falls back to empty object', () => {
    logEvent(paths, 'dev', 'revops-global', 'action', 'ev', 'info', 'not-json');
    const [rec] = readEventLines(testRoot, 'dev');
    expect(rec.metadata).toEqual({});
  });

  it('metadata omitted produces empty object', () => {
    logEvent(paths, 'dev', 'revops-global', 'action', 'ev', 'info');
    const [rec] = readEventLines(testRoot, 'dev');
    expect(rec.metadata).toEqual({});
  });
});

describe('logEvent — multiple events', () => {
  afterEach(cleanup);

  it('appends separate JSONL lines for each call', () => {
    logEvent(paths, 'dev', 'revops-global', 'action', 'first', 'info');
    logEvent(paths, 'dev', 'revops-global', 'error', 'second', 'error');
    logEvent(paths, 'dev', 'revops-global', 'task', 'third', 'warning');
    const lines = readEventLines(testRoot, 'dev');
    expect(lines).toHaveLength(3);
    expect(lines[0].event).toBe('first');
    expect(lines[1].event).toBe('second');
    expect(lines[2].event).toBe('third');
  });

  it('each line is independently valid JSON', () => {
    logEvent(paths, 'dev', 'revops-global', 'action', 'a', 'info');
    logEvent(paths, 'dev', 'revops-global', 'action', 'b', 'info');
    const file = join(testRoot, 'analytics', 'events', 'dev', `${todayDate()}.jsonl`);
    const rawLines = readFileSync(file, 'utf-8').trim().split('\n');
    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('logEvent — event ID uniqueness', () => {
  afterEach(cleanup);

  it('generates distinct IDs for rapid sequential calls', () => {
    // IDs use epoch-seconds + random suffix — same-second calls differ by random
    logEvent(paths, 'dev', 'revops-global', 'action', 'ev', 'info');
    logEvent(paths, 'dev', 'revops-global', 'action', 'ev', 'info');
    const lines = readEventLines(testRoot, 'dev');
    expect(lines[0].id).not.toBe(lines[1].id);
  });
});

describe('logEvent — validation', () => {
  afterEach(cleanup);

  it('throws on invalid category', () => {
    expect(() =>
      logEvent(paths, 'dev', 'org', 'bad_category' as never, 'ev', 'info'),
    ).toThrow();
  });

  it('throws on invalid severity', () => {
    expect(() =>
      logEvent(paths, 'dev', 'org', 'action', 'ev', 'bad_severity' as never),
    ).toThrow();
  });

  it('accepts all valid categories', () => {
    const categories = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval'] as const;
    for (const cat of categories) {
      expect(() => logEvent(paths, 'dev', 'org', cat, 'ev', 'info')).not.toThrow();
    }
  });

  it('accepts all valid severities', () => {
    const severities = ['info', 'warning', 'error', 'critical'] as const;
    for (const sev of severities) {
      expect(() => logEvent(paths, 'dev', 'org', 'action', 'ev', sev)).not.toThrow();
    }
  });
});

describe('logEvent — file path', () => {
  afterEach(cleanup);

  it('writes to analyticsDir/events/{agentName}/{YYYY-MM-DD}.jsonl', () => {
    logEvent(paths, 'analyst', 'revops-global', 'action', 'ev', 'info');
    const expected = join(testRoot, 'analytics', 'events', 'analyst', `${todayDate()}.jsonl`);
    expect(existsSync(expected)).toBe(true);
  });

  it('different agentNames write to separate files', () => {
    logEvent(paths, 'dev', 'revops-global', 'action', 'ev', 'info');
    logEvent(paths, 'analyst', 'revops-global', 'action', 'ev', 'info');
    expect(readEventLines(testRoot, 'dev')).toHaveLength(1);
    expect(readEventLines(testRoot, 'analyst')).toHaveLength(1);
  });
});

describe('logEvent — mirrorEventToRgos', () => {
  afterEach(cleanup);

  it('calls mirrorEventToRgos with the logged event payload', async () => {
    vi.clearAllMocks(); // clear any accumulated calls from prior tests' setImmediate callbacks
    logEvent(paths, 'dev', 'revops-global', 'action', 'mirror_test', 'info', { x: 1 });
    // mirrorEventToRgos is called via setImmediate — wait for next tick
    await new Promise(r => setImmediate(r));
    expect(mockMirror).toHaveBeenCalled();
    // Find the call for our specific event (other setImmediate callbacks may have fired too)
    const ourCall = mockMirror.mock.calls.find(([arg]) => arg.event === 'mirror_test');
    expect(ourCall).toBeDefined();
    const arg = ourCall![0];
    expect(arg.agent).toBe('dev');
    expect(arg.org).toBe('revops-global');
    expect(arg.category).toBe('action');
    expect(arg.event).toBe('mirror_test');
    expect((arg.metadata as Record<string, unknown>).x).toBe(1);
  });

  it('does not throw if mirrorEventToRgos rejects', async () => {
    mockMirror.mockRejectedValueOnce(new Error('supabase down'));
    expect(() =>
      logEvent(paths, 'dev', 'revops-global', 'action', 'ev', 'info'),
    ).not.toThrow();
    await new Promise(r => setImmediate(r));
    // No unhandled rejection — .catch(() => undefined) swallows it
  });
});

describe('logEvent — heartbeat refresh side-effect', () => {
  beforeEach(() => { mkdirSync(paths.stateDir, { recursive: true }); });
  afterEach(cleanup);

  it('bumps last_heartbeat on an existing heartbeat.json without overwriting other fields', async () => {
    const { writeFileSync } = await import('fs');
    const oldHeartbeat = {
      agent: 'dev',
      org: 'revops-global',
      status: 'online',
      current_task: 'fix/log-event-refreshes-heartbeat',
      mode: 'day',
      last_heartbeat: '2026-04-23T12:00:00Z',
      loop_interval: '4h',
    };
    writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(oldHeartbeat));
    await new Promise((resolve) => setTimeout(resolve, 2));
    logEvent(paths, 'dev', 'revops-global', 'action', 'activity_tick', 'info');
    const refreshed = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
    expect(new Date(refreshed.last_heartbeat).getTime()).toBeGreaterThan(
      new Date(oldHeartbeat.last_heartbeat).getTime(),
    );
    expect(refreshed.status).toBe('online');
    expect(refreshed.current_task).toBe('fix/log-event-refreshes-heartbeat');
    expect(refreshed.loop_interval).toBe('4h');
  });

  it('is a no-op when no heartbeat.json exists yet', () => {
    expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);
    logEvent(paths, 'dev', 'revops-global', 'action', 'first_boot', 'info');
    expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);
  });

  it('never blocks event persistence when the heartbeat refresh fails', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(paths.stateDir, 'heartbeat.json'), '{not valid json');
    expect(() =>
      logEvent(paths, 'dev', 'revops-global', 'action', 'after_corrupt_hb', 'info'),
    ).not.toThrow();
    const lines = readEventLines(testRoot, 'dev');
    expect(lines).toHaveLength(1);
  });
});
