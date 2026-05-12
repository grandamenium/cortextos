// Anomaly detection over TurnFact[].
//
// Phase 1 kinds:
//   - outlier_session: session in top 5% project spend OR > 3× project median
//   - cache_runaway:   per-turn cache_write / max(output, 1) > 50
//   - compact_candidate: per-turn cache_read > 200_000 at a safe boundary
//   - idle_burn:        agent usd > 0 with zero completed_task events
//
// trigger_addiction and model_mismatch are Phase 2; gated by signals that
// don't exist until trigger-resolution runs.

import { randomUUID } from 'crypto';
import { rollupSessions } from './aggregate.js';
import type { Anomaly, TurnFact, IdleBurnRow } from './types.js';

export interface DetectOpts {
  auditRunId: string;
  /** Map of agent → completed task events in the window. */
  completedTasksByAgent: Map<string, number>;
  /** Cache-runaway ratio threshold (default 50). */
  cacheRunawayRatio?: number;
  /** Compact-candidate cache_read threshold (default 200_000). */
  compactCacheReadThreshold?: number;
}

export function detectOutlierSessions(turns: TurnFact[], opts: DetectOpts): Anomaly[] {
  const sessions = rollupSessions(turns);
  if (sessions.length === 0) return [];
  const usd = sessions.map((s) => s.usd_total).filter((x) => x > 0).sort((a, b) => a - b);
  if (usd.length === 0) return [];
  const median = usd[Math.floor(usd.length / 2)];
  const p95Index = Math.max(0, Math.floor(usd.length * 0.95) - 1);
  const p95 = usd[p95Index];

  const out: Anomaly[] = [];
  for (const s of sessions) {
    if (s.usd_total <= 0) continue;
    const isP95 = s.usd_total >= p95;
    const is3xMedian = s.usd_total > 3 * median;
    if (!isP95 && !is3xMedian) continue;
    const evidence = turns.filter((t) => t.session_id === s.session_id).map((t) => t.turn_id);
    out.push({
      anomaly_id: randomUUID(),
      audit_run_id: opts.auditRunId,
      kind: 'outlier_session',
      severity: s.usd_total > 5 * median ? 'critical' : 'warning',
      agent: s.agent,
      session_id: s.session_id,
      evidence_turn_ids: evidence,
      usd_impact: s.usd_total,
      why_text:
        `Session ${s.session_id.slice(0, 8)} (${s.agent}) spent $${s.usd_total.toFixed(2)} — ` +
        `${(s.usd_total / Math.max(median, 0.000001)).toFixed(1)}× the project median ($${median.toFixed(2)}).`,
      detected_at: new Date().toISOString(),
      status: 'open',
    });
  }
  return out;
}

export function detectCacheRunaway(turns: TurnFact[], opts: DetectOpts): Anomaly[] {
  const threshold = opts.cacheRunawayRatio ?? 50;
  // Group by session, flag the session if it has any qualifying turns.
  const bySession = new Map<string, TurnFact[]>();
  for (const t of turns) {
    if (!bySession.has(t.session_id)) bySession.set(t.session_id, []);
    bySession.get(t.session_id)!.push(t);
  }
  const out: Anomaly[] = [];
  for (const [sid, ts] of bySession) {
    const offenders = ts.filter((t) => t.cache_write / Math.max(t.output_tokens, 1) > threshold);
    if (offenders.length === 0) continue;
    const usd_impact = offenders.reduce((s, t) => s + t.usd_cache_write, 0);
    out.push({
      anomaly_id: randomUUID(),
      audit_run_id: opts.auditRunId,
      kind: 'cache_runaway',
      severity: usd_impact > 1 ? 'warning' : 'info',
      agent: ts[0].agent,
      session_id: sid,
      evidence_turn_ids: offenders.map((t) => t.turn_id),
      usd_impact,
      why_text:
        `Session ${sid.slice(0, 8)} (${ts[0].agent}) had ${offenders.length} turn(s) with ` +
        `cache_write/output > ${threshold} — $${usd_impact.toFixed(2)} of cache thrash.`,
      detected_at: new Date().toISOString(),
      status: 'open',
    });
  }
  return out;
}

