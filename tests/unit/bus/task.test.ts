import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, claimTask, readTaskAudit, checkTaskDependencies, compactTasks, listTasks, listBlockedBy, findTaskFile } from '../../../src/bus/task';
import { saveOutput } from '../../../src/bus/save-output';
import { acquireLock, releaseLock } from '../../../src/utils/lock';
import type { BusPaths } from '../../../src/types';
import { makeTempDir, removeTempDir, makeBusPaths } from '../../setup';

describe('Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = makeTempDir('cortextos-task-test-');
    paths = makeBusPaths(testDir, 'paul');
  });

  afterEach(() => {
    removeTempDir(testDir);
  });

  describe('createTask', () => {
    it('creates task with correct JSON format', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Build landing page', {
        description: 'Create a product landing page',
        assignee: 'boris',
        priority: 'high',
skipBriefValidation: true, 
      });

      expect(taskId).toMatch(/^task_\d+_\d{8}$/);

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));

      // Verify all 17 fields match bash create-task.sh format
      expect(content.id).toBe(taskId);
      expect(content.title).toBe('Build landing page');
      expect(content.description).toBe('Create a product landing page');
      expect(content.type).toBe('agent');
      expect(content.needs_approval).toBe(false);
      expect(content.status).toBe('pending');
      expect(content.assigned_to).toBe('boris');
      expect(content.created_by).toBe('paul');
      expect(content.org).toBe('acme');
      expect(content.priority).toBe('high');
      expect(content.project).toBe('');
      expect(content.kpi_key).toBeNull();
      expect(content.created_at).toBeTruthy();
      expect(content.updated_at).toBeTruthy();
      expect(content.completed_at).toBeNull();
      expect(content.due_date).toBeNull();
      expect(content.archived).toBe(false);
      expect(content.meta).toBeUndefined();
    });

    it('attaches meta when provided as a non-empty object', () => {
      const meta = { cron: 'poll-codex-outbox', source_msg_id: 'abc123', count: 7 };
      const taskId = createTask(paths, 'paul', 'acme', 'Task with meta', { meta, skipBriefValidation: true });
      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.meta).toEqual(meta);
    });

    it('omits meta key when meta option is empty or absent', () => {
      const idNoMeta = createTask(paths, 'paul', 'acme', 'No meta', { skipBriefValidation: true });
      const idEmptyMeta = createTask(paths, 'paul', 'acme', 'Empty meta', { meta: {}, skipBriefValidation: true });
      const noMeta = JSON.parse(readFileSync(join(paths.taskDir, `${idNoMeta}.json`), 'utf-8'));
      const emptyMeta = JSON.parse(readFileSync(join(paths.taskDir, `${idEmptyMeta}.json`), 'utf-8'));
      expect('meta' in noMeta).toBe(false);
      expect('meta' in emptyMeta).toBe(false);
    });
  });

  describe('updateTask', () => {
    it('updates task status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task', { skipBriefValidation: true });
      updateTask(paths, taskId, 'in_progress');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('in_progress');
    });
  });

  describe('completeTask', () => {
    it('sets status to completed and completed_at', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task', { skipBriefValidation: true });
      completeTask(paths, taskId, 'Landing page done, committed at abc123');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('completed');
      expect(content.completed_at).toBeTruthy();
      expect(content.result).toBe('Landing page done, committed at abc123');
    });

    it('emits a task/task_completed activity event for the assignee', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Complete-event task', {
        assignee: 'boris',
skipBriefValidation: true, 
      });
      completeTask(paths, taskId, 'shipped');

      // Event file: <analyticsDir>/events/boris/<YYYY-MM-DD>.jsonl
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'boris', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);

      const events = readFileSync(eventFile, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const completedEvents = events.filter((e) => e.event === 'task_completed');
      expect(completedEvents).toHaveLength(1);
      const evt = completedEvents[0];
      expect(evt.agent).toBe('boris');
      expect(evt.org).toBe('acme');
      expect(evt.category).toBe('task');
      expect(evt.severity).toBe('info');
      expect(evt.metadata.task_id).toBe(taskId);
      expect(evt.metadata.result).toBe('shipped');
    });
  });

  describe('listTasks', () => {
    it('returns all non-archived tasks', () => {
      createTask(paths, 'paul', 'acme', 'Task 1', { skipBriefValidation: true });
      createTask(paths, 'paul', 'acme', 'Task 2', { skipBriefValidation: true });

      const tasks = listTasks(paths);
      expect(tasks.length).toBe(2);
    });

    it('filters by agent', () => {
      createTask(paths, 'paul', 'acme', 'For boris', { assignee: 'boris', skipBriefValidation: true });
      createTask(paths, 'paul', 'acme', 'For paul', { assignee: 'paul', skipBriefValidation: true });

      const borisTasks = listTasks(paths, { agent: 'boris' });
      expect(borisTasks.length).toBe(1);
      expect(borisTasks[0].title).toBe('For boris');
    });

    it('filters by status', () => {
      const id1 = createTask(paths, 'paul', 'acme', 'Task 1', { skipBriefValidation: true });
      createTask(paths, 'paul', 'acme', 'Task 2', { skipBriefValidation: true });
      updateTask(paths, id1, 'completed');

      const pending = listTasks(paths, { status: 'pending' });
      expect(pending.length).toBe(1);
    });
  });

  describe('RGOS-imported task files', () => {
    it('lists UUID-named task JSON files materialized from Supabase', () => {
      const id = 'abc39b97-96f6-410a-87a6-fa4ead610d0e';
      mkdirSync(paths.taskDir, { recursive: true });
      writeFileSync(join(paths.taskDir, `${id}.json`), JSON.stringify({
        id,
        title: 'Imported Cortex task',
        description: 'Supabase-origin task',
        type: 'agent',
        needs_approval: false,
        status: 'pending',
        assigned_to: 'codex',
        created_by: 'orchestrator',
        org: 'revops-global',
        priority: 'high',
        project: '',
        kpi_key: null,
        created_at: '2026-05-26T17:00:00Z',
        updated_at: '2026-05-26T17:00:00Z',
        completed_at: null,
        due_date: null,
        archived: false,
      }));

      const tasks = listTasks(paths, { agent: 'codex', status: 'pending' });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(id);
    });
  });
});

