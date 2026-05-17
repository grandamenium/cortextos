// cortextOS Dashboard - Task data fetcher
// Reads from Postgres (synced from JSON task files on disk).

import { sql } from '@/lib/db';
import type { Task, TaskFilters } from '@/lib/types';

export async function getTasks(filters?: TaskFilters): Promise<Task[]> {
  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, title, description, status, priority, assignee, org, project,
             needs_approval, created_at, updated_at, completed_at, notes, source_file
      FROM tasks
      WHERE TRUE
      ${filters?.org ? sql`AND org = ${filters.org}` : sql``}
      ${filters?.agent
        ? filters.agent === 'human'
          ? sql`AND (assignee IN ('human', 'user') OR title LIKE '[HUMAN]%' OR project = 'human-tasks')`
          : sql`AND assignee = ${filters.agent}`
        : sql``}
      ${filters?.priority ? sql`AND priority = ${filters.priority}` : sql``}
      ${filters?.status ? sql`AND status = ${filters.status}` : sql``}
      ${filters?.project ? sql`AND project = ${filters.project}` : sql``}
      ${filters?.search
        ? sql`AND (title ILIKE ${'%' + filters.search + '%'} OR description ILIKE ${'%' + filters.search + '%'})`
        : sql``}
      ORDER BY created_at DESC
    `;
    return rows.map(rowToTask);
  } catch (err) {
    console.error('[data/tasks] getTasks error:', err);
    return [];
  }
}

export async function getTaskById(id: string): Promise<Task | null> {
  try {
    const [row] = await sql<Record<string, unknown>[]>`
      SELECT id, title, description, status, priority, assignee, org, project,
             needs_approval, created_at, updated_at, completed_at, notes, source_file
      FROM tasks WHERE id = ${id}
    `;
    return row ? rowToTask(row) : null;
  } catch (err) {
    console.error('[data/tasks] getTaskById error:', err);
    return null;
  }
}

export async function getTasksByStatus(status: string, org?: string): Promise<Task[]> {
  return getTasks({ status, org });
}

export async function getTasksByAgent(agentName: string, org?: string): Promise<Task[]> {
  return getTasks({ agent: agentName, org });
}

export async function getTasksCompletedToday(org?: string): Promise<Task[]> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();
  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, title, description, status, priority, assignee, org, project,
             needs_approval, created_at, updated_at, completed_at, notes, source_file
      FROM tasks
      WHERE completed_at >= ${todayISO}
      ${org ? sql`AND org = ${org}` : sql``}
      ORDER BY completed_at DESC
    `;
    return rows.map(rowToTask);
  } catch (err) {
    console.error('[data/tasks] getTasksCompletedToday error:', err);
    return [];
  }
}

export async function getInProgressCount(org?: string): Promise<number> {
  return getTaskCount(org, 'in_progress');
}

export async function getTaskCount(org?: string, status?: string): Promise<number> {
  try {
    const [row] = await sql<{ count: string }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE TRUE
      ${org ? sql`AND org = ${org}` : sql``}
      ${status ? sql`AND status = ${status}` : sql``}
    `;
    return Number(row?.count ?? 0);
  } catch (err) {
    console.error('[data/tasks] getTaskCount error:', err);
    return 0;
  }
}

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
    needs_approval: row.needs_approval === 1 || row.needs_approval === true,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string) ?? undefined,
    completed_at: (row.completed_at as string) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    source_file: (row.source_file as string) ?? undefined,
  };
}
