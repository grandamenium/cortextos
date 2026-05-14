// cortextOS Dashboard - Task data fetcher
// Reads from SQLite (synced from JSON task files on disk).

import { db } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import type { Task, TaskFilters, TaskAuditEntry } from '@/lib/types';
import { getTaskDir, getCTXRoot } from '@/lib/config';

/**
 * Get tasks with optional filters.
 * Returns newest first by default.
 */
export function getTasks(filters?: TaskFilters): Task[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.org) {
    conditions.push('org = ?');
    params.push(filters.org);
  }
  if (filters?.agent) {
    // 'human' is a virtual filter: returns tasks assigned to any non-agent human
    // (agents create human tasks with assigned_to 'user', 'human', etc.)
    if (filters.agent === 'human') {
      conditions.push("(assignee IN ('human', 'user') OR title LIKE '[HUMAN]%' OR project = 'human-tasks')");
    } else {
      conditions.push('assignee = ?');
      params.push(filters.agent);
    }
  }
  if (filters?.priority) {
    conditions.push('priority = ?');
    params.push(filters.priority);
  }
  if (filters?.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters?.project) {
    conditions.push('project = ?');
    params.push(filters.project);
  }
  if (filters?.search) {
    conditions.push('(title LIKE ? OR description LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, notes, source_file
         FROM tasks ${where}
         ORDER BY created_at DESC`
      )
      .all(...params) as Record<string, unknown>[];

    return rows.map(rowToTask);
  } catch (err) {
    console.error('[data/tasks] getTasks error:', err);
    return [];
  }
}

/**
 * Get a single task by ID.
 */
export function getTaskById(id: string): Task | null {
  try {
    const row = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, notes, source_file
         FROM tasks WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;

    return row ? rowToTask(row) : null;
  } catch (err) {
    console.error('[data/tasks] getTaskById error:', err);
    return null;
  }
}

/**
 * Get tasks filtered by status (useful for kanban columns).
 */
export function getTasksByStatus(status: string, org?: string): Task[] {
  return getTasks({ status, org });
}

/**
 * Get tasks assigned to a specific agent.
 */
export function getTasksByAgent(agentName: string, org?: string): Task[] {
  return getTasks({ agent: agentName, org });
}

/**
 * Get tasks completed today (UTC).
 */
export function getTasksCompletedToday(org?: string): Task[] {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const conditions: string[] = ['completed_at >= ?'];
  const params: (string | number)[] = [todayISO];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const rows = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, notes, source_file
         FROM tasks ${where}
         ORDER BY completed_at DESC`
      )
      .all(...params) as Record<string, unknown>[];

    return rows.map(rowToTask);
  } catch (err) {
    console.error('[data/tasks] getTasksCompletedToday error:', err);
    return [];
  }
}

/**
 * Get count of in-progress tasks (for sidebar badge).
 */
export function getInProgressCount(org?: string): number {
  return getTaskCount(org, 'in_progress');
}

/**
 * Get count of tasks matching optional org/status.
 */
export function getTaskCount(org?: string, status?: string): number {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM tasks ${where}`)
      .get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  } catch (err) {
    console.error('[data/tasks] getTaskCount error:', err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Task history (audit log)
// ---------------------------------------------------------------------------

/**
 * Read all audit entries for a task directly from the JSONL file on disk.
 * Returns entries in write-order (oldest first). Returns empty array if
 * the audit log does not exist or cannot be read.
 *
 * The audit log lives at: <taskDir>/audit/<taskId>.jsonl
 * We resolve the task dir by inspecting the task's source_file first,
 * then fall back to the configured task dir for the task's org.
 */
export function getTaskHistory(id: string): TaskAuditEntry[] {
  // Resolve audit file path. Strategy (in priority order):
  // 1. source_file from SQLite task record (fast, exact)
  // 2. org from SQLite task record -> getTaskDir(org)
  // 3. Cross-org filesystem scan under CTX_ROOT/orgs/*
  // 4. Default (no-org) task dir
  // This layered approach means the function works even when SQLite hasn't
  // synced yet (e.g. in tests that write files directly).
  let auditPath: string | null = null;

  try {
    const task = getTaskById(id);
    if (task?.source_file) {
      const candidate = path.join(path.dirname(task.source_file), 'audit', `${id}.jsonl`);
      if (fs.existsSync(candidate)) {
        auditPath = candidate;
      }
    }
    if (!auditPath) {
      const taskDir = getTaskDir(task?.org ?? undefined);
      const candidate = path.join(taskDir, 'audit', `${id}.jsonl`);
      if (fs.existsSync(candidate)) {
        auditPath = candidate;
      }
    }
  } catch {
    // SQLite lookup failed — proceed to filesystem scan
  }

  // Cross-org scan: walk CTX_ROOT/orgs/*/tasks/audit/<id>.jsonl
  if (!auditPath) {
    const ctxRoot = getCTXRoot();
    const orgsRoot = path.join(ctxRoot, 'orgs');
    try {
      for (const entry of fs.readdirSync(orgsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(orgsRoot, entry.name, 'tasks', 'audit', `${id}.jsonl`);
        if (fs.existsSync(candidate)) {
          auditPath = candidate;
          break;
        }
      }
    } catch { /* orgs/ missing */ }
  }

  // Last resort: default (no-org) task dir
  if (!auditPath) {
    const fallback = path.join(getTaskDir(), 'audit', `${id}.jsonl`);
    if (fs.existsSync(fallback)) auditPath = fallback;
  }

  if (!auditPath) return [];

  const entries: TaskAuditEntry[] = [];
  try {
    const raw = fs.readFileSync(auditPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as TaskAuditEntry);
      } catch {
        // Skip corrupt lines — partial writes under O_APPEND are rare but possible.
      }
    }
  } catch {
    return [];
  }
  return entries;
}

/**
 * Append a comment entry to a task's audit log.
 * Writes a JSONL line directly (same format as commentTask in src/bus/task.ts).
 * Rejects empty text. Non-fatal: if the write fails, throws so the caller
 * can surface the error.
 */
export function appendComment(id: string, agent: string, text: string, task: Task): void {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Comment text is required');
  if (!agent) throw new Error('Comment agent is required');

  // Resolve audit path from source_file first, then config.
  let auditDir: string;
  if (task.source_file) {
    auditDir = path.join(path.dirname(task.source_file), 'audit');
  } else {
    auditDir = path.join(getTaskDir(task.org ?? undefined), 'audit');
  }

  // Ensure audit dir exists
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  }

  const entry: TaskAuditEntry = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    event: 'comment',
    agent,
    note: trimmed,
  };

  // O_APPEND semantics: atomic for lines under PIPE_BUF (4096 bytes on POSIX).
  // Our entries are ~200 bytes, so no interleaving risk.
  fs.appendFileSync(
    path.join(auditDir, `${id}.jsonl`),
    JSON.stringify(entry) + '\n',
    { encoding: 'utf-8', mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    assignee: (row.assignee as string) ?? undefined,
    org: row.org as string,
    project: (row.project as string) ?? undefined,
    needs_approval: row.needs_approval === 1,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string) ?? undefined,
    completed_at: (row.completed_at as string) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    source_file: (row.source_file as string) ?? undefined,
  };
}
