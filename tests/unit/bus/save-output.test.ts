import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveOutput } from '../../../src/bus/save-output';
import type { BusPaths } from '../../../src/types';

describe('saveOutput path-traversal hardening (#13)', () => {
  let dir: string;
  let paths: BusPaths;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-saveout-'));
    paths = {
      ctxRoot: dir,
      taskDir: join(dir, 'tasks'),
      deliverablesDir: join(dir, 'deliverables'),
      inbox: join(dir, 'inbox'),
      inflight: join(dir, 'inflight'),
      processed: join(dir, 'processed'),
      logDir: join(dir, 'logs'),
      stateDir: join(dir, 'state'),
      approvalDir: join(dir, 'approvals'),
      analyticsDir: join(dir, 'analytics'),
      heartbeatDir: join(dir, 'heartbeats'),
    } as BusPaths;
    mkdirSync(paths.taskDir, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects a traversal taskId before any path is built', () => {
    const src = join(dir, 'out.txt');
    writeFileSync(src, 'x');
    expect(() => saveOutput(paths, { sourcePath: src, taskId: '../../etc/passwd' }))
      .toThrow(/Invalid task id/);
  });

  it('rejects a tampered assigned_to that would escape the deliverables tree', () => {
    const src = join(dir, 'out.txt');
    writeFileSync(src, 'x');
    const taskId = 'task_1_001';
    // A task file whose assigned_to carries traversal — must not build a path out of the tree.
    writeFileSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify({ id: taskId, assigned_to: '../../../etc' }));
    expect(() => saveOutput(paths, { sourcePath: src, taskId }))
      .toThrow(/Invalid agent name/);
  });

  it('saves a deliverable for a legitimate task + assignee', () => {
    const src = join(dir, 'report.md');
    writeFileSync(src, '# hi');
    const taskId = 'task_2_002';
    writeFileSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify({ id: taskId, assigned_to: 'boris', outputs: [] }));
    const res = saveOutput(paths, { sourcePath: src, taskId });
    expect(res.linked).toBe(true);
    expect(res.storedPath).toContain('boris');
    expect(res.storedPath).toContain(taskId);
  });
});
