import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { Task, Priority, TaskStatus, BusPaths, StaleTaskReport, ArchiveReport } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomDigits } from '../utils/random.js';
import { validatePriority } from '../utils/validate.js';

/**
 * Create a new task. Identical JSON format to bash create-task.sh.
 */
export function createTask(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  options: {
    description?: string;
    assignee?: string;
    priority?: Priority;
    project?: string;
    needsApproval?: boolean;
    dueDate?: string;
    blockedBy?: string[];
    blocks?: string[];
  } = {},
): string {
  const {
    description = '',
    assignee = agentName,
    priority = 'normal',
    project = '',
    needsApproval = false,
    dueDate = '',
    blockedBy = [],
    blocks = [],
  } = options;

  validatePriority(priority);

  const epoch = Date.now();
  const rand = randomDigits(3);
  const taskId = `task_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Dependency validation FIRST — a cycle must never be allowed to
  // leave partial state on disk. Earlier iteration wrote the task
  // JSON before detectCycleOrThrow ran, so a failed cycle check left
  // a dangling task with a one-way edge and no symmetric peer update.
  // Order is now: validate → write task → mutate peers → audit. The
  // cycle walker gets a `virtual` description of the not-yet-written
  // task so chains that pass through it are still detectable.
  const virtualTask = { id: taskId, blocked_by: blockedBy };
  if (blockedBy.length) detectCycleOrThrow(paths, taskId, blockedBy, virtualTask);
  if (blocks.length) {
    for (const downId of blocks) detectCycleOrThrow(paths, downId, [taskId], virtualTask);
  }

  const task: Task = {
    id: taskId,
    title,
    description,
    type: 'agent',
    needs_approval: needsApproval,
    status: 'pending',
    assigned_to: assignee,
    created_by: agentName,
    org,
    priority,
    project,
    kpi_key: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    due_date: dueDate || null,
    archived: false,
    ...(blockedBy.length ? { blocked_by: [...blockedBy] } : {}),
    ...(blocks.length ? { blocks: [...blocks] } : {}),
  };

  ensureDir(paths.taskDir);
  atomicWriteSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify(task));

  // Cycle-safe now: validation already passed, so symmetric-edge
  // maintenance is just mutating peer JSONs.
  for (const depId of blockedBy) addSymmetricEdge(paths, depId, 'blocks', taskId);
  for (const downId of blocks) addSymmetricEdge(paths, downId, 'blocked_by', taskId);

  appendTaskAudit(paths, taskId, { event: 'create', agent: agentName, to: 'pending', note: title });

  return taskId;
}

/**
 * Mutate an existing task to add an edge to its blocks/blocked_by list.
 * No-op if the peer id is already present. Used to maintain symmetric
 * edges when a new task declares its dependencies.
 */
function addSymmetricEdge(
  paths: BusPaths,
  taskId: string,
  field: 'blocks' | 'blocked_by',
  peerId: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return; // Peer task missing — surfaced at resolution time.
  try {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
    const list = task[field] ?? [];
    if (!list.includes(peerId)) {
      task[field] = [...list, peerId];
      atomicWriteSync(filePath, JSON.stringify(task));
    }
  } catch { /* best-effort */ }
}

/**
 * Walk the dependency DAG rooted at `newTaskId` depth-first along its
 * proposed `blocked_by` edges and throw if the walk re-enters
 * `newTaskId`. Only checks the `blocked_by` direction — cycles are
 * topologically symmetric, so walking one direction catches them all.
 *
 * `virtual` lets the caller describe a task that does not yet exist
 * on disk (the task being created). Without this, running the check
 * BEFORE the task JSON is written would miss cycles that pass
 * through the new task itself.
 */
function detectCycleOrThrow(
  paths: BusPaths,
  newTaskId: string,
  initialBlockers: string[],
  virtual?: { id: string; blocked_by: string[] },
): void {
  const seen = new Set<string>();
  const stack = [...initialBlockers];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === newTaskId) {
      throw new Error(`Dependency cycle: ${newTaskId} ultimately blocks itself via ${cur}`);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (virtual && cur === virtual.id) {
      if (virtual.blocked_by.length) stack.push(...virtual.blocked_by);
      continue;
    }
    const filePath = findTaskFile(paths, cur);
    if (!filePath) continue; // Missing peer is not a cycle, just a dangling ref.
    try {
      const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
      if (task.blocked_by?.length) stack.push(...task.blocked_by);
    } catch { /* skip */ }
  }
}

/**
 * Resolve blockers for `taskId`: returns the list of tasks in its
 * `blocked_by` that are NOT yet completed. Empty list = good to go.
 * A missing peer is reported as `{ id, status: 'missing' }` so callers
 * can distinguish "dependency cleared" from "dependency references a
 * task that no longer exists".
 */
export function checkTaskDependencies(
  paths: BusPaths,
  taskId: string,
): Array<{ id: string; status: TaskStatus | 'missing' }> {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return [];
  let task: Task;
  try { task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task; }
  catch { return []; }
  const deps = task.blocked_by ?? [];
  const open: Array<{ id: string; status: TaskStatus | 'missing' }> = [];
  for (const depId of deps) {
    const depPath = findTaskFile(paths, depId);
    if (!depPath) { open.push({ id: depId, status: 'missing' }); continue; }
    try {
      const dep = JSON.parse(readFileSync(depPath, 'utf-8')) as Task;
      if (dep.status !== 'completed') open.push({ id: depId, status: dep.status });
    } catch {
      open.push({ id: depId, status: 'missing' });
    }
  }
  return open;
}

/**
 * Find the on-disk path of a task file by ID, supporting cross-org lookup.
 *
 * cortextOS's standard dispatch pattern is an orchestrator in one org
 * filing tasks that get assigned to specialists in other orgs. Before
 * this helper existed, updateTask
 * and completeTask hardcoded `join(paths.taskDir, taskId + '.json')` — which
 * points at the CURRENT agent's org tasks dir — so the specialist could not
 * drive the lifecycle of any task that was filed from a sibling org. Every
 * cross-org assignment required a manual workaround dance where the filer
 * ran update/complete on behalf of the assignee.
 *
 * This helper fixes that by using a two-tier lookup:
 *
 *   1. Fast path: check the caller's OWN org tasks dir first. Most tasks
 *      live there and this check pays zero scan cost when it hits.
 *   2. Fallback: scan every sibling org under `<ctxRoot>/orgs/*` for a
 *      matching task file. Only runs when the fast path missed, so
 *      same-org operations take no perf hit.
 *
 * Task IDs are generated as `task_<epoch_ms>_<3digit_random>` so real
 * collisions are effectively impossible — but if the scan ever finds the
 * same ID in multiple orgs (e.g. due to a bug in ID generation or a manual
 * file copy), we warn loudly naming the task ID, the match count, AND the
 * org names so an operator can investigate without having to grep the IDs
 * themselves. We still return the first match and keep operations flowing;
 * erroring on a theoretical collision would be worse UX than the warn.
 *
 * Exported because the helper is a useful primitive for any future caller
 * that needs cross-org task lookup (e.g. a hypothetical `get-task` command,
 * task-graph visualization, or cross-org list-tasks flag).
 */
export function findTaskFile(paths: BusPaths, taskId: string): string | null {
  // Fast path: same-org lookup.
  const sameOrg = join(paths.taskDir, `${taskId}.json`);
  if (existsSync(sameOrg)) return sameOrg;

  // Fallback: cross-org scan.
  const orgsRoot = join(paths.ctxRoot, 'orgs');
  const matches: Array<{ path: string; org: string }> = [];
  try {
    for (const entry of readdirSync(orgsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(orgsRoot, entry.name, 'tasks', `${taskId}.json`);
      if (existsSync(candidate)) {
        matches.push({ path: candidate, org: entry.name });
      }
    }
  } catch {
    return null; // orgs/ missing or unreadable
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const orgList = matches.map((m) => m.org).join(', ');
    console.warn(
      `[task] Ambiguous task id ${taskId}: found in ${matches.length} orgs (${orgList}). ` +
      `Operating on the first match in org '${matches[0].org}'. ` +
      `Review task ID generation if this recurs.`,
    );
  }
  return matches[0].path;
}

/**
 * Update a task's status. Matches bash update-task.sh behavior, with the
 * cross-org fallback from findTaskFile so an assignee in one org can drive
 * the lifecycle of a task filed by an orchestrator in a sibling org.
 */
export function updateTask(
  paths: BusPaths,
  taskId: string,
  status: TaskStatus,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let assignee: string | undefined;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    task.status = status;
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} update failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'update', agent: assignee || 'unknown', from: prevStatus, to: status });
}

