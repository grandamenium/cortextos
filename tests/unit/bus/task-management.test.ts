import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, checkStaleTasks, archiveTasks, checkHumanTasks } from '../../../src/bus/task';
import { atomicWriteSync, ensureDir } from '../../../src/utils/atomic';
import type { BusPaths, Task } from '../../../src/types';

/**
 * Helper to create a task with a backdated timestamp.
 * Writes a task JSON directly with manipulated dates.
 */
function createBackdatedTask(
  paths: BusPaths,
  overrides: Partial<Task> & { id: string },
): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const task: Task = {
    id: overrides.id,
    title: overrides.title ?? 'Test task',
    description: overrides.description ?? '',
    type: overrides.type ?? 'agent',
    needs_approval: overrides.needs_approval ?? false,
    status: overrides.status ?? 'pending',
    assigned_to: overrides.assigned_to ?? 'agent1',
    created_by: overrides.created_by ?? 'agent1',
    org: overrides.org ?? 'testorg',
    priority: overrides.priority ?? 'normal',
    project: overrides.project ?? '',
    kpi_key: overrides.kpi_key ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    completed_at: overrides.completed_at ?? null,
    due_date: overrides.due_date ?? null,
    archived: overrides.archived ?? false,
  };
  atomicWriteSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
}

function hoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 3600 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function daysAgo(days: number): string {
  return hoursAgo(days * 24);
}

/** Write a heartbeat.json for an agent under <ctxRoot>/state/<agent>/. */
function writeHeartbeat(
  paths: BusPaths,
  agent: string,
  lastHeartbeat: string,
  loopInterval = '2h',
): void {
  const dir = join(paths.ctxRoot, 'state', agent);
  ensureDir(dir);
  atomicWriteSync(
    join(dir, 'heartbeat.json'),
    JSON.stringify({
      agent,
      org: 'testorg',
      status: 'online',
      current_task: '',
      mode: 'day',
      last_heartbeat: lastHeartbeat,
      loop_interval: loopInterval,
    }),
  );
}

