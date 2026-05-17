// cortextOS Dashboard - Analytics data queries
// Aggregated metrics for charts on the analytics page.

import { sql } from '@/lib/db';
import type { AgentStat } from '@/components/analytics/agent-effectiveness';

export async function getTaskThroughput(
  days = 30,
  org?: string,
): Promise<Array<{ date: string; tasks: number }>> {
  try {
    // completed_at is stored as ISO8601 text; compare against computed cutoff
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
    const rows = await sql<{ date: string; tasks: string }[]>`
      SELECT LEFT(completed_at, 10) as date, COUNT(*) as tasks
      FROM tasks
      WHERE completed_at >= ${cutoff}
        AND status = 'completed'
        ${org ? sql`AND org = ${org}` : sql``}
      GROUP BY LEFT(completed_at, 10)
      ORDER BY date ASC
    `;
    return rows.map((r) => ({ date: r.date, tasks: Number(r.tasks) }));
  } catch {
    return [];
  }
}

export async function getAgentEffectiveness(org?: string): Promise<AgentStat[]> {
  try {
    const rows = await sql<{ name: string; total: string; completed: string }[]>`
      SELECT
        assignee as name,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM tasks
      WHERE assignee IS NOT NULL AND assignee != ''
      ${org ? sql`AND org = ${org}` : sql``}
      GROUP BY assignee
    `;

    const errorRows = await sql<{ name: string; errors: string }[]>`
      SELECT agent as name, COUNT(*) as errors
      FROM events
      WHERE type = 'error'
      ${org ? sql`AND org = ${org}` : sql``}
      GROUP BY agent
    `;

    const cutoff7 = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
    const trendRows = await sql<{ name: string; date: string; count: string }[]>`
      SELECT assignee as name, LEFT(completed_at, 10) as date, COUNT(*) as count
      FROM tasks
      WHERE completed_at >= ${cutoff7}
        AND status = 'completed'
        AND assignee IS NOT NULL AND assignee != ''
      GROUP BY assignee, LEFT(completed_at, 10)
      ORDER BY date ASC
    `;

    const errorMap = new Map(errorRows.map((r) => [r.name, Number(r.errors)]));

    const trendMap = new Map<string, number[]>();
    for (const row of trendRows) {
      if (!trendMap.has(row.name)) trendMap.set(row.name, new Array(7).fill(0));
      const dayDiff = Math.floor((Date.now() - new Date(row.date).getTime()) / (86400 * 1000));
      const idx = 6 - Math.min(dayDiff, 6);
      trendMap.get(row.name)![idx] = Number(row.count);
    }

    return rows.map((row) => {
      const total = Number(row.total);
      const completed = Number(row.completed);
      return {
        name: row.name,
        completionRate: total > 0 ? (completed / total) * 100 : 0,
        errorCount: errorMap.get(row.name) ?? 0,
        tasksCompleted: completed,
        recentTrend: trendMap.get(row.name) ?? [0, 0, 0, 0, 0, 0, 0],
      };
    });
  } catch {
    return [];
  }
}
