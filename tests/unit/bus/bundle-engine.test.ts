import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, listTasks, selectAndClaimNext } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

/**
 * Feature-bundle engine (Phase 1): bundle_id/role on tasks, the listTasks
 * bundle filter, and selectAndClaimNext / `claim-next --bundle` — the primitive
 * that makes agents pull COORDINATED bundle work instead of isolated tasks.
 */
describe('feature-bundle engine', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bundle-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agent1'),
      inflight: join(testDir, 'inflight', 'agent1'),
      processed: join(testDir, 'processed', 'agent1'),
      logDir: join(testDir, 'logs', 'agent1'),
      stateDir: join(testDir, 'state', 'agent1'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('createTask persists bundle_id + role', () => {
    const id = createTask(paths, 'agent1', 'testorg', 'patient slice', { bundle: 'B1', role: 'patient' });
    const t = listTasks(paths).find((x) => x.id === id);
    expect(t?.bundle_id).toBe('B1');
    expect(t?.role).toBe('patient');
  });

  it('listTasks filters by bundle exactly (not prefix)', () => {
    createTask(paths, 'agent1', 'testorg', 'b1 a', { bundle: 'B1' });
    createTask(paths, 'agent1', 'testorg', 'b1 b', { bundle: 'B1' });
    createTask(paths, 'agent1', 'testorg', 'b2', { bundle: 'B2' });
    createTask(paths, 'agent1', 'testorg', 'no bundle', {});
    expect(listTasks(paths, { bundle: 'B1' })).toHaveLength(2);
    expect(listTasks(paths, { bundle: 'B2' })).toHaveLength(1);
  });

  it('claim-next claims only tasks of the given bundle, then returns null when drained', () => {
    createTask(paths, 'agent1', 'testorg', 'b1 a', { bundle: 'B1' });
    createTask(paths, 'agent1', 'testorg', 'b1 b', { bundle: 'B1' });
    createTask(paths, 'agent1', 'testorg', 'other', { bundle: 'B2' });
    createTask(paths, 'agent1', 'testorg', 'orphan', {});

    const first = selectAndClaimNext(paths, 'builder', { bundle: 'B1' });
    const second = selectAndClaimNext(paths, 'builder', { bundle: 'B1' });
    const third = selectAndClaimNext(paths, 'builder', { bundle: 'B1' });

    expect(first?.bundle_id).toBe('B1');
    expect(first?.status).toBe('in_progress');
    expect(first?.assigned_to).toBe('builder');
    expect(second?.bundle_id).toBe('B1');
    expect(second?.id).not.toBe(first?.id);
    expect(third).toBeNull(); // bundle drained — never grabs B2 or the orphan
  });

  it('claim-next --role narrows to one role within the bundle', () => {
    createTask(paths, 'agent1', 'testorg', 'doc slice', { bundle: 'B1', role: 'doctor' });
    createTask(paths, 'agent1', 'testorg', 'pharm slice', { bundle: 'B1', role: 'pharmacy' });

    const claimed = selectAndClaimNext(paths, 'doc-agent', { bundle: 'B1', role: 'doctor' });
    expect(claimed?.role).toBe('doctor');

    // No more doctor sub-tasks; pharmacy one is untouched.
    expect(selectAndClaimNext(paths, 'doc-agent', { bundle: 'B1', role: 'doctor' })).toBeNull();
    expect(listTasks(paths, { bundle: 'B1', status: 'pending' })).toHaveLength(1);
  });

  it('claim-next skips a bundle task whose dependency is not yet completed', () => {
    const blocker = createTask(paths, 'agent1', 'testorg', 'schema first', { bundle: 'B1', role: 'manufacturer' });
    createTask(paths, 'agent1', 'testorg', 'ui after schema', { bundle: 'B1', role: 'pharmacy', blockedBy: [blocker] });

    // Only the unblocked (manufacturer) task is claimable; the blocked one is skipped.
    const a = selectAndClaimNext(paths, 'builder', { bundle: 'B1' });
    expect(a?.id).toBe(blocker);
    const b = selectAndClaimNext(paths, 'builder', { bundle: 'B1' });
    expect(b).toBeNull(); // the dependent task stays blocked until the blocker completes
  });
});