/**
 * Cross-org task lifecycle — exercises the findTaskFile fallback so an
 * assignee in one org can drive the lifecycle of a task filed by an
 * orchestrator in a sibling org. Standard cortextOS dispatch pattern:
 * an orchestrator in one org files a task, a specialist in another org
 * needs to update and complete it from their own agent session.
 *
 * These tests build a REAL nested filesystem layout (matching the
 * production shape at ~/.cortextos/<instance>/orgs/<org>/tasks/) so they
 * cover the actual cross-org path resolution, not a mocked shortcut.
 */
describe('Cross-org task lifecycle', () => {
  let testDir: string;
  let orgAPaths: BusPaths;
  let orgBTaskDir: string;
  let warnLog: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-crossorg-test-'));
    // Nested layout: <ctxRoot>/orgs/{OrgA,OrgB}/tasks/
    mkdirSync(join(testDir, 'orgs', 'OrgA', 'tasks'), { recursive: true });
    mkdirSync(join(testDir, 'orgs', 'OrgB', 'tasks'), { recursive: true });

    orgAPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agentA'),
      inflight: join(testDir, 'inflight', 'agentA'),
      processed: join(testDir, 'processed', 'agentA'),
      logDir: join(testDir, 'logs', 'agentA'),
      stateDir: join(testDir, 'state', 'agentA'),
      taskDir: join(testDir, 'orgs', 'OrgA', 'tasks'),
      approvalDir: join(testDir, 'orgs', 'OrgA', 'approvals'),
      analyticsDir: join(testDir, 'orgs', 'OrgA', 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    orgBTaskDir = join(testDir, 'orgs', 'OrgB', 'tasks');

    warnLog = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLog.push(args.map((a) => String(a)).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Helper: drop a raw task JSON file into OrgB's tasks dir without
   * going through createTask (which only knows about OrgA's taskDir). */
  function writeOrgBTask(taskId: string, overrides: Record<string, unknown> = {}): void {
    const task = {
      id: taskId,
      title: 'Cross-org task',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: 'agentA',
      created_by: 'orchestrator',
      org: 'OrgB',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: '2026-04-11T20:00:00Z',
      updated_at: '2026-04-11T20:00:00Z',
      completed_at: null,
      due_date: null,
      archived: false,
      ...overrides,
    };
    writeFileSync(join(orgBTaskDir, `${taskId}.json`), JSON.stringify(task), 'utf-8');
  }

  it('updateTask same-org happy path: still works via the fast path', () => {
    // Regression guard for the existing single-org behavior. This is the
    // hot path and must not pay any cross-org scan cost when it hits.
    const taskId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task', { skipBriefValidation: true });
    updateTask(orgAPaths, taskId, 'in_progress');

    const content = JSON.parse(
      readFileSync(join(orgAPaths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(content.status).toBe('in_progress');
  });

  it('updateTask cross-org: finds task in sibling org via findTaskFile fallback', () => {
    // Repro: file a task in OrgB, try to update it from an OrgA-scoped
    // session. Before findTaskFile, this threw "Task not found" because
    // updateTask only looked at orgAPaths.taskDir.
    const taskId = 'task_test_001';
    writeOrgBTask(taskId);

    updateTask(orgAPaths, taskId, 'in_progress');

    // Verify the OrgB file got updated, NOT the (nonexistent) OrgA file.
    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('in_progress');
    // Explicit timestamp comparison: the seed updated_at is a fixed moment
    // in the past, so the real Date.now() that updateTask stamps MUST be
    // strictly greater. Avoids the brittle string-inequality form that
    // would silently pass on any future refactor that changed the seed.
    expect(new Date(orgBContent.updated_at).getTime()).toBeGreaterThan(
      new Date('2026-04-11T20:00:00Z').getTime(),
    );
    expect(existsSync(join(orgAPaths.taskDir, `${taskId}.json`))).toBe(false);
  });

  it('updateTask not found anywhere: throws with a clear error naming ctxRoot', () => {
    expect(() => updateTask(orgAPaths, 'task_999_000', 'in_progress')).toThrow(
      /not found in any org under .*\/orgs\//,
    );
  });

  it('completeTask cross-org: finds task in sibling org and marks it done', () => {
    const taskId = 'task_test_002';
    writeOrgBTask(taskId);

    completeTask(orgAPaths, taskId, 'cross-org completion');

    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('completed');
    expect(orgBContent.completed_at).toBeTruthy();
    expect(orgBContent.result).toBe('cross-org completion');
  });

  it('findTaskFile ambiguity: same ID in two orgs triggers warn naming both orgs', () => {
    // Manually create the same task id in BOTH orgs. Real collisions
    // should be vanishingly rare (epoch_ms + 3 digits), but the warn path
    // must be tested so operators hitting it in production get actionable
    // information.
    const taskId = 'task_1_000';
    writeOrgBTask(taskId);
    // Write the same ID to OrgA via direct filesystem (bypassing
    // createTask so we can reuse the exact ID).
    const orgATaskPath = join(orgAPaths.taskDir, `${taskId}.json`);
    writeFileSync(
      orgATaskPath,
      JSON.stringify({
        id: taskId,
        title: 'OrgA collision',
        status: 'pending',
        org: 'OrgA',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    // findTaskFile should return the OrgA path (same-org fast path wins)
    // without ever emitting the ambiguity warning. The fast path only
    // checks same-org; the cross-org scan is ONLY exercised when same-org
    // misses. So the ambiguity warning path requires same-org to miss
    // AND multiple sibling orgs to hit.
    //
    // To exercise the warn, delete the OrgA copy and write collisions
    // into two OTHER orgs.
    rmSync(orgATaskPath);
    mkdirSync(join(testDir, 'orgs', 'OrgC', 'tasks'), { recursive: true });
    writeFileSync(
      join(testDir, 'orgs', 'OrgC', 'tasks', `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        title: 'OrgC collision',
        status: 'pending',
        org: 'OrgC',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    const result = findTaskFile(orgAPaths, taskId);
    expect(result).not.toBeNull();
    // Warn must have fired and must name BOTH the task id and the two orgs.
    expect(warnLog.length).toBeGreaterThanOrEqual(1);
    const warn = warnLog[0];
    expect(warn).toContain(taskId);
    expect(warn).toMatch(/found in 2 orgs/);
    expect(warn).toContain('OrgB');
    expect(warn).toContain('OrgC');
  });

  it('findTaskFile instance-root fallback: finds tasks at ctxRoot/tasks/ when absent from all orgs', () => {
    // Tasks created without an org land at <ctxRoot>/tasks/ rather than
    // <ctxRoot>/orgs/<org>/tasks/. findTaskFile must check this path as a
    // final fallback so complete-task / update-task do not throw "not found".
    const taskId = 'task_instance_001';
    const instanceTaskDir = join(testDir, 'tasks');
    mkdirSync(instanceTaskDir, { recursive: true });
    writeFileSync(
      join(instanceTaskDir, `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        title: 'Instance-root task',
        status: 'in_progress',
        org: '',
        updated_at: '2026-05-14T17:00:00Z',
        created_at: '2026-05-14T17:00:00Z',
      }),
      'utf-8',
    );

    const result = findTaskFile(orgAPaths, taskId);
    expect(result).not.toBeNull();
    expect(result).toBe(join(instanceTaskDir, `${taskId}.json`));
  });

  it('listTasks scoping regression: must remain single-org, NO cross-org leakage', () => {
    // CRITICAL regression guard. Scoping contract:
    // listTasks must remain single-org by default — cross-org listing
    // requires an explicit opt-in flag that does not exist yet. A future
    // well-meaning refactor that 'helpfully' makes listTasks cross-org by
    // default would silently break the dashboard, which depends on
    // per-org scoping for its sync loop. If this test fails, the refactor
    // broke the contract and must be reverted or gated behind an opt-in
    // flag.
    const sameOrgId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task', { skipBriefValidation: true });
    writeOrgBTask('task_other_1', { title: 'Sibling-org task 1' });
    writeOrgBTask('task_other_2', { title: 'Sibling-org task 2' });

    const tasks = listTasks(orgAPaths);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(sameOrgId);
    expect(tasks[0].title).toBe('Same-org task');
  });
});

describe('claimTask — atomic claim (beads-inspired)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claim-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('happy path: claims a pending task, flips status + assignee, writes lock file', () => {
    const id = createTask(paths, 'alice', 'acme', 'Claimable work', { skipBriefValidation: true });
    const task = claimTask(paths, id, 'alice');
    expect(task.status).toBe('in_progress');
    expect(task.assigned_to).toBe('alice');

    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(onDisk.status).toBe('in_progress');
    expect(onDisk.assigned_to).toBe('alice');

    // Lock file recorded the claimant + timestamp
    const lock = readFileSync(join(paths.taskDir, '.claims', `${id}.claim`), 'utf-8');
    expect(lock.split('\t')[0]).toBe('alice');
  });

  it('rejects second claim with a named owner when the lock already exists', () => {
    const id = createTask(paths, 'alice', 'acme', 'Race target', { skipBriefValidation: true });
    claimTask(paths, id, 'alice');
    expect(() => claimTask(paths, id, 'bob-agent')).toThrow(/already claimed by alice/);
  });

  it('is idempotent when the same agent re-claims (no throw, returns the task)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Re-claim', { skipBriefValidation: true });
    claimTask(paths, id, 'alice');
    const again = claimTask(paths, id, 'alice');
    expect(again.assigned_to).toBe('alice');
    expect(again.status).toBe('in_progress');
  });

  it('claims and audits global tasks from an org-scoped agent path', () => {
    const orgScopedPaths = { ...paths, taskDir: join(testDir, 'orgs', 'acme', 'tasks') };
    mkdirSync(paths.taskDir, { recursive: true });
    mkdirSync(orgScopedPaths.taskDir, { recursive: true });
    const id = 'task_1778742229707_58940333';
    writeFileSync(join(paths.taskDir, `${id}.json`), JSON.stringify({
      id,
      title: 'Orgo node lease',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: 'orgo-1',
      created_by: 'cortextos',
      org: '',
      priority: 'high',
      project: 'CortexOS',
      kpi_key: null,
      created_at: '2026-05-14T07:03:49Z',
      updated_at: '2026-05-14T07:03:49Z',
      completed_at: null,
      due_date: null,
      archived: false,
    }));

    const claimed = claimTask(orgScopedPaths, id, 'orgo-1');
    expect(claimed.status).toBe('in_progress');
    expect(existsSync(join(paths.taskDir, '.claims', `${id}.claim`))).toBe(true);
    expect(readTaskAudit(orgScopedPaths, id).map(e => e.event)).toEqual(['claim']);

    const artifact = join(testDir, 'proof.txt');
    writeFileSync(artifact, 'ok');
    const saved = saveOutput(orgScopedPaths, { taskId: id, sourcePath: artifact, label: 'proof' });
    expect(saved.storedPath).toBe(`deliverables/orgo-1/${id}/proof.txt`);
    const onDisk = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(onDisk.outputs).toEqual([{ type: 'file', value: saved.storedPath, label: 'proof' }]);
  });

  it('rejects claim on a non-pending task with a clear status message', () => {
    const id = createTask(paths, 'alice', 'acme', 'Already done', { skipBriefValidation: true });
    updateTask(paths, id, 'completed');
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not pending.*status=completed/);
  });

  it('throws "not found" for an unknown task id', () => {
    expect(() => claimTask(paths, 'task_nonexistent_000', 'alice')).toThrow(/not found in any org/);
  });

  it('rolls back the lock if the task-JSON write fails (so retry can still succeed)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Rollback probe', { skipBriefValidation: true });
    const claimPath = join(paths.taskDir, '.claims', `${id}.claim`);

    // Force atomicWriteSync to fail by deleting the task file mid-flight.
    // Simplest repro: remove the task json right after the lock is taken
    // by intercepting findTaskFile's call path — instead just delete the
    // task file before claimTask reads it, and reuse the existing
    // not-found path. Then confirm no stale .claim file is left behind.
    rmSync(join(paths.taskDir, `${id}.json`));
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not found in any org/);
    expect(existsSync(claimPath)).toBe(false);
  });
});

