/**
 * Ops Digest — fleet-wide daily aggregation for the Ops Manager agent role.
 *
 * Pure data aggregation only (task counts, errors, heartbeat health, stale
 * goals, memory tail, recently completed task titles). No narrative content —
 * the Ops Manager agent itself reads this digest and writes the "what did
 * they do / what could be better" synthesis, the same way the orchestrator's
 * evening-review/weekly-review skills already turn bus data into a briefing.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { collectMetrics } from './metrics.js';
import { checkGoalStaleness } from './system.js';
import { listTasks } from './task.js';
import type { BusPaths } from '../types/index.js';

export interface OpsDigestAgent {
  name: string;
  tasks_completed: number;
  tasks_pending: number;
  tasks_in_progress: number;
  errors_today: number;
  heartbeat_stale: boolean;
  goals_stale: boolean;
  goals_status: string;
  recent_completed_titles: string[];
  memory_tail: string | null;
}

export interface OpsDigest {
  generated_at: string;
  org: string;
  agents: OpsDigestAgent[];
  system: {
    agents_total: number;
    agents_healthy: number;
    total_tasks_completed: number;
    approvals_pending: number;
  };
}

/**
 * A task counts as "recent" for the digest if it completed within the last
 * 36 hours — wide enough to catch everything since yesterday regardless of
 * exactly when in the day the cron fires, without pulling in older history.
 */
const RECENT_WINDOW_MS = 36 * 60 * 60 * 1000;

function readMemoryTail(projectRoot: string, org: string, agent: string): string | null {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  for (const d of [yesterday, today]) {
    const dateStr = d.toISOString().split('T')[0];
    const memPath = join(projectRoot, 'orgs', org, 'agents', agent, 'memory', `${dateStr}.md`);
    if (existsSync(memPath)) {
      try {
        const content = readFileSync(memPath, 'utf-8').trim();
        if (content) return content.slice(-2000);
      } catch { /* ignore unreadable memory file */ }
    }
  }
  return null;
}

export function generateOpsDigest(ctxRoot: string, projectRoot: string, org: string): OpsDigest {
  const metrics = collectMetrics(ctxRoot, org);
  const staleness = checkGoalStaleness(projectRoot);
  const staleByAgent = new Map(
    staleness.agents.filter(a => a.org === org).map(a => [a.agent, a]),
  );

  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  let orgAgentNames: string[] = [];
  if (existsSync(enabledFile)) {
    try {
      const enabled = JSON.parse(readFileSync(enabledFile, 'utf-8')) as Record<string, { org?: string }>;
      orgAgentNames = Object.entries(enabled)
        .filter(([, v]) => v.org === org)
        .map(([name]) => name);
    } catch { /* leave empty on parse failure */ }
  }

  // listTasks only reads paths.taskDir, which is org-scoped (not agent-scoped).
  // Built directly against the ctxRoot we were given rather than via
  // resolvePaths(), which hardcodes homedir()/.cortextos/{instance} and would
  // silently ignore a caller-supplied ctxRoot (breaks both CTX_ROOT overrides
  // and unit testing against a tmp fixture dir).
  const orgBase = join(ctxRoot, 'orgs', org);
  const paths = { taskDir: join(orgBase, 'tasks') } as BusPaths;

  const now = Date.now();
  const agents: OpsDigestAgent[] = orgAgentNames.map((name) => {
    const m = metrics.agents[name];
    const goalStatus = staleByAgent.get(name);

    const completed = listTasks(paths, { agent: name, status: 'completed' });
    const recentTitles = completed
      .filter(t => t.completed_at && (now - new Date(t.completed_at).getTime()) < RECENT_WINDOW_MS)
      .map(t => t.title);

    return {
      name,
      tasks_completed: m?.tasks_completed ?? 0,
      tasks_pending: m?.tasks_pending ?? 0,
      tasks_in_progress: m?.tasks_in_progress ?? 0,
      errors_today: m?.errors_today ?? 0,
      heartbeat_stale: m?.heartbeat_stale ?? true,
      goals_stale: goalStatus?.stale ?? true,
      goals_status: goalStatus?.status ?? 'missing',
      recent_completed_titles: recentTitles,
      memory_tail: readMemoryTail(projectRoot, org, name),
    };
  });

  return {
    generated_at: new Date().toISOString(),
    org,
    agents,
    system: {
      agents_total: metrics.system.agents_total,
      agents_healthy: metrics.system.agents_healthy,
      total_tasks_completed: metrics.system.total_tasks_completed,
      approvals_pending: metrics.system.approvals_pending,
    },
  };
}
