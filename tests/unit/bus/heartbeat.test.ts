/**
 * Path B watchdog (watchdog-threshold-tuning spec) — Phase 1 state persistence.
 *
 * Verifies updateHeartbeat manages `task_started_at` with the right semantics
 * to support the upcoming task-stuck watcher leg:
 *   - empty current_task → task_started_at = null
 *   - first write with non-empty current_task → task_started_at = now
 *   - current_task unchanged → task_started_at preserved
 *   - current_task transitions to a different non-empty value → re-stamped to now
 *   - side-channel event-log refresh preserves task_started_at (event.ts
 *     code path is tested separately, but the on-disk shape is checked here
 *     to confirm refreshHeartbeatTimestamp's JSON roundtrip carries the field)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateHeartbeat, setHeartbeatCurrentTask } from '../../../src/bus/heartbeat';
import type { BusPaths, Heartbeat } from '../../../src/types';

function makePaths(testDir: string, agent: string = 'test-agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}

function readHeartbeat(paths: BusPaths): Heartbeat {
  return JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
}

describe('updateHeartbeat — task_started_at (Path B Phase 1)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-hb-test-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('sets task_started_at=null when current_task is empty', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: '' });
    expect(readHeartbeat(paths).task_started_at).toBeNull();
  });

  it('sets task_started_at=null when currentTask is omitted', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online');
    expect(readHeartbeat(paths).task_started_at).toBeNull();
  });

  it('stamps task_started_at on first write with non-empty current_task', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const hb = readHeartbeat(paths);
    expect(hb.task_started_at).toBe('2026-05-15T20:00:00Z');
    // On a fresh transition both fields share the same stamp; this equality
    // only holds at stamp time, not as a general invariant (see preserve-test
    // below where last_heartbeat ticks past task_started_at).
    expect(hb.task_started_at).toBe(hb.last_heartbeat);
  });

  it('preserves task_started_at when current_task is unchanged across writes', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const stamped = readHeartbeat(paths).task_started_at;
    expect(stamped).toBe('2026-05-15T20:00:00Z');

    vi.advanceTimersByTime(5 * 60_000); // +5 min
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const hb2 = readHeartbeat(paths);
    expect(hb2.task_started_at).toBe(stamped); // preserved
    expect(hb2.last_heartbeat).toBe('2026-05-15T20:05:00Z'); // advanced
    expect(hb2.last_heartbeat).not.toBe(hb2.task_started_at);
  });

  it('re-stamps task_started_at when current_task transitions to a different value', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });

    vi.advanceTimersByTime(10 * 60_000); // +10 min
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-B' });
    const hb = readHeartbeat(paths);
    expect(hb.task_started_at).toBe('2026-05-15T20:10:00Z');
  });

  it('clears task_started_at to null on transition to empty current_task', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    expect(readHeartbeat(paths).task_started_at).toBeTruthy();

    vi.advanceTimersByTime(60_000);
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: '' });
    expect(readHeartbeat(paths).task_started_at).toBeNull();
  });

  it('re-stamps task_started_at on null → non-empty transition (idle → working)', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online');
    expect(readHeartbeat(paths).task_started_at).toBeNull();

    vi.advanceTimersByTime(30 * 60_000); // +30 min idle
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    expect(readHeartbeat(paths).task_started_at).toBe('2026-05-15T20:30:00Z');
  });

  it('treats a heartbeat written by an older version (no task_started_at) as a transition and stamps on next write', () => {
    const paths = makePaths(testDir);
    mkdirSync(paths.stateDir, { recursive: true });
    // Synthesize a legacy heartbeat file with no task_started_at field.
    writeFileSync(
      join(paths.stateDir, 'heartbeat.json'),
      JSON.stringify({
        agent: 'test-agent',
        org: '',
        status: 'online',
        current_task: 'task-A',
        mode: 'day',
        last_heartbeat: '2026-05-15T19:00:00Z',
        loop_interval: '',
      }),
    );
    // Same current_task on next write — the helper falls back to fallbackTs
    // because the prior heartbeat didn't carry the field.
    updateHeartbeat(paths, 'test-agent', 'online', { currentTask: 'task-A' });
    const hb = readHeartbeat(paths);
    expect(hb.task_started_at).toBe('2026-05-15T20:00:00Z');
    expect(hb.last_heartbeat).toBe('2026-05-15T20:00:00Z');
  });
});

describe('setHeartbeatCurrentTask — Path B writer wiring', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-hb-task-test-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('is a no-op when no prior heartbeat exists', () => {
    const paths = makePaths(testDir);
    setHeartbeatCurrentTask(paths, 'test-agent', 'task-A');
    // No prior → we don't synthesize one (timezone unknown). File not created.
    expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);
  });

  it('stamps current_task + task_started_at on the prior heartbeat', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { org: 'acme' });
    expect(readHeartbeat(paths).current_task).toBe('');

    vi.advanceTimersByTime(60_000);
    setHeartbeatCurrentTask(paths, 'test-agent', 'task_1778881_xyz');
    const hb = readHeartbeat(paths);
    expect(hb.current_task).toBe('task_1778881_xyz');
    expect(hb.task_started_at).toBe('2026-05-15T20:01:00Z');
    // Status is preserved from the prior heartbeat.
    expect(hb.status).toBe('online');
    expect(hb.org).toBe('acme');
  });

  it('clears current_task + task_started_at when newTask is empty', () => {
    const paths = makePaths(testDir);
    updateHeartbeat(paths, 'test-agent', 'online', { org: 'acme', currentTask: 'task-A' });
    expect(readHeartbeat(paths).current_task).toBe('task-A');

    vi.advanceTimersByTime(60_000);
    setHeartbeatCurrentTask(paths, 'test-agent', '');
    const hb = readHeartbeat(paths);
    expect(hb.current_task).toBe('');
    expect(hb.task_started_at).toBeNull();
  });

  it('re-stamps task_started_at when transitioning between distinct tasks', () => {
    const paths = makePaths(testDir);
    setHeartbeatCurrentTask(paths, 'test-agent', 'task-A'); // no-op (no prior)
    updateHeartbeat(paths, 'test-agent', 'online', { org: 'acme', currentTask: 'task-A' });
    const stampedA = readHeartbeat(paths).task_started_at;

    vi.advanceTimersByTime(5 * 60_000);
    setHeartbeatCurrentTask(paths, 'test-agent', 'task-B');
    const hb = readHeartbeat(paths);
    expect(hb.current_task).toBe('task-B');
    expect(hb.task_started_at).not.toBe(stampedA);
    expect(hb.task_started_at).toBe('2026-05-15T20:05:00Z');
  });
});