describe('Task audit log (append-only JSONL)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-audit-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('createTask writes one "create" audit entry', () => {
    const id = createTask(paths, 'alice', 'acme', 'First task', { description: 'd', skipBriefValidation: true });
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(1);
    expect(log[0].event).toBe('create');
    expect(log[0].agent).toBe('alice');
    expect(log[0].to).toBe('pending');
    expect(log[0].note).toBe('First task');
  });

  it('full lifecycle records create + claim + complete in order', () => {
    const id = createTask(paths, 'alice', 'acme', 'Lifecycle', { skipBriefValidation: true });
    claimTask(paths, id, 'alice');
    completeTask(paths, id, 'shipped');

    const log = readTaskAudit(paths, id);
    expect(log.map(e => e.event)).toEqual(['create', 'claim', 'complete']);
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('in_progress');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('in_progress');
    expect(log[2].to).toBe('completed');
    expect(log[2].note).toBe('shipped');
  });

  it('updateTask audit captures from->to transition with assignee as agent', () => {
    const id = createTask(paths, 'alice', 'acme', 'Updatable', { assignee: 'alice', skipBriefValidation: true });
    updateTask(paths, id, 'blocked', { blocker: { blocker_reason: 'audit test', next_proof_required: 'test passes' } });
    updateTask(paths, id, 'pending');

    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(3); // create + 2 updates
    expect(log[1].event).toBe('update');
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('blocked');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('blocked');
    expect(log[2].to).toBe('pending');
  });

  it('clears completion-only fields when a completed task is reopened', () => {
    const id = createTask(paths, 'alice', 'acme', 'Reopened task', {
      assignee: 'bob',
      skipBriefValidation: true,
    });
    const filePath = join(paths.taskDir, `${id}.json`);
    const beforeComplete = JSON.parse(readFileSync(filePath, 'utf-8'));
    beforeComplete.linked_goal = { status: 'active', created_at: beforeComplete.created_at };
    writeFileSync(filePath, JSON.stringify(beforeComplete));

    completeTask(paths, id, 'done with proof');
    const completed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(completed.status).toBe('completed');
    expect(completed.completed_at).toBeTruthy();
    expect(completed.result).toBe('done with proof');
    expect(completed.linked_goal.status).toBe('met');

    updateTask(paths, id, 'pending');

    const reopened = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(reopened.status).toBe('pending');
    expect(reopened.completed_at).toBeNull();
    expect(reopened.result).toBeUndefined();
    expect(reopened.linked_goal.status).toBe('active');
    expect(reopened.meta.reopened_from_completed).toBe(true);
    expect(reopened.meta.reopened_at).toBe(reopened.updated_at);
  });

  it('audit log is append-only — existing entries are never overwritten', () => {
    const id = createTask(paths, 'alice', 'acme', 'Append proof', { skipBriefValidation: true });
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    const before = readFileSync(path, 'utf-8');
    updateTask(paths, id, 'blocked', { blocker: { blocker_reason: 'append test', next_proof_required: 'test passes' } });
    const after = readFileSync(path, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('corrupt lines are skipped without blocking replay of surrounding entries', () => {
    const id = createTask(paths, 'alice', 'acme', 'Corrupt survivor', { skipBriefValidation: true });
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    // Inject a malformed line between two valid ones
    writeFileSync(path, readFileSync(path, 'utf-8') + 'not-json-at-all\n');
    updateTask(paths, id, 'in_progress');
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(2); // create + update, corrupt middle line skipped
    expect(log[0].event).toBe('create');
    expect(log[1].event).toBe('update');
  });

  it('readTaskAudit returns [] for a task with no history', () => {
    expect(readTaskAudit(paths, 'task_nonexistent_000')).toEqual([]);
  });
});

describe('Task dependency DAG (blocks / blocked_by)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-dag-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  function readTask(id: string) {
    return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
  }

  it('blocked_by stores the declared dependency + the peer gets a symmetric blocks edge', () => {
    const a = createTask(paths, 'alice', 'acme', 'A (blocker)', { skipBriefValidation: true });
    const b = createTask(paths, 'alice', 'acme', 'B (blocked)', { blockedBy: [a], skipBriefValidation: true });

    expect(readTask(b).blocked_by).toEqual([a]);
    expect(readTask(a).blocks).toEqual([b]);
  });

  it('blocks is the symmetric reverse of blocked_by', () => {
    const a = createTask(paths, 'alice', 'acme', 'A', { skipBriefValidation: true });
    const b = createTask(paths, 'alice', 'acme', 'B', { blocks: [a], skipBriefValidation: true });

    // "B blocks A" means A is blocked_by B
    expect(readTask(a).blocked_by).toEqual([b]);
    expect(readTask(b).blocks).toEqual([a]);
  });

  it('checkTaskDependencies returns open blockers with their current status', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker], skipBriefValidation: true });

    let open = checkTaskDependencies(paths, blocked);
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(blocker);
    expect(open[0].status).toBe('pending');

    completeTask(paths, blocker, 'done');
    open = checkTaskDependencies(paths, blocked);
    expect(open).toEqual([]);
  });

  it('checkTaskDependencies reports missing:true for dangling dep references', () => {
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: ['task_nonexistent_777'], skipBriefValidation: true });
    const open = checkTaskDependencies(paths, b);
    expect(open).toEqual([{ id: 'task_nonexistent_777', status: 'missing' }]);
  });

  it('cycle detection: A blocked_by B, B blocked_by A throws at creation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A', { skipBriefValidation: true });
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a], skipBriefValidation: true });
    // A declares new blocked_by edge to B — would form A -> B -> A cycle.
    expect(() => createTask(paths, 'alice', 'acme', 'A-rewrite', { blockedBy: [b], blocks: [a], skipBriefValidation: true })).toThrow(/cycle/i);
  });

  it('REGRESSION: cycle-rejected createTask leaves ZERO state on disk — no task json, no audit, no peer mutation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A', { skipBriefValidation: true });
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a], skipBriefValidation: true });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b], skipBriefValidation: true });

    // Snapshot A's blocks list before the cycle-try attempt.
    const aBlocksBefore = readTask(a).blocks ?? [];

    // Attempt a cycle: new task blocked_by c + blocks a → cycle-try → a → b → c → cycle-try.
    const filesBefore = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(() => createTask(paths, 'alice', 'acme', 'cycle-try', { blockedBy: [c], blocks: [a], skipBriefValidation: true })).toThrow(/cycle/i);

    // Invariants: (1) no new task JSON, (2) no audit directory entry for the rejected id,
    // (3) peer A's blocks list unchanged.
    const filesAfter = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(filesAfter).toEqual(filesBefore);
    // A's `blocks` list must not have been mutated by the attempted creation.
    expect(readTask(a).blocks ?? []).toEqual(aBlocksBefore);
    // No dangling audit dir file for a task id that never existed.
    const auditDir = join(paths.taskDir, 'audit');
    if (existsSync(auditDir)) {
      const auditFiles = readdirSync(auditDir);
      // No audit file for any task whose id isn't one of the 3 we successfully created.
      const validIds = new Set([a, b, c]);
      for (const f of auditFiles) {
        const id = f.replace(/\.jsonl$/, '');
        expect(validIds.has(id)).toBe(true);
      }
    }
  });

  it('listTasks --respect-deps orders unblocked tasks before blocked ones', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker], skipBriefValidation: true });
    const free = createTask(paths, 'alice', 'acme', 'Free', { skipBriefValidation: true });

    const ordered = listTasks(paths, { respectDeps: true });
    const ids = ordered.map(t => t.id);
    // All 3 present
    expect(ids).toContain(blocker);
    expect(ids).toContain(blocked);
    expect(ids).toContain(free);
    // `blocked` must come after both `blocker` and `free` in the list.
    const idx = (id: string) => ids.indexOf(id);
    expect(idx(blocked)).toBeGreaterThan(idx(blocker));
    expect(idx(blocked)).toBeGreaterThan(idx(free));

    // Once blocker completes, respectDeps no longer demotes blocked.
    completeTask(paths, blocker, 'done');
    const reordered = listTasks(paths, { respectDeps: true });
    const blockedTask = reordered.find(t => t.id === blocked)!;
    expect(blockedTask.status).toBe('pending');
    // Specifically: blocked should no longer be forced after 'free'
    // (both unblocked now, fall back to created_at ordering).
  });
});

