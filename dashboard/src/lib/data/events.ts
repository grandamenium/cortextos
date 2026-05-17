// cortextOS Dashboard - Event data fetcher
// Reads from Postgres (synced from JSONL event files on disk).

import { sql } from '@/lib/db';
import type { Event } from '@/lib/types';

export async function getRecentEvents(
  limit = 50,
  org?: string,
  agent?: string,
  category?: string,
): Promise<Event[]> {
  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, timestamp, agent, org, type, category, severity, data, message, source_file
      FROM events
      WHERE TRUE
      ${org ? sql`AND org = ${org}` : sql``}
      ${agent ? sql`AND agent = ${agent}` : sql``}
      ${category ? sql`AND category = ${category}` : sql``}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToEvent);
  } catch (err) {
    console.error('[data/events] getRecentEvents error:', err);
    return [];
  }
}

export async function getEventsToday(org?: string, agent?: string): Promise<Event[]> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();
  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, timestamp, agent, org, type, category, severity, data, message, source_file
      FROM events
      WHERE timestamp >= ${todayISO}
      ${org ? sql`AND org = ${org}` : sql``}
      ${agent ? sql`AND agent = ${agent}` : sql``}
      ORDER BY timestamp DESC
    `;
    return rows.map(rowToEvent);
  } catch (err) {
    console.error('[data/events] getEventsToday error:', err);
    return [];
  }
}

export async function getEventsByAgent(agentName: string, limit = 50): Promise<Event[]> {
  return getRecentEvents(limit, undefined, agentName);
}

export async function getEventsByCategory(category: string, org?: string): Promise<Event[]> {
  return getRecentEvents(100, org, undefined, category);
}

export async function getMilestones(org?: string): Promise<Event[]> {
  return getRecentEvents(100, org, undefined, 'milestone');
}

function rowToEvent(row: Record<string, unknown>): Event {
  let parsedData: Record<string, unknown> | undefined;
  if (row.data) {
    try {
      parsedData = JSON.parse(row.data as string);
    } catch {
      parsedData = undefined;
    }
  }

  return {
    id: row.id as string,
    timestamp: row.timestamp as string,
    agent: row.agent as string,
    org: row.org as string,
    type: row.type as Event['type'],
    category: (row.category as string) ?? '',
    severity: row.severity as Event['severity'],
    data: parsedData,
    message: (row.message as string) ?? undefined,
    source_file: (row.source_file as string) ?? undefined,
  };
}
