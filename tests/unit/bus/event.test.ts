import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logEvent } from '../../../src/bus/event';
import type { BusPaths } from '../../../src/types';

let testDir: string;

function mkPaths(root: string): BusPaths {
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

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-event-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function readTodayEvents(root: string, agent: string): string[] {
  const today = new Date().toISOString().split('T')[0];
  const eventFile = join(root, 'analytics', 'events', agent, `${today}.jsonl`);
  return readFileSync(eventFile, 'utf-8').trim().split('\n');
}

describe('logEvent', () => {
  it('creates date-keyed event file and writes a valid JSONL line', () => {
    const paths = mkPaths(testDir);
    logEvent(paths, 'test-agent', 'glv', 'heartbeat', 'agent_heartbeat', 'info');

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(testDir, 'analytics', 'events', 'test-agent', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);

    const line = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(line.agent).toBe('test-agent');
    expect(line.org).toBe('glv');
    expect(line.category).toBe('heartbeat');
    expect(line.event).toBe('agent_heartbeat');
    expect(line.severity).toBe('info');
    expect(typeof line.timestamp).toBe('string');
  });

  it('event id has format {epoch}-{agentName}-{rand5}', () => {
    const paths = mkPaths(testDir);
    const before = Math.floor(Date.now() / 1000);
    logEvent(paths, 'my-agent', 'glv', 'action', 'do_thing', 'info');
    const after = Math.floor(Date.now() / 1000);

    const line = JSON.parse(readTodayEvents(testDir, 'my-agent')[0]);
    expect(line.id).toMatch(/^\d+-my-agent-[a-z0-9]{5}$/);

    const epoch = parseInt(line.id.split('-')[0], 10);
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(after);
  });

  it('stores object metadata in the event', () => {
    const paths = mkPaths(testDir);
    logEvent(paths, 'test-agent', 'glv', 'metric', 'collect', 'info', { count: 5, key: 'val' });

    const line = JSON.parse(readTodayEvents(testDir, 'test-agent')[0]);
    expect(line.metadata).toEqual({ count: 5, key: 'val' });
  });

  it('parses string metadata when it is valid JSON', () => {
    const paths = mkPaths(testDir);
    logEvent(paths, 'test-agent', 'glv', 'action', 'test', 'info', '{"source":"cli","count":3}');

    const line = JSON.parse(readTodayEvents(testDir, 'test-agent')[0]);
    expect(line.metadata).toEqual({ source: 'cli', count: 3 });
  });

  it('stores empty metadata when string is not valid JSON', () => {
    const paths = mkPaths(testDir);
    logEvent(paths, 'test-agent', 'glv', 'action', 'test', 'info', 'not-valid-json');

    const line = JSON.parse(readTodayEvents(testDir, 'test-agent')[0]);
    expect(line.metadata).toEqual({});
  });

  it('stores empty metadata when metadata is undefined', () => {
    const paths = mkPaths(testDir);
    logEvent(paths, 'test-agent', 'glv', 'action', 'test', 'info');

    const line = JSON.parse(readTodayEvents(testDir, 'test-agent')[0]);
    expect(line.metadata).toEqual({});
  });

  it('appends each call as a separate JSONL line', () => {
    const paths = mkPaths(testDir);
    logEvent(paths, 'test-agent', 'glv', 'heartbeat', 'first', 'info');
    logEvent(paths, 'test-agent', 'glv', 'heartbeat', 'second', 'warning');

    const lines = readTodayEvents(testDir, 'test-agent');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('first');
    expect(JSON.parse(lines[1]).event).toBe('second');
  });

  it('throws on invalid category', () => {
    const paths = mkPaths(testDir);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logEvent(paths, 'test-agent', 'glv', 'invalid_cat' as any, 'test', 'info'),
    ).toThrow(/Invalid event category/);
  });

  it('throws on invalid severity', () => {
    const paths = mkPaths(testDir);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logEvent(paths, 'test-agent', 'glv', 'action', 'test', 'debug' as any),
    ).toThrow(/Invalid severity/);
  });
});