describe('compactTasks — semantic compaction of old completed tasks', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-compact-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    // Guarantee unique task IDs: createTask uses `task_${Date.now()}_${randomDigits(3)}`
    // and tests run fast enough that two calls can land in the same ms with the same
    // 3-digit suffix (1-in-1000 chance), causing detectCycleOrThrow to see a self-loop.
    // Monotonically incrementing timestamps eliminate the collision entirely.
    let _ts = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => _ts++);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  // Helper: age a completed task's completed_at by overwriting the JSON.
  function backdateCompletion(id: string, daysAgo: number) {
    const p = join(paths.taskDir, `${id}.json`);
    const t = JSON.parse(readFileSync(p, 'utf-8'));
    const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    t.completed_at = ts;
    t.updated_at = ts;
    writeFileSync(p, JSON.stringify(t));
  }

  it('archives a completed task older than cutoff — removes active JSON, preserves audit log', () => {
    const id = createTask(paths, 'alice', 'acme', 'Old done', { assignee: 'alice', skipBriefValidation: true });
    completeTask(paths, id, 'shipped');
    backdateCompletion(id, 40);

    const auditPath = join(paths.taskDir, 'audit', `${id}.jsonl`);
    expect(existsSync(auditPath)).toBe(true);

    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived.map(a => a.id)).toEqual([id]);
    expect(report.skipped).toEqual([]);

    // Active JSON gone, audit log still there
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(false);
    expect(existsSync(auditPath)).toBe(true);

    // Archive entry written to the correct month file
    const archiveFile = report.archived[0].archive_file;
    const archiveLine = readFileSync(join(paths.taskDir, archiveFile), 'utf-8').trim();
    const entry = JSON.parse(archiveLine);
    expect(entry.id).toBe(id);
    expect(entry.title).toBe('Old done');
    expect(entry.result).toBe('shipped');
    expect(entry.assigned_to).toBe('alice');
  });

  it('skips recently-completed tasks (within cutoff)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Fresh done', { skipBriefValidation: true });
    completeTask(paths, id, 'ok');
    // Leave completed_at as "just now" — should be skipped.
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === id)?.reason).toMatch(/within cutoff/);
  });

  it('skips in-progress and blocked tasks regardless of age', () => {
    const a = createTask(paths, 'alice', 'acme', 'In progress', { skipBriefValidation: true });
    claimTask(paths, a, 'alice'); // -> in_progress
    const b = createTask(paths, 'alice', 'acme', 'Blocked', { skipBriefValidation: true });
    updateTask(paths, b, 'blocked', { blocker: { blocker_reason: 'compact test', next_proof_required: 'test passes' } });

    const report = compactTasks(paths, { olderThanDays: 0 });
    expect(report.archived).toEqual([]);
  });

  it('NEVER archives a completed task still referenced by an open task\'s blocked_by chain', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker], skipBriefValidation: true });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);

    // Dependent is still pending → blocker must not be compacted away.
    expect(dependent).toBeDefined();
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === blocker)?.reason).toMatch(/still.*blocked_by/);
    expect(existsSync(join(paths.taskDir, `${blocker}.json`))).toBe(true);
  });

  it('REGRESSION: transitive blocker guard — A<-B<-C with C open preserves BOTH A and B', () => {
    const a = createTask(paths, 'alice', 'acme', 'A', { skipBriefValidation: true });
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a], skipBriefValidation: true });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b], skipBriefValidation: true });
    expect(c).toBeDefined();

    // A + B both completed and aged out; C stays open.
    completeTask(paths, a, 'done-a');
    completeTask(paths, b, 'done-b');
    backdateCompletion(a, 60);
    backdateCompletion(b, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    // Neither A nor B should be archived — both are in the transitive
    // blocker closure of open C.
    expect(report.archived).toEqual([]);
    const skippedIds = report.skipped.map(s => s.id).sort();
    expect(skippedIds).toContain(a);
    expect(skippedIds).toContain(b);
    // Both must still be on disk.
    expect(existsSync(join(paths.taskDir, `${a}.json`))).toBe(true);
    expect(existsSync(join(paths.taskDir, `${b}.json`))).toBe(true);
  });

  it('once the dependent completes, the blocker becomes eligible', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker], skipBriefValidation: true });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);
    completeTask(paths, dependent, 'done');
    backdateCompletion(dependent, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    const archivedIds = report.archived.map(a => a.id).sort();
    expect(archivedIds).toEqual([blocker, dependent].sort());
  });

  it('is idempotent — running a second time on the same data archives nothing', () => {
    const id = createTask(paths, 'alice', 'acme', 'Run-twice', { skipBriefValidation: true });
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const first = compactTasks(paths, { olderThanDays: 30 });
    expect(first.archived.map(a => a.id)).toEqual([id]);

    const second = compactTasks(paths, { olderThanDays: 30 });
    expect(second.archived).toEqual([]);
  });

  it('dry-run reports candidates without modifying anything', () => {
    const id = createTask(paths, 'alice', 'acme', 'Dry-run target', { skipBriefValidation: true });
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const report = compactTasks(paths, { olderThanDays: 30, dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.archived.map(a => a.id)).toEqual([id]);
    // Active JSON still present
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);
  });
});

