// A/B compare for `token-audit ab-compare`.
//
// Compares two agents head-to-head over a window. Reports per-agent USD,
// task throughput, USD/task, anomaly counts, and a plain-English verdict.

import type { TurnFact, Anomaly } from './types.js';

export interface ABInput {
  agentA: string;
  agentB: string;
  turns: TurnFact[];
  anomalies: Anomaly[];
  tasksByAgent: Map<string, number>;
  since: Date;
  until: Date;
}

export interface ABRow {
  agent: string;
  usd_total: number;
  turn_count: number;
  tasks_completed: number;
  usd_per_task: number;
  anomaly_count: number;
  cache_runaway_count: number;
}

export interface ABResult {
  pair: [string, string];
  since: string;
  until: string;
  rows: [ABRow, ABRow];
  verdict: string;
}

function tally(agent: string, input: ABInput): ABRow {
  const ts = input.turns.filter((t) => t.agent === agent);
  const anom = input.anomalies.filter((a) => a.agent === agent);
  const usd = ts.reduce((s, t) => s + t.usd_total, 0);
  const tasks = input.tasksByAgent.get(agent) ?? 0;
  return {
    agent,
    usd_total: usd,
    turn_count: ts.length,
    tasks_completed: tasks,
    usd_per_task: tasks > 0 ? usd / tasks : usd,
    anomaly_count: anom.length,
    cache_runaway_count: anom.filter((a) => a.kind === 'cache_runaway').length,
  };
}

export function abCompare(input: ABInput): ABResult {
  const a = tally(input.agentA, input);
  const b = tally(input.agentB, input);

  let verdict = '';
  const verdictParts: string[] = [];

  // USD/task comparison — only meaningful if both have at least 1 task.
  if (a.tasks_completed > 0 && b.tasks_completed > 0) {
    const ratio = a.usd_per_task / Math.max(b.usd_per_task, 0.000001);
    if (ratio > 1.5) verdictParts.push(`${b.agent} spent ${((1 - 1 / ratio) * 100).toFixed(0)}% less per task than ${a.agent}`);
    else if (ratio < 0.67) verdictParts.push(`${a.agent} spent ${((1 - ratio) * 100).toFixed(0)}% less per task than ${b.agent}`);
    else verdictParts.push(`USD/task within 1.5× — no clear winner on cost efficiency`);
  } else {
    if (a.tasks_completed === 0) verdictParts.push(`${a.agent} completed 0 tasks — incomplete A/B data`);
    if (b.tasks_completed === 0) verdictParts.push(`${b.agent} completed 0 tasks — incomplete A/B data`);
  }

  // Anomaly comparison — qualitative offset.
  if (a.cache_runaway_count > 2 * b.cache_runaway_count + 1) verdictParts.push(`${a.agent} had ${a.cache_runaway_count} cache-runaway anomalies vs ${b.cache_runaway_count} for ${b.agent} — quality signal favors ${b.agent}`);
  if (b.cache_runaway_count > 2 * a.cache_runaway_count + 1) verdictParts.push(`${b.agent} had ${b.cache_runaway_count} cache-runaway anomalies vs ${a.cache_runaway_count} for ${a.agent} — quality signal favors ${a.agent}`);

  verdict = verdictParts.length === 0 ? 'No strong signal — extend trial.' : verdictParts.join('. ') + '.';

  return {
    pair: [a.agent, b.agent],
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    rows: [a, b],
    verdict,
  };
}
