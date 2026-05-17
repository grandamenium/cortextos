// cortextOS Dashboard - Approval data fetcher
// Reads from Postgres (synced from JSON approval files on disk).

import { sql } from '@/lib/db';
import type { Approval } from '@/lib/types';

export async function getPendingApprovals(org?: string): Promise<Approval[]> {
  return getApprovalsByStatus('pending', org);
}

export async function getResolvedApprovals(
  org?: string,
  filters?: { agent?: string; category?: string; dateRange?: [Date, Date] },
): Promise<Approval[]> {
  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, title, category, description, status, agent, org,
             created_at, resolved_at, resolved_by, resolution_note, source_file
      FROM approvals
      WHERE status != 'pending'
      ${org ? sql`AND org = ${org}` : sql``}
      ${filters?.agent ? sql`AND agent = ${filters.agent}` : sql``}
      ${filters?.category ? sql`AND category = ${filters.category}` : sql``}
      ${filters?.dateRange
        ? sql`AND resolved_at >= ${filters.dateRange[0].toISOString()} AND resolved_at <= ${filters.dateRange[1].toISOString()}`
        : sql``}
      ORDER BY resolved_at DESC
    `;
    return rows.map(rowToApproval);
  } catch (err) {
    console.error('[data/approvals] getResolvedApprovals error:', err);
    return [];
  }
}

export async function getPendingCount(org?: string): Promise<number> {
  try {
    const [row] = await sql<{ count: string }[]>`
      SELECT COUNT(*) as count FROM approvals
      WHERE status = 'pending'
      ${org ? sql`AND org = ${org}` : sql``}
    `;
    return Number(row?.count ?? 0);
  } catch (err) {
    console.error('[data/approvals] getPendingCount error:', err);
    return 0;
  }
}

export async function getApprovalById(id: string): Promise<Approval | null> {
  try {
    const [row] = await sql<Record<string, unknown>[]>`
      SELECT id, title, category, description, status, agent, org,
             created_at, resolved_at, resolved_by, resolution_note, source_file
      FROM approvals WHERE id = ${id}
    `;
    return row ? rowToApproval(row) : null;
  } catch (err) {
    console.error('[data/approvals] getApprovalById error:', err);
    return null;
  }
}

async function getApprovalsByStatus(status: string, org?: string): Promise<Approval[]> {
  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, title, category, description, status, agent, org,
             created_at, resolved_at, resolved_by, resolution_note, source_file
      FROM approvals
      WHERE status = ${status}
      ${org ? sql`AND org = ${org}` : sql``}
      ORDER BY created_at DESC
    `;
    return rows.map(rowToApproval);
  } catch (err) {
    console.error('[data/approvals] getApprovalsByStatus error:', err);
    return [];
  }
}

function rowToApproval(row: Record<string, unknown>): Approval {
  return {
    id: row.id as string,
    title: row.title as string,
    category: row.category as Approval['category'],
    description: (row.description as string) ?? undefined,
    status: row.status as Approval['status'],
    agent: row.agent as string,
    org: row.org as string,
    created_at: row.created_at as string,
    resolved_at: (row.resolved_at as string) ?? undefined,
    resolved_by: (row.resolved_by as string) ?? undefined,
    resolution_note: (row.resolution_note as string) ?? undefined,
    source_file: (row.source_file as string) ?? undefined,
  };
}