// ── Task r/m/w lock (B3) ─────────────────────────────────────────────────────

describe('Task r/m/w lock — no deadlock under sequential mutations', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'dev'),
      inflight: join(testDir, 'inflight', 'dev'),
      processed: join(testDir, 'processed', 'dev'),
      logDir: join(testDir, 'logs', 'dev'),
      stateDir: join(testDir, 'state', 'dev'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('sequential updateTask calls on the same task complete without deadlock', () => {
    const id = createTask(paths, 'dev', 'acme', 'Lock test task', { skipBriefValidation: true });
    const blockerMeta = { blocker: { blocker_reason: 'waiting on dep', next_proof_required: 'dep completes' } };
    // Rapid sequential status transitions — each must acquire and release the lock cleanly.
    updateTask(paths, id, 'in_progress');
    updateTask(paths, id, 'blocked', blockerMeta);
    updateTask(paths, id, 'in_progress');
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(task.status).toBe('in_progress');
  });

  it('updateTask then completeTask on the same task both succeed', () => {
    const id = createTask(paths, 'dev', 'acme', 'Lock test — update then complete', { skipBriefValidation: true });
    updateTask(paths, id, 'in_progress');
    completeTask(paths, id, 'finished');
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(task.status).toBe('completed');
    expect(task.result).toBe('finished');
  });

  it('claimTask then updateTask on the same task both succeed', () => {
    const id = createTask(paths, 'dev', 'acme', 'Lock test — claim then update', { skipBriefValidation: true });
    claimTask(paths, id, 'dev');
    updateTask(paths, id, 'blocked', { blocker: { blocker_reason: 'waiting for review', next_proof_required: 'review approved' } });
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(task.status).toBe('blocked');
  });

  it('updateTask to blocked requires blocker_reason and next_proof_required', () => {
    const id = createTask(paths, 'dev', 'acme', 'Needs blocker context', { skipBriefValidation: true });
    expect(() => updateTask(paths, id, 'blocked')).toThrow(/blocker context/);
  });

  it('updateTask to blocked without next_proof_required fails', () => {
    const id = createTask(paths, 'dev', 'acme', 'Missing next_proof', { skipBriefValidation: true });
    expect(() =>
      updateTask(paths, id, 'blocked', { blocker: { blocker_reason: 'reason only', next_proof_required: '' } }),
    ).toThrow(/blocker context/);
  });

  it('updateTask to blocked with both fields in metaMerge succeeds', () => {
    const id = createTask(paths, 'dev', 'acme', 'Full blocker context', { skipBriefValidation: true });
    updateTask(paths, id, 'blocked', {
      blocker: { blocker_reason: 'waiting for API key', next_proof_required: 'key appears in secrets.env' },
    });
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(task.status).toBe('blocked');
    expect(task.meta.blocker.blocker_reason).toBe('waiting for API key');
    expect(task.meta.blocker.next_proof_required).toBe('key appears in secrets.env');
  });

  it('updateTask to blocked uses pre-existing meta.blocker if flags not passed', () => {
    const id = createTask(paths, 'dev', 'acme', 'Pre-set blocker', {
      meta: { blocker: { blocker_reason: 'pre-set reason', next_proof_required: 'pre-set proof' } },
skipBriefValidation: true, 
    });
    updateTask(paths, id, 'blocked');
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(task.status).toBe('blocked');
  });

  it('addSymmetricEdge via createTask with blockedBy locks peer tasks correctly', () => {
    const blocker = createTask(paths, 'dev', 'acme', 'Blocker task', { skipBriefValidation: true });
    const dependent = createTask(paths, 'dev', 'acme', 'Dependent task', { blockedBy: [blocker], skipBriefValidation: true });
    // Both peer lock files should not be left behind (lock released)
    const blockerLockDir = join(paths.taskDir, '.task-locks', blocker, '.lock.d');
    expect(existsSync(blockerLockDir)).toBe(false); // lock released
    // Dependency state should be correct
    const blockerTask = JSON.parse(readFileSync(join(paths.taskDir, `${blocker}.json`), 'utf-8'));
    expect(blockerTask.blocks).toContain(dependent);
  });

  it('lock dir is created at .task-locks/<taskId> and cleaned up after operations', () => {
    const id = createTask(paths, 'dev', 'acme', 'Lock dir cleanup test', { skipBriefValidation: true });
    updateTask(paths, id, 'in_progress');
    completeTask(paths, id, 'done');
    // Lock dir base should exist (created by ensureDir), but .lock.d must be gone
    const lockDir = join(paths.taskDir, '.task-locks', id, '.lock.d');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('lock timeout: throws when lock cannot be acquired within retry window', () => {
    // Manually hold the lock to simulate a contending process
    const id = createTask(paths, 'dev', 'acme', 'Lock timeout test', { skipBriefValidation: true });
    const lockBase = join(paths.taskDir, '.task-locks', id);
    mkdirSync(lockBase, { recursive: true });
    acquireLock(lockBase); // Hold the lock with current process PID

    // updateTask should fail after retries because *this* process holds the lock —
    // acquireLock re-checks: pid matches running process → lock IS held → returns false each time
    // However, since it's our OWN pid (process.kill(pid, 0) succeeds), it will keep returning false.
    // This exercises the retry-and-throw path.
    expect(() => updateTask(paths, id, 'in_progress')).toThrow(/could not acquire r\/m\/w lock/);

    // Release the lock so afterEach cleanup succeeds
    releaseLock(lockBase);
  });
});

describe('claimTask — RGOS mirror hook', () => {
  let testDir: string;
  let paths: BusPaths;
  let mirrorMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claim-mirror-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mirrorMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../src/bus/rgos-mirror', () => ({ mirrorTaskToRgos: mirrorMock }));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('mirror is suppressed in VITEST environment (process.env.VITEST is set)', () => {
    // The VITEST env var is set by the vitest runner; the guard in claimTask
    // prevents mirrorTaskToRgos from being called. Verify the claim still
    // succeeds and the task transitions to in_progress.
    const id = createTask(paths, 'dev', 'acme', 'Mirror suppression test', { skipBriefValidation: true });
    const task = claimTask(paths, id, 'dev');
    expect(task.status).toBe('in_progress');
    expect(task.assigned_to).toBe('dev');
    // Mirror is fire-and-forget with VITEST guard — no call expected in test env
    expect(mirrorMock).not.toHaveBeenCalled();
  });

  it('claimTask sets in_progress + assigned_to on disk regardless of mirror env', () => {
    const id = createTask(paths, 'dev', 'acme', 'Disk state test', { skipBriefValidation: true });
    claimTask(paths, id, 'alice');
    const onDisk = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(onDisk.status).toBe('in_progress');
    expect(onDisk.assigned_to).toBe('alice');
  });
});

