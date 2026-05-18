// cortextOS Dashboard - Task data fetcher
// Reads from SQLite (synced from JSON task files on disk).

import fs from 'fs';
import { db } from '@/lib/db';
import type { Task, TaskFilters } from '@/lib/types';
import { appendTaskScopeConditions } from './task-scope';

/**
 * Get tasks with optional filters.
 * Returns newest first by default.
 */
export function getTasks(filters?: TaskFilters): Task[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  appendTaskScopeConditions(filters, conditions, params);
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
// Row mapping
// ---------------------------------------------------------------------------

function rowToTask(row: Record<string, unknown>): Task {
  const sourceFile = (row.source_file as string) ?? undefined;
  let meta: Task['meta'];

  if (sourceFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
      if (raw && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
        meta = raw.meta as Task['meta'];
      }
    } catch {
      // Metadata is an optional JSON-file-only extension; keep SQLite reads resilient.
    }
  }

  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    assigned_to: (row.assignee as string) ?? undefined,
    assignee: (row.assignee as string) ?? undefined,
    org: row.org as string,
    project: (row.project as string) ?? undefined,
    needs_approval: row.needs_approval === 1,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string) ?? undefined,
    completed_at: (row.completed_at as string) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    source_file: sourceFile,
    meta,
  };
}
