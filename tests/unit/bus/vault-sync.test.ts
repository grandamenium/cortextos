import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { vaultWriteTask, vaultMoveTask, vaultArchiveTask } from '../../../src/bus/vault-sync';
import type { Task } from '../../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1234567890_abcde',
    title: 'Sample task',
    status: 'pending',
    priority: 'normal',
    assigned_to: 'alice',
    created_by: 'bob',
    created_at: '2026-05-18T12:00:00Z',
    updated_at: '2026-05-18T12:00:00Z',
    org: 'TestOrg',
    description: 'A test task',
    ...overrides,
  } as Task;
}

describe('vault-sync', () => {
  let frameworkRoot: string;
  let vaultRoot: string;
  const origEnv = process.env.CTX_FRAMEWORK_ROOT;

  beforeEach(() => {
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-vault-test-'));
    vaultRoot = join(frameworkRoot, 'obsidian-vault');
    mkdirSync(vaultRoot, { recursive: true });
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  });

  afterEach(() => {
    rmSync(frameworkRoot, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = origEnv;
  });

  describe('vaultWriteTask', () => {
    it('writes task markdown to obsidian-vault/<agent>/tasks/open/ for pending status', () => {
      const task = makeTask({ status: 'pending' });
      vaultWriteTask(task);
      const expected = join(vaultRoot, 'alice', 'tasks', 'open', `${task.id}.md`);
      expect(existsSync(expected)).toBe(true);
      const content = readFileSync(expected, 'utf-8');
      expect(content).toContain('type: task');
      expect(content).toContain(`task_id: ${task.id}`);
      expect(content).toContain('status: pending');
      expect(content).toContain('Sample task');
    });

    it('places in-progress tasks in tasks/in-progress/', () => {
      const task = makeTask({ status: 'in_progress' });
      vaultWriteTask(task);
      expect(existsSync(join(vaultRoot, 'alice', 'tasks', 'in-progress', `${task.id}.md`))).toBe(true);
    });

    it('places completed tasks in tasks/completed/', () => {
      const task = makeTask({ status: 'completed' });
      vaultWriteTask(task);
      expect(existsSync(join(vaultRoot, 'alice', 'tasks', 'completed', `${task.id}.md`))).toBe(true);
    });

    it('uses "unassigned" agent directory when assigned_to is missing', () => {
      const task = makeTask({ assigned_to: undefined });
      vaultWriteTask(task);
      expect(existsSync(join(vaultRoot, 'unassigned', 'tasks', 'open', `${task.id}.md`))).toBe(true);
    });

    it('silently skips when CTX_FRAMEWORK_ROOT is unset (best-effort)', () => {
      delete process.env.CTX_FRAMEWORK_ROOT;
      const task = makeTask();
      expect(() => vaultWriteTask(task)).not.toThrow();
      expect(existsSync(join(vaultRoot, 'alice'))).toBe(false);
    });

    it('silently skips when obsidian-vault dir does not exist (best-effort)', () => {
      rmSync(vaultRoot, { recursive: true, force: true });
      const task = makeTask();
      expect(() => vaultWriteTask(task)).not.toThrow();
    });

    it('does not throw on write failure (best-effort)', () => {
      const task = makeTask({ id: 'task_bad/path/segment' });
      expect(() => vaultWriteTask(task)).not.toThrow();
    });
  });

  describe('vaultMoveTask', () => {
    it('moves file from open to in-progress folder on status transition', () => {
      const task = makeTask({ status: 'pending' });
      vaultWriteTask(task);
      const oldPath = join(vaultRoot, 'alice', 'tasks', 'open', `${task.id}.md`);
      expect(existsSync(oldPath)).toBe(true);

      const updated = makeTask({ status: 'in_progress' });
      vaultMoveTask(updated, 'pending');

      const newPath = join(vaultRoot, 'alice', 'tasks', 'in-progress', `${task.id}.md`);
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(newPath, 'utf-8')).toContain('status: in_progress');
    });

    it('overwrites in place when oldStatus and newStatus map to same folder', () => {
      // cancelled and completed both map to 'completed' folder
      const task = makeTask({ status: 'completed' });
      vaultWriteTask(task);
      const path = join(vaultRoot, 'alice', 'tasks', 'completed', `${task.id}.md`);
      const originalMtime = readFileSync(path, 'utf-8').length;

      const updated = makeTask({ status: 'cancelled', result: 'VERIFIED: done' });
      vaultMoveTask(updated, 'completed');

      expect(existsSync(path)).toBe(true);
      const newContent = readFileSync(path, 'utf-8');
      expect(newContent.length).toBeGreaterThan(originalMtime);
      expect(newContent).toContain('VERIFIED: done');
    });

    it('writes new file even if source missing (idempotent recovery)', () => {
      const task = makeTask({ status: 'completed' });
      vaultMoveTask(task, 'in_progress');
      const newPath = join(vaultRoot, 'alice', 'tasks', 'completed', `${task.id}.md`);
      expect(existsSync(newPath)).toBe(true);
    });

    it('silently skips when CTX_FRAMEWORK_ROOT unset', () => {
      delete process.env.CTX_FRAMEWORK_ROOT;
      const task = makeTask({ status: 'in_progress' });
      expect(() => vaultMoveTask(task, 'pending')).not.toThrow();
    });
  });

  describe('vaultArchiveTask', () => {
    it('moves a completed task into the archive subfolder', () => {
      const task = makeTask({ status: 'completed' });
      vaultWriteTask(task);
      const completedPath = join(vaultRoot, 'alice', 'tasks', 'completed', `${task.id}.md`);
      expect(existsSync(completedPath)).toBe(true);

      vaultArchiveTask(task.id, 'alice');

      const archivePath = join(vaultRoot, 'alice', 'tasks', 'archive', `${task.id}.md`);
      expect(existsSync(completedPath)).toBe(false);
      expect(existsSync(archivePath)).toBe(true);
    });

    it('is a no-op if the completed file does not exist (best-effort)', () => {
      expect(() => vaultArchiveTask('task_missing', 'alice')).not.toThrow();
      expect(existsSync(join(vaultRoot, 'alice', 'tasks', 'archive'))).toBe(false);
    });

    it('silently skips when CTX_FRAMEWORK_ROOT unset', () => {
      delete process.env.CTX_FRAMEWORK_ROOT;
      expect(() => vaultArchiveTask('task_any', 'alice')).not.toThrow();
    });
  });
});