describe('Advanced Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-taskmgmt-test-'));
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

  describe('checkStaleTasks', () => {
    it('identifies stale in_progress tasks (>2h)', () => {
      createBackdatedTask(paths, {
        id: 'task_001_001',
        title: 'Stale in progress',
        status: 'in_progress',
        updated_at: hoursAgo(3), // 3 hours ago
        created_at: hoursAgo(5),
      });
      createBackdatedTask(paths, {
        id: 'task_002_002',
        title: 'Fresh in progress',
        status: 'in_progress',
        updated_at: hoursAgo(1), // 1 hour ago
        created_at: hoursAgo(1),
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.length).toBe(1);
      expect(report.stale_in_progress[0].id).toBe('task_001_001');
    });

    it('identifies stale pending tasks (>24h)', () => {
      createBackdatedTask(paths, {
        id: 'task_003_003',
        title: 'Stale pending',
        status: 'pending',
        created_at: hoursAgo(25), // 25 hours ago
        updated_at: hoursAgo(25),
      });
      createBackdatedTask(paths, {
        id: 'task_004_004',
        title: 'Fresh pending',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_pending.length).toBe(1);
      expect(report.stale_pending[0].id).toBe('task_003_003');
    });

    it('identifies overdue tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_005_005',
        title: 'Overdue task',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
        due_date: daysAgo(1), // due yesterday
      });
      createBackdatedTask(paths, {
        id: 'task_006_006',
        title: 'Future task',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
        due_date: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), // due tomorrow
      });

      const report = checkStaleTasks(paths);
      expect(report.overdue.length).toBe(1);
      expect(report.overdue[0].id).toBe('task_005_005');
    });

    it('suppresses long-lived (>3d) in_progress when the assignee heartbeat is fresh', () => {
      // Umbrella/epic task: in_progress for days by design, on a live agent.
      createBackdatedTask(paths, {
        id: 'task_020_020',
        title: 'Launch epic',
        status: 'in_progress',
        assigned_to: 'epicagent',
        updated_at: hoursAgo(6),
        created_at: daysAgo(6),
      });
      writeHeartbeat(paths, 'epicagent', hoursAgo(1), '2h'); // fresh: 1h < 2x2h=4h

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.map((t) => t.id)).not.toContain('task_020_020');
    });

    it('still flags long-lived in_progress when the assignee heartbeat is stale', () => {
      createBackdatedTask(paths, {
        id: 'task_021_021',
        title: 'Stalled epic',
        status: 'in_progress',
        assigned_to: 'deadagent',
        updated_at: hoursAgo(6),
        created_at: daysAgo(6),
      });
      writeHeartbeat(paths, 'deadagent', hoursAgo(10), '2h'); // stale: 10h > 2x2h=4h

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.map((t) => t.id)).toContain('task_021_021');
    });

    it('still flags long-lived in_progress when the assignee has no heartbeat', () => {
      createBackdatedTask(paths, {
        id: 'task_022_022',
        title: 'Orphan epic',
        status: 'in_progress',
        assigned_to: 'ghostagent',
        updated_at: hoursAgo(6),
        created_at: daysAgo(6),
      });
      // No heartbeat written — no proof of life, so do not suppress.
      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.map((t) => t.id)).toContain('task_022_022');
    });

    it('still flags short-lived (>2h, <3d) in_progress even on a fresh-heartbeat agent', () => {
      // Not long-lived: could be a forgotten task, so the live agent should still be nudged.
      createBackdatedTask(paths, {
        id: 'task_023_023',
        title: 'Forgotten task',
        status: 'in_progress',
        assigned_to: 'liveagent',
        updated_at: hoursAgo(3),
        created_at: hoursAgo(5),
      });
      writeHeartbeat(paths, 'liveagent', hoursAgo(1), '2h');

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.map((t) => t.id)).toContain('task_023_023');
    });

    it('skips completed tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_007_007',
        title: 'Done task',
        status: 'completed',
        created_at: hoursAgo(48),
        updated_at: hoursAgo(48),
        completed_at: hoursAgo(48),
        due_date: daysAgo(1), // overdue but completed
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.length).toBe(0);
      expect(report.stale_pending.length).toBe(0);
      expect(report.stale_human.length).toBe(0);
      expect(report.overdue.length).toBe(0);
    });
  });

  describe('archiveTasks', () => {
    it('moves old completed tasks to archive/', () => {
      createBackdatedTask(paths, {
        id: 'task_010_010',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8), // completed 8 days ago, > 7 day threshold
      });

      const report = archiveTasks(paths);
      expect(report.archived).toBe(1);
      expect(report.dry_run).toBe(false);

      // File should be moved to archive/
      expect(existsSync(join(paths.taskDir, 'task_010_010.json'))).toBe(false);
      expect(existsSync(join(paths.taskDir, 'archive', 'task_010_010.json'))).toBe(true);
    });

    it('dry-run does not modify files', () => {
      createBackdatedTask(paths, {
        id: 'task_011_011',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8),
      });

      const report = archiveTasks(paths, true);
      expect(report.archived).toBe(1);
      expect(report.dry_run).toBe(true);

      // File should still be in original location
      expect(existsSync(join(paths.taskDir, 'task_011_011.json'))).toBe(true);
      expect(existsSync(join(paths.taskDir, 'archive'))).toBe(false);
    });

    it('adds archived:true field', () => {
      createBackdatedTask(paths, {
        id: 'task_012_012',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8),
      });

      archiveTasks(paths);

      const archivedContent = readFileSync(
        join(paths.taskDir, 'archive', 'task_012_012.json'),
        'utf-8',
      );
      const task = JSON.parse(archivedContent);
      expect(task.archived).toBe(true);
    });
  });

  describe('checkHumanTasks', () => {
    it('finds human-assigned stale tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_020_020',
        title: 'Human task old',
        status: 'pending',
        assigned_to: 'human',
        created_at: hoursAgo(25),
        updated_at: hoursAgo(25),
      });
      createBackdatedTask(paths, {
        id: 'task_021_021',
        title: 'User task old',
        status: 'in_progress',
        assigned_to: 'user',
        created_at: hoursAgo(30),
        updated_at: hoursAgo(30),
      });
      createBackdatedTask(paths, {
        id: 'task_022_022',
        title: 'Human task fresh',
        status: 'pending',
        assigned_to: 'human',
        created_at: hoursAgo(1), // only 1 hour old
        updated_at: hoursAgo(1),
      });
      createBackdatedTask(paths, {
        id: 'task_023_023',
        title: 'Agent task old',
        status: 'pending',
        assigned_to: 'agent1',
        created_at: hoursAgo(25),
        updated_at: hoursAgo(25),
      });

      const humanTasks = checkHumanTasks(paths);
      expect(humanTasks.length).toBe(2);
      const ids = humanTasks.map(t => t.id).sort();
      expect(ids).toEqual(['task_020_020', 'task_021_021']);
    });
  });
});