/**
 * One audit entry written to a task's append-only JSONL log. Every
 * status transition, claim, and completion emits one of these so the
 * full lifecycle can be replayed from disk.
 */
export interface TaskAuditEntry {
  ts: string; // ISO 8601
  event: 'create' | 'claim' | 'update' | 'complete';
  agent: string; // who caused the event
  from?: TaskStatus;
  to?: TaskStatus;
  note?: string;
}

/**
 * Append one audit line to `<taskDir>/audit/<taskId>.jsonl`. Uses
 * appendFileSync so concurrent writers each get O_APPEND semantics on
 * POSIX — partial interleaving at the sub-line level is possible on
 * some filesystems for lines over PIPE_BUF, but our entries are
 * ~200 bytes, comfortably under the 4096-byte atomicity bound.
 *
 * Best-effort: a failing audit write never blocks the caller. The
 * audit log is an observability aid, not the source of truth.
 */
export function appendTaskAudit(
  paths: BusPaths,
  taskId: string,
  entry: Omit<TaskAuditEntry, 'ts'>,
): void {
  try {
    const auditDir = join(paths.taskDir, 'audit');
    ensureDir(auditDir);
    const line: TaskAuditEntry = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...entry,
    };
    appendFileSync(join(auditDir, `${taskId}.jsonl`), JSON.stringify(line) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Never block a real operation on audit-log write failure.
  }
}