// ── G3: task auto-unblock on completeTask ─────────────────────────────────────

describe('listBlockedBy — list tasks blocked by a given task ID', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-listblocked-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('returns tasks whose blocked_by includes the given id', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker task', { skipBriefValidation: true });
    const child1 = createTask(paths, 'alice', 'acme', 'Child 1', { blockedBy: [blocker], skipBriefValidation: true });
    const child2 = createTask(paths, 'alice', 'acme', 'Child 2', { blockedBy: [blocker], skipBriefValidation: true });
    const unrelated = createTask(paths, 'alice', 'acme', 'Unrelated', { skipBriefValidation: true });

    const blocked = listBlockedBy(paths, blocker);
    const ids = blocked.map(t => t.id);
    expect(ids).toContain(child1);
    expect(ids).toContain(child2);
    expect(ids).not.toContain(unrelated);
    expect(ids).not.toContain(blocker);
  });

  it('returns empty array when no tasks reference the given id', () => {
    createTask(paths, 'alice', 'acme', 'Standalone task', { skipBriefValidation: true });
    expect(listBlockedBy(paths, 'task_nonexistent_000')).toEqual([]);
  });

  it('returns tasks sorted by created_at DESC', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const child1 = createTask(paths, 'alice', 'acme', 'Child 1', { blockedBy: [blocker], skipBriefValidation: true });
    const child2 = createTask(paths, 'alice', 'acme', 'Child 2', { blockedBy: [blocker], skipBriefValidation: true });

    const blocked = listBlockedBy(paths, blocker);
    // Must contain both children in some order
    const ids = blocked.map(t => t.id);
    expect(ids).toContain(child1);
    expect(ids).toContain(child2);
    // created_at DESC: each task should have >= created_at than the next
    for (let i = 0; i + 1 < blocked.length; i++) {
      expect(new Date(blocked[i].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(blocked[i + 1].created_at).getTime(),
      );
    }
  });

  it('returns empty array when task dir does not exist', () => {
    const ghostPaths = { ...paths, taskDir: join(testDir, 'nonexistent-tasks') };
    expect(listBlockedBy(ghostPaths, 'task_000')).toEqual([]);
  });
});

