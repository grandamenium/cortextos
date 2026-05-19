// cortextOS Dashboard - Task data fetcher
// Reads from SQLite (synced from JSON task files on disk).

import { db } from '@/lib/db';
import type { Task, TaskFilters } from '@/lib/types';

// Noise task title prefixes hidden from all dashboard views
const NOISE_TASK_PREFIXES = [
  'Cron: heartbeat',
  'Cron: keepalive',
  'Cron: passive-heartbeat',
  'Cron: comms-check',
  'Cron: transcript-scanner',
  'Cron: check-approvals',
  'Cron: todoist-health-check',
  'Cron: morning-brief',
  'Cron: evening-wrap',
  'Cron: midday-sync',
  'Cron: milestone-check',
  'Cron: client-health',
  'Cron: sage-theta-wave',
  'Cron: pre-meeting-brief',
  'Cron: news-intelligence',
];
const NOISE_EXCLUSION_SQL = NOISE_TASK_PREFIXES
  .map(() => "title NOT LIKE ?")
  .join(' AND ');
const NOISE_EXCLUSION_PARAMS = NOISE_TASK_PREFIXES.map((p) => `${p}%`);

/**
 * Get tasks with optional filters.
 * Returns newest first by default.
 */
export function getTasks(filters?: TaskFilters): Task[] {
  const conditions: string[] = [NOISE_EXCLUSION_SQL];
  const params: (string | number)[] = [...NOISE_EXCLUSION_PARAMS];

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
 * Get tasks completed since Los Angeles local midnight.
 */
export function getTasksCompletedToday(org?: string): Task[] {
  const timezone = 'America/Los_Angeles';
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const ptDateParts = new Map(dateParts.map((part) => [part.type, part.value]));
  const ptDate = `${ptDateParts.get('year')}-${ptDateParts.get('month')}-${ptDateParts.get('day')}`;
  const offsetPart = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-08:00';
  const ptOffset = offsetPart.replace('GMT', '');
  const todayISO = new Date(`${ptDate}T00:00:00${ptOffset}`).toISOString();

  const conditions: string[] = ['completed_at >= ?', NOISE_EXCLUSION_SQL];
  const params: (string | number)[] = [todayISO, ...NOISE_EXCLUSION_PARAMS];

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
  const conditions: string[] = [NOISE_EXCLUSION_SQL];
  const params: (string | number)[] = [...NOISE_EXCLUSION_PARAMS];

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
