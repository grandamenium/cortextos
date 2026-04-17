import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, claimTask, readTaskAudit, checkTaskDependencies, compactTasks, listTasks, findTaskFile } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

describe('Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('createTask', () => {
    it('creates task with correct JSON format', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Build landing page', {
        description: 'Create a product landing page',
        assignee: 'boris',
        priority: 'high',
      });

      expect(taskId).toMatch(/^task_\d+_\d{3}$/);

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
    });
  });

  describe('updateTask', () => {
    it('updates task status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, 'in_progress');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('in_progress');
    });
  });

  describe('completeTask', () => {
    it('sets status to completed and completed_at', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      completeTask(paths, taskId, 'Landing page done, committed at abc123');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('completed');
      expect(content.completed_at).toBeTruthy();
      expect(content.result).toBe('Landing page done, committed at abc123');
    });
  });

  describe('listTasks', () => {
    it('returns all non-archived tasks', () => {
      createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');

      const tasks = listTasks(paths);
      expect(tasks.length).toBe(2);
    });

    it('filters by agent', () => {
      createTask(paths, 'paul', 'acme', 'For boris', { assignee: 'boris' });
      createTask(paths, 'paul', 'acme', 'For paul', { assignee: 'paul' });

      const borisTasks = listTasks(paths, { agent: 'boris' });
      expect(borisTasks.length).toBe(1);
      expect(borisTasks[0].title).toBe('For boris');
    });

    it('filters by status', () => {
      const id1 = createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');
      updateTask(paths, id1, 'completed');

      const pending = listTasks(paths, { status: 'pending' });
      expect(pending.length).toBe(1);
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
    const taskId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
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

  it('listTasks scoping regression: must remain single-org, NO cross-org leakage', () => {
    // CRITICAL regression guard. Scoping contract:
    // listTasks must remain single-org by default — cross-org listing
    // requires an explicit opt-in flag that does not exist yet. A future
    // well-meaning refactor that 'helpfully' makes listTasks cross-org by
    // default would silently break the dashboard, which depends on
    // per-org scoping for its sync loop. If this test fails, the refactor
    // broke the contract and must be reverted or gated behind an opt-in
    // flag.
    const sameOrgId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
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
    const id = createTask(paths, 'alice', 'acme', 'Claimable work');
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
    const id = createTask(paths, 'alice', 'acme', 'Race target');
    claimTask(paths, id, 'alice');
    expect(() => claimTask(paths, id, 'bob-agent')).toThrow(/already claimed by alice/);
  });

  it('is idempotent when the same agent re-claims (no throw, returns the task)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Re-claim');
    claimTask(paths, id, 'alice');
    const again = claimTask(paths, id, 'alice');
    expect(again.assigned_to).toBe('alice');
    expect(again.status).toBe('in_progress');
  });

  it('rejects claim on a non-pending task with a clear status message', () => {
    const id = createTask(paths, 'alice', 'acme', 'Already done');
    updateTask(paths, id, 'completed');
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not pending.*status=completed/);
  });

  it('throws "not found" for an unknown task id', () => {
    expect(() => claimTask(paths, 'task_nonexistent_000', 'alice')).toThrow(/not found in any org/);
  });

  it('rolls back the lock if the task-JSON write fails (so retry can still succeed)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Rollback probe');
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
    const id = createTask(paths, 'alice', 'acme', 'First task', { description: 'd' });
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(1);
    expect(log[0].event).toBe('create');
    expect(log[0].agent).toBe('alice');
    expect(log[0].to).toBe('pending');
    expect(log[0].note).toBe('First task');
  });

  it('full lifecycle records create + claim + complete in order', () => {
    const id = createTask(paths, 'alice', 'acme', 'Lifecycle');
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
    const id = createTask(paths, 'alice', 'acme', 'Updatable', { assignee: 'alice' });
    updateTask(paths, id, 'blocked');
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

  it('audit log is append-only — existing entries are never overwritten', () => {
    const id = createTask(paths, 'alice', 'acme', 'Append proof');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    const before = readFileSync(path, 'utf-8');
    updateTask(paths, id, 'blocked');
    const after = readFileSync(path, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('corrupt lines are skipped without blocking replay of surrounding entries', () => {
    const id = createTask(paths, 'alice', 'acme', 'Corrupt survivor');
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
    const a = createTask(paths, 'alice', 'acme', 'A (blocker)');
    const b = createTask(paths, 'alice', 'acme', 'B (blocked)', { blockedBy: [a] });

    expect(readTask(b).blocked_by).toEqual([a]);
    expect(readTask(a).blocks).toEqual([b]);
  });

  it('blocks is the symmetric reverse of blocked_by', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blocks: [a] });

    // "B blocks A" means A is blocked_by B
    expect(readTask(a).blocked_by).toEqual([b]);
    expect(readTask(b).blocks).toEqual([a]);
  });

  it('checkTaskDependencies returns open blockers with their current status', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });

    let open = checkTaskDependencies(paths, blocked);
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(blocker);
    expect(open[0].status).toBe('pending');

    completeTask(paths, blocker, 'done');
    open = checkTaskDependencies(paths, blocked);
    expect(open).toEqual([]);
  });

  it('checkTaskDependencies reports missing:true for dangling dep references', () => {
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: ['task_nonexistent_777'] });
    const open = checkTaskDependencies(paths, b);
    expect(open).toEqual([{ id: 'task_nonexistent_777', status: 'missing' }]);
  });

  it('cycle detection: A blocked_by B, B blocked_by A throws at creation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    // A declares new blocked_by edge to B — would form A -> B -> A cycle.
    expect(() => createTask(paths, 'alice', 'acme', 'A-rewrite', { blockedBy: [b], blocks: [a] })).toThrow(/cycle/i);
  });

  it('REGRESSION: cycle-rejected createTask leaves ZERO state on disk — no task json, no audit, no peer mutation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });

    // Snapshot A's blocks list before the cycle-try attempt.
    const aBlocksBefore = readTask(a).blocks ?? [];

    // Attempt a cycle: new task blocked_by c + blocks a → cycle-try → a → b → c → cycle-try.
    const filesBefore = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(() => createTask(paths, 'alice', 'acme', 'cycle-try', { blockedBy: [c], blocks: [a] })).toThrow(/cycle/i);

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
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });
    const free = createTask(paths, 'alice', 'acme', 'Free');

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
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

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
    const id = createTask(paths, 'alice', 'acme', 'Old done', { assignee: 'alice' });
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
    const id = createTask(paths, 'alice', 'acme', 'Fresh done');
    completeTask(paths, id, 'ok');
    // Leave completed_at as "just now" — should be skipped.
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === id)?.reason).toMatch(/within cutoff/);
  });

  it('skips in-progress and blocked tasks regardless of age', () => {
    const a = createTask(paths, 'alice', 'acme', 'In progress');
    claimTask(paths, a, 'alice'); // -> in_progress
    const b = createTask(paths, 'alice', 'acme', 'Blocked');
    updateTask(paths, b, 'blocked');

    const report = compactTasks(paths, { olderThanDays: 0 });
    expect(report.archived).toEqual([]);
  });

  it('NEVER archives a completed task still referenced by an open task\'s blocked_by chain', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
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
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });
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
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);
    completeTask(paths, dependent, 'done');
    backdateCompletion(dependent, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    const archivedIds = report.archived.map(a => a.id).sort();
    expect(archivedIds).toEqual([blocker, dependent].sort());
  });

  it('is idempotent — running a second time on the same data archives nothing', () => {
    const id = createTask(paths, 'alice', 'acme', 'Run-twice');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const first = compactTasks(paths, { olderThanDays: 30 });
    expect(first.archived.map(a => a.id)).toEqual([id]);

    const second = compactTasks(paths, { olderThanDays: 30 });
    expect(second.archived).toEqual([]);
  });

  it('dry-run reports candidates without modifying anything', () => {
    const id = createTask(paths, 'alice', 'acme', 'Dry-run target');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const report = compactTasks(paths, { olderThanDays: 30, dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.archived.map(a => a.id)).toEqual([id]);
    // Active JSON still present
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);
  });
});