/**
 * Read all audit entries for a task in write-order. Returns empty
 * array if no audit log exists. Corrupt lines are skipped so a
 * partially-written line (rare: write crashed mid-line) does not
 * block history replay of surrounding entries.
 */
export function readTaskAudit(
  paths: BusPaths,
  taskId: string,
): TaskAuditEntry[] {
  const path = join(paths.taskDir, 'audit', `${taskId}.jsonl`);
  if (!existsSync(path)) return [];
  const entries: TaskAuditEntry[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed) as TaskAuditEntry); } catch { /* skip corrupt */ }
  }
  return entries;
}

/**
 * Atomically claim a task for an agent. Prevents two agents from double-
 * picking the same task — a race that previously could happen because
 * `update-task <id> in_progress` was a read-modify-write with no lock.
 *
 * Mechanism: write a companion claim-lock file via the POSIX O_EXCL
 * path (`writeFileSync` with `flag: 'wx'`). The first writer wins; the
 * second gets EEXIST and claimTask throws "already claimed by X". Only
 * after the lock is taken do we flip the task's status + assigned_to.
 *
 * Re-claiming a task you already own is idempotent (returns the task
 * without mutation). Claiming a non-pending task is rejected with a
 * message that names the current status so operators can diagnose.
 *
 * Claim-lock files live at `<taskDir>/.claims/<taskId>.claim` and carry
 * `<agent>\t<iso8601>` for audit. A later compaction pass can prune
 * claim-locks for completed tasks; for now they are append-only.
 */