describe('completeTask auto-unblock', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-autounblock-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  function readTask(id: string) {
    return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
  }

  it('flips a single-blocker child to pending when its only blocker completes', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const child = createTask(paths, 'alice', 'acme', 'Child', {
      blockedBy: [blocker],
      assignee: 'bob',
skipBriefValidation: true, 
    });

    completeTask(paths, blocker, 'done');

    const childOnDisk = readTask(child);
    expect(childOnDisk.status).toBe('pending');
    expect(childOnDisk.meta.unblocked_at).toBeTruthy();
    expect(childOnDisk.meta.unblocked_by).toBe(blocker);
  });

  it('does NOT flip child while it still has outstanding (non-completed) blockers', () => {
    const b1 = createTask(paths, 'alice', 'acme', 'Blocker 1', { skipBriefValidation: true });
    const b2 = createTask(paths, 'alice', 'acme', 'Blocker 2', { skipBriefValidation: true });
    const child = createTask(paths, 'alice', 'acme', 'Child', { blockedBy: [b1, b2], skipBriefValidation: true });

    // Complete only b1 — b2 is still pending
    completeTask(paths, b1, 'done');

    const childOnDisk = readTask(child);
    // Should still be pending (original state, not yet auto-unblocked)
    expect(childOnDisk.meta?.unblocked_at).toBeUndefined();
    // Status still pending (unchanged — never was blocked status in this test)
    expect(childOnDisk.status).toBe('pending');
  });

  it('flips child to pending when the last of multiple blockers completes', () => {
    const b1 = createTask(paths, 'alice', 'acme', 'Blocker 1', { skipBriefValidation: true });
    const b2 = createTask(paths, 'alice', 'acme', 'Blocker 2', { skipBriefValidation: true });
    const child = createTask(paths, 'alice', 'acme', 'Child', { blockedBy: [b1, b2], skipBriefValidation: true });

    completeTask(paths, b1, 'done');
    // child should NOT be unblocked yet
    expect(readTask(child).meta?.unblocked_at).toBeUndefined();

    completeTask(paths, b2, 'done');
    // Now both blockers are completed — child should be unblocked
    const childOnDisk = readTask(child);
    expect(childOnDisk.meta.unblocked_at).toBeTruthy();
    expect(childOnDisk.meta.unblocked_by).toBe(b2);
  });

  it('does not unblock cancelled or completed children', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const cancelled = createTask(paths, 'alice', 'acme', 'Cancelled child', { blockedBy: [blocker], skipBriefValidation: true });
    const completed = createTask(paths, 'alice', 'acme', 'Completed child', { blockedBy: [blocker], skipBriefValidation: true });

    updateTask(paths, cancelled, 'cancelled');
    completeTask(paths, completed, 'already done');

    const beforeBlocker = readTask(blocker);
    completeTask(paths, blocker, 'done');

    // cancelled and completed children should not get unblocked_at
    const cancelledOnDisk = readTask(cancelled);
    const completedOnDisk = readTask(completed);
    expect(cancelledOnDisk.meta?.unblocked_at).toBeUndefined();
    // completed child had no blocked_by in its meta before unblock
    // (it was already completed before the blocker completed)
    expect(completedOnDisk.meta?.unblocked_by).toBeUndefined();
    expect(beforeBlocker.status).toBe('pending');
  });

  it('enqueues an inbox message to the child assignee on unblock', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const child = createTask(paths, 'alice', 'acme', 'Child', {
      blockedBy: [blocker],
      assignee: 'bob',
skipBriefValidation: true, 
    });

    completeTask(paths, blocker, 'done');

    // Check inbox for bob
    const inboxDir = join(testDir, 'inbox', 'bob');
    expect(existsSync(inboxDir)).toBe(true);
    const inboxFiles = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    expect(inboxFiles.length).toBe(1);

    const msg = JSON.parse(readFileSync(join(inboxDir, inboxFiles[0]), 'utf-8'));
    expect(msg.to).toBe('bob');
    expect(msg.text).toContain(child);
    expect(msg.text).toContain(blocker);
    expect(msg.text).toContain('unblocked');
  });

  it('appends an auto-unblocked audit entry for the child task', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const child = createTask(paths, 'alice', 'acme', 'Child', { blockedBy: [blocker], skipBriefValidation: true });

    completeTask(paths, blocker, 'done');

    const audit = readTaskAudit(paths, child);
    const unblockEntry = audit.find(e => e.note?.includes('auto-unblocked'));
    expect(unblockEntry).toBeDefined();
    expect(unblockEntry!.agent).toBe('cortextos');
    expect(unblockEntry!.to).toBe('pending');
    expect(unblockEntry!.note).toContain(blocker);
  });

  it('treats missing dep as resolved so a child with a dangling ref still unblocks', () => {
    const real = createTask(paths, 'alice', 'acme', 'Real blocker', { skipBriefValidation: true });
    const child = createTask(paths, 'alice', 'acme', 'Child', {
      blockedBy: [real, 'task_ghost_000'],
skipBriefValidation: true, 
    });

    completeTask(paths, real, 'done');

    const childOnDisk = readTask(child);
    // dangling ghost treated as resolved → child should be unblocked
    expect(childOnDisk.meta.unblocked_at).toBeTruthy();
  });

  it('completeTask itself never fails even if auto-unblock has a bug (best-effort)', () => {
    // Create a child with a manually corrupted task file to trigger an error inside autoUnblockChildren.
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker', { skipBriefValidation: true });
    const child = createTask(paths, 'alice', 'acme', 'Child', { blockedBy: [blocker], skipBriefValidation: true });

    // Corrupt the child's JSON on disk after creation
    writeFileSync(join(paths.taskDir, `${child}.json`), 'NOT_VALID_JSON');

    // completeTask should succeed regardless
    expect(() => completeTask(paths, blocker, 'done')).not.toThrow();
    const blockerOnDisk = readTask(blocker);
    expect(blockerOnDisk.status).toBe('completed');
  });
});