export function detectCompactCandidates(turns: TurnFact[], opts: DetectOpts): Anomaly[] {
  const threshold = opts.compactCacheReadThreshold ?? 200_000;
  // Find sessions where any turn has cache_read above threshold — that's the
  // signal the session is carrying a heavy context for a long time.
  const bySession = new Map<string, TurnFact[]>();
  for (const t of turns) {
    if (!bySession.has(t.session_id)) bySession.set(t.session_id, []);
    bySession.get(t.session_id)!.push(t);
  }
  const out: Anomaly[] = [];
  for (const [sid, ts] of bySession) {
    const heavy = ts.filter((t) => t.cache_read >= threshold);
    if (heavy.length === 0) continue;
    const usd_impact = heavy.reduce((s, t) => s + t.usd_cache_read, 0);
    const peak = Math.max(...heavy.map((t) => t.cache_read));
    out.push({
      anomaly_id: randomUUID(),
      audit_run_id: opts.auditRunId,
      kind: 'compact_candidate',
      severity: peak > 500_000 ? 'warning' : 'info',
      agent: ts[0].agent,
      session_id: sid,
      evidence_turn_ids: heavy.map((t) => t.turn_id),
      usd_impact,
      why_text:
        `Session ${sid.slice(0, 8)} (${ts[0].agent}) carried ≥${threshold.toLocaleString()} cached input tokens ` +
        `across ${heavy.length} turn(s) (peak ${peak.toLocaleString()}). Compact would shed $${usd_impact.toFixed(2)} of cache_read.`,
      detected_at: new Date().toISOString(),
      status: 'open',
    });
  }
  return out;
}

export function detectIdleBurn(turns: TurnFact[], opts: DetectOpts, windowHours: number): {
  anomalies: Anomaly[];
  rows: IdleBurnRow[];
} {
  // Build per-agent spend.
  const byAgent = new Map<string, TurnFact[]>();
  for (const t of turns) {
    if (!byAgent.has(t.agent)) byAgent.set(t.agent, []);
    byAgent.get(t.agent)!.push(t);
  }

  const usdPerTaskValues: number[] = [];
  const tempRows: IdleBurnRow[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const [agent, ts] of byAgent) {
    const usd = ts.reduce((s, t) => s + t.usd_total, 0);
    const tasks = opts.completedTasksByAgent.get(agent) ?? 0;
    if (usd <= 0) continue;
    const usdPerTask = tasks > 0 ? usd / tasks : usd; // Infinity-safe: 0 tasks → cost is the impact
    if (tasks > 0) usdPerTaskValues.push(usdPerTask);
    tempRows.push({
      snapshot_date: today,
      agent,
      window_hours: windowHours,
      usd_spent: usd,
      tasks_completed: tasks,
      usd_per_task: usdPerTask,
      verdict: 'ok',
    });
  }

  usdPerTaskValues.sort((a, b) => a - b);
  const median = usdPerTaskValues.length === 0 ? 0 : usdPerTaskValues[Math.floor(usdPerTaskValues.length / 2)];

  const anomalies: Anomaly[] = [];
  const rows: IdleBurnRow[] = [];
  for (const r of tempRows) {
    let verdict: IdleBurnRow['verdict'] = 'ok';
    let flag = false;
    if (r.tasks_completed === 0 && r.usd_spent > 0) { verdict = 'idle_burn'; flag = true; }
    else if (median > 0 && r.usd_per_task > 5 * median) { verdict = 'idle_burn'; flag = true; }
    rows.push({ ...r, verdict });
    if (!flag) continue;

    const evidence = (byAgent.get(r.agent) ?? []).map((t) => t.turn_id);
    anomalies.push({
      anomaly_id: randomUUID(),
      audit_run_id: opts.auditRunId,
      kind: 'idle_burn',
      severity: r.usd_spent > 1 ? 'warning' : 'info',
      agent: r.agent,
      session_id: null,
      evidence_turn_ids: evidence,
      usd_impact: r.usd_spent,
      why_text:
        r.tasks_completed === 0
          ? `${r.agent} spent $${r.usd_spent.toFixed(2)} over ${r.window_hours}h with zero completed tasks.`
          : `${r.agent} spent $${r.usd_per_task.toFixed(2)}/task — ${(r.usd_per_task / Math.max(median, 0.000001)).toFixed(1)}× fleet median ($${median.toFixed(2)}).`,
      detected_at: new Date().toISOString(),
      status: 'open',
    });
  }

  return { anomalies, rows };
}

/**
 * trigger_addiction: an agent's heartbeat-fired spend is > 3× its user-fired
 * spend over the window. Indicator that an overactive cron is doing
 * autopilot work the user never asked for.
 *
 * Requires trigger-resolution to have run (Phase 2). When trigger_kind is
 * 'unknown' for all turns, this detector returns no anomalies.
 */