export function claimTask(
  paths: BusPaths,
  taskId: string,
  agent: string,
): Task {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }

  let task: Task;
  try {
    task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
  } catch (err) {
    throw new Error(`Task ${taskId} claim failed (unreadable): ${err}`);
  }

  const claimsDir = join(paths.taskDir, '.claims');
  ensureDir(claimsDir);
  const claimPath = join(claimsDir, `${taskId}.claim`);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Idempotency: if this agent already owns the claim, succeed silently.
  if (existsSync(claimPath)) {
    try {
      const owner = readFileSync(claimPath, 'utf-8').split('\t')[0];
      if (owner === agent) {
        return task;
      }
      throw new Error(
        `Task ${taskId} already claimed by ${owner} (current status=${task.status})`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`Task ${taskId} already claimed`)) throw err;
      // Unreadable claim file — fall through and try the exclusive write.
    }
  }

  if (task.status !== 'pending') {
    throw new Error(
      `Task ${taskId} is not pending (status=${task.status}); cannot claim`,
    );
  }

  // Atomic: O_EXCL fails if the file exists, giving us true mutual
  // exclusion even under concurrent claims from two agents.
  try {
    writeFileSync(claimPath, `${agent}\t${now}\n`, { flag: 'wx', encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Someone else won the race — read the winner and surface it.
    let owner = 'unknown';
    try { owner = readFileSync(claimPath, 'utf-8').split('\t')[0]; } catch { /* stays 'unknown' */ }
    if (owner === agent) return task; // Benign race with self — treat as idempotent success.
    throw new Error(`Task ${taskId} already claimed by ${owner}`);
  }

  // Lock held — safe to mutate the task JSON.
  const prevStatus = task.status;
  task.status = 'in_progress';
  task.assigned_to = agent;
  task.updated_at = now;
  try {
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    // Roll back the claim so a retry can succeed; we never want a ghost
    // lock surviving a write failure on the task JSON itself.
    try { unlinkSync(claimPath); } catch { /* best-effort */ }
    throw new Error(`Task ${taskId} claim commit failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'claim', agent, from: prevStatus, to: 'in_progress' });
  return task;
}

/**
 * Complete a task. Sets status to done, completed_at, and optional result.
 * Matches bash complete-task.sh behavior, with the cross-org fallback from
 * findTaskFile so an assignee in one org can complete a task filed by an
 * orchestrator in a sibling org.
 */
export function completeTask(
  paths: BusPaths,
  taskId: string,
  result?: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let assignee: string | undefined;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    task.status = 'completed';
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    task.completed_at = task.updated_at;
    if (result) {
      task.result = result;
    }
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} complete failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'complete', agent: assignee || 'unknown', from: prevStatus, to: 'completed', note: result });
}

/**
 * List tasks with optional filters.
 * Matches bash list-tasks.sh behavior.
 */
export function listTasks(
  paths: BusPaths,
  filters?: {
    agent?: string;
    status?: TaskStatus;
    priority?: Priority;
    respectDeps?: boolean;
  },
): Task[] {
  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      const task: Task = JSON.parse(content);

      // Apply filters
      if (filters?.agent && task.assigned_to !== filters.agent) continue;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.priority && task.priority !== filters.priority) continue;
      if (task.archived) continue;

      tasks.push(task);
    } catch {
      // Skip corrupt files
    }
  }

  const sorted = tasks.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  if (!filters?.respectDeps) return sorted;

  // DAG-aware ordering: unblocked tasks first, blocked ones after, with
  // the secondary order preserving created_at DESC within each bucket.
  // "Blocked" = any blocked_by entry resolves to non-completed.
  const byId = new Map<string, Task>();
  for (const t of sorted) byId.set(t.id, t);
  const isBlocked = (t: Task): boolean => {
    for (const depId of t.blocked_by ?? []) {
      const dep = byId.get(depId);
      // Out-of-list deps are checked on-disk via checkTaskDependencies,
      // but the list-view only considers in-list tasks for speed.
      if (!dep) continue;
      if (dep.status !== 'completed') return true;
    }
    return false;
  };
  const unblocked: Task[] = [];
  const blocked: Task[] = [];
  for (const t of sorted) (isBlocked(t) ? blocked : unblocked).push(t);
  return [...unblocked, ...blocked];
}

/**
 * Helper: read all task JSON files from a directory (non-recursive).
 */
function readAllTasks(taskDir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      tasks.push(JSON.parse(content));
    } catch {
      // Skip corrupt files
    }
  }
  return tasks;
}

/**
 * Check for stale tasks. Matches bash check-stale-tasks.sh behavior.
 */
export function checkStaleTasks(paths: BusPaths): StaleTaskReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_IN_PROGRESS = 7200;   // 2 hours
  const STALE_PENDING = 86400;      // 24 hours
  const STALE_HUMAN = 86400;        // 24 hours

  const report: StaleTaskReport = {
    stale_in_progress: [],
    stale_pending: [],
    stale_human: [],
    overdue: [],
  };

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Skip completed/done tasks
    if (task.status === 'completed' || task.status === 'cancelled') continue;

    const updatedEpoch = Math.floor(new Date(task.updated_at).getTime() / 1000);
    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - updatedEpoch;
    const createdAge = nowEpoch - createdEpoch;

    // Stale in_progress: updated_at > 2 hours ago
    if (task.status === 'in_progress' && age > STALE_IN_PROGRESS) {
      report.stale_in_progress.push(task);
    }

    // Stale pending: created_at > 24 hours ago
    if (task.status === 'pending' && createdAge > STALE_PENDING) {
      report.stale_pending.push(task);
    }

    // Human tasks: assigned to "human" or "user", or in human-tasks project
    if (
      (['human', 'user'].includes(task.assigned_to ?? '') ||
        task.project === 'human-tasks') &&
      createdAge > STALE_HUMAN
    ) {
      report.stale_human.push(task);
    }

    // Overdue: has due_date and it's in the past
    if (task.due_date) {
      const dueEpoch = Math.floor(new Date(task.due_date).getTime() / 1000);
      if (dueEpoch > 0 && nowEpoch > dueEpoch) {
        report.overdue.push(task);
      }
    }
  }

  return report;
}

/**
 * Archive completed tasks older than 7 days. Matches bash archive-tasks.sh behavior.
 */
export function archiveTasks(paths: BusPaths, dryRun: boolean = false): ArchiveReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const ARCHIVE_AGE = 604800; // 7 days

  let archived = 0;
  let skipped = 0;

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Only archive completed tasks
    if (task.status !== 'completed') continue;

    if (!task.completed_at) {
      skipped++;
      continue;
    }

    const completedEpoch = Math.floor(new Date(task.completed_at).getTime() / 1000);
    const age = nowEpoch - completedEpoch;

    if (age > ARCHIVE_AGE) {
      if (!dryRun) {
        const archiveDir = join(paths.taskDir, 'archive');
        ensureDir(archiveDir);

        // Mark as archived
        task.archived = true;
        const srcPath = join(paths.taskDir, `${task.id}.json`);
        atomicWriteSync(srcPath, JSON.stringify(task));

        // Move to archive
        renameSync(srcPath, join(archiveDir, `${task.id}.json`));
      }
      archived++;
    }
  }

  return { archived, skipped, dry_run: dryRun };
}

/**
 * Semantic compaction of old completed tasks (beads-inspired). Each
 * eligible task becomes a one-line summary entry in a monthly
 * `archive-YYYY-MM.jsonl` file (bucketed by the task's completed_at
 * month), and the active task JSON is removed to keep the task board
 * small. The audit log (audit/<id>.jsonl) is intentionally preserved
 * so full lifecycle history survives compaction.
 *
 * Guards (a task is SKIPPED if any of the following holds):
 *   - status !== 'completed'
 *   - completed_at missing OR completed_at within the cutoff window
 *   - the task is still listed in some OTHER task's `blocked_by` where
 *     that other task is not yet completed (compaction must not
 *     orphan dependency references for unresolved dependents)
 *
 * No LLM calls. The "summary" is just title + result + key metadata;
 * callers supply clean result strings via `complete-task --result`.
 *
 * Idempotent: running twice over the same data does nothing the
 * second time because eligible tasks have already been removed.
 */
export interface CompactTasksReport {
  archived: Array<{ id: string; archive_file: string }>;
  skipped: Array<{ id: string; reason: string }>;
  dry_run: boolean;
}

export function compactTasks(
  paths: BusPaths,
  options: { olderThanDays?: number; dryRun?: boolean } = {},
): CompactTasksReport {
  const { olderThanDays = 30, dryRun = false } = options;
  const report: CompactTasksReport = { archived: [], skipped: [], dry_run: dryRun };
  const cutoffMs = Date.now() - olderThanDays * 86400_000;

  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
  } catch {
    return report;
  }

  // First pass: load every task so we can check cross-task dependency
  // references without re-reading files per candidate.
  const tasks: Task[] = [];
  for (const f of files) {
    try { tasks.push(JSON.parse(readFileSync(join(taskDir, f), 'utf-8')) as Task); }
    catch { /* skip corrupt */ }
  }

  // Build a "still-needed" set: the TRANSITIVE blocker closure of
  // every open task. A completed blocker must survive compaction as
  // long as ANY open task has it in its blocked_by chain — not just
  // direct parents. With A <- B <- C and C open, the direct-only
  // guard preserved B but archived A, leaving B with a dangling
  // reference to an archived task. Phase 4 directive was
  // "still in the blocked_by chain of a pending task" — the
  // full-chain reading is the correct one.
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const stillNeededAsBlocker = new Set<string>();
  const stack: string[] = [];
  for (const t of tasks) {
    if (t.status === 'completed') continue;
    for (const blockerId of t.blocked_by ?? []) stack.push(blockerId);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    if (stillNeededAsBlocker.has(cur)) continue;
    stillNeededAsBlocker.add(cur);
    const parent = byId.get(cur);
    if (parent?.blocked_by?.length) stack.push(...parent.blocked_by);
  }

  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    if (!task.completed_at) { report.skipped.push({ id: task.id, reason: 'no completed_at timestamp' }); continue; }
    const completedMs = new Date(task.completed_at).getTime();
    if (isNaN(completedMs) || completedMs > cutoffMs) {
      report.skipped.push({ id: task.id, reason: 'completed_at within cutoff' });
      continue;
    }
    if (stillNeededAsBlocker.has(task.id)) {
      report.skipped.push({ id: task.id, reason: 'still referenced by an open task\'s blocked_by chain' });
      continue;
    }

    const yyyymm = task.completed_at.substring(0, 7); // YYYY-MM
    const archiveFile = `archive-${yyyymm}.jsonl`;
    const archivePath = join(taskDir, archiveFile);
    const entry = {
      id: task.id,
      title: task.title,
      org: task.org,
      assigned_to: task.assigned_to,
      completed_at: task.completed_at,
      archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      result: task.result ?? '',
    };

    if (!dryRun) {
      try {
        appendFileSync(archivePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
        unlinkSync(join(taskDir, `${task.id}.json`));
      } catch (err) {
        report.skipped.push({ id: task.id, reason: `archive write failed: ${err}` });
        continue;
      }
    }
    report.archived.push({ id: task.id, archive_file: archiveFile });
  }

  return report;
}

/**
 * Find stale human-assigned tasks. Matches bash check-human-tasks.sh behavior.
 */
export function checkHumanTasks(paths: BusPaths): Task[] {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_THRESHOLD = 86400; // 24 hours

  const tasks = readAllTasks(paths.taskDir);
  const result: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    if (task.assigned_to !== 'human' && task.assigned_to !== 'user') continue;

    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - createdEpoch;

    if (age > STALE_THRESHOLD) {
      result.push(task);
    }
  }

  return result;
}