export function detectTriggerAddiction(turns: TurnFact[], opts: DetectOpts): Anomaly[] {
  const byAgent = new Map<string, TurnFact[]>();
  for (const t of turns) {
    if (!byAgent.has(t.agent)) byAgent.set(t.agent, []);
    byAgent.get(t.agent)!.push(t);
  }

  const out: Anomaly[] = [];
  for (const [agent, ts] of byAgent) {
    let cronUsd = 0;
    let userUsd = 0;
    const cronTurns: TurnFact[] = [];
    for (const t of ts) {
      if (t.trigger_kind === 'cron') { cronUsd += t.usd_total; cronTurns.push(t); }
      else if (t.trigger_kind === 'user') { userUsd += t.usd_total; }
    }
    // Need at least $0.10 of cron spend AND $0.01 of user spend to make a
    // ratio meaningful — guards against div-by-zero and dust noise.
    if (cronUsd < 0.1) continue;
    if (userUsd < 0.01) {
      // Pure-cron agent with no user activity in window — note as info-level.
      out.push({
        anomaly_id: randomUUID(),
        audit_run_id: opts.auditRunId,
        kind: 'trigger_addiction',
        severity: cronUsd > 2 ? 'warning' : 'info',
        agent,
        session_id: null,
        evidence_turn_ids: cronTurns.map((t) => t.turn_id),
        usd_impact: cronUsd,
        why_text: `${agent} spent ${fmt(cronUsd)} on cron-triggered turns and ${fmt(userUsd)} on user-triggered turns. No user activity in this window — every dollar was autopilot.`,
        detected_at: new Date().toISOString(),
        status: 'open',
      });
      continue;
    }
    const ratio = cronUsd / userUsd;
    if (ratio <= 3) continue;
    out.push({
      anomaly_id: randomUUID(),
      audit_run_id: opts.auditRunId,
      kind: 'trigger_addiction',
      severity: ratio > 10 ? 'critical' : 'warning',
      agent,
      session_id: null,
      evidence_turn_ids: cronTurns.map((t) => t.turn_id),
      usd_impact: cronUsd,
      why_text: `${agent} spent ${fmt(cronUsd)} on cron-triggered turns vs ${fmt(userUsd)} on user-triggered turns (${ratio.toFixed(1)}× ratio). Heartbeat or recurring cron may be doing autopilot work the user never asked for.`,
      detected_at: new Date().toISOString(),
      status: 'open',
    });
  }
  return out;
}

/**
 * model_mismatch: an opus agent whose median turn in the window has small
 * context (< 50k tokens loaded) AND zero subagent calls — that's haiku-class
 * work being done by an opus model.
 */
export function detectModelMismatch(turns: TurnFact[], opts: DetectOpts): Anomaly[] {
  const byAgent = new Map<string, TurnFact[]>();
  for (const t of turns) {
    if (!/opus/i.test(t.model)) continue;
    if (!byAgent.has(t.agent)) byAgent.set(t.agent, []);
    byAgent.get(t.agent)!.push(t);
  }

  const out: Anomaly[] = [];
  for (const [agent, ts] of byAgent) {
    if (ts.length < 7) continue; // need a week-ish of evidence
    const contexts = ts.map((t) => t.input_tokens + t.cache_read + t.cache_write).sort((a, b) => a - b);
    const median = contexts[Math.floor(contexts.length / 2)];
    if (median >= 50_000) continue;
    const anySubagent = ts.some((t) => t.subagents_spawned.length > 0);
    if (anySubagent) continue;
    const usd = ts.reduce((s, t) => s + t.usd_total, 0);
    out.push({
      anomaly_id: randomUUID(),
      audit_run_id: opts.auditRunId,
      kind: 'model_mismatch',
      severity: usd > 5 ? 'warning' : 'info',
      agent,
      session_id: null,
      evidence_turn_ids: ts.map((t) => t.turn_id),
      usd_impact: usd,
      why_text: `${agent} runs on opus but its median turn loads ${median.toLocaleString()} tokens with zero subagent calls. Sonnet or haiku would handle this workload — current spend ${fmt(usd)} over ${ts.length} turns.`,
      detected_at: new Date().toISOString(),
      status: 'open',
    });
  }
  return out;
}

function fmt(n: number): string { return `$${n.toFixed(n < 0.01 && n !== 0 ? 4 : 2)}`; }

export function detectAll(turns: TurnFact[], opts: DetectOpts, windowHours: number): {
  anomalies: Anomaly[];
  idleBurnRows: IdleBurnRow[];
} {
  const out: Anomaly[] = [];
  out.push(...detectOutlierSessions(turns, opts));
  out.push(...detectCacheRunaway(turns, opts));
  out.push(...detectCompactCandidates(turns, opts));
  out.push(...detectTriggerAddiction(turns, opts));
  out.push(...detectModelMismatch(turns, opts));
  const idle = detectIdleBurn(turns, opts, windowHours);
  out.push(...idle.anomalies);
  return { anomalies: out, idleBurnRows: idle.rows };
}
