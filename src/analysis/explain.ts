// Drill-back rendering for `cortextos bus token-audit explain <target>`.
//
// Target syntax: kind:value
//   agent:<name>        — fleet-wide attribution summary for the agent in window
//   session:<id>        — turn-by-turn timeline of the session
//   anomaly:<uuid>      — anomaly record + every turn it cites + verbatim trigger info
//   recommendation:<id> — proposed change + supporting turns + expected vs actual savings (Phase 3)
//   file:<path>         — every turn that touched this file ordered by USD
//
// All output is JSON; the CLI verb formats it as text when --format=text.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Anomaly, TurnFact } from './types.js';

export type ExplainKind = 'agent' | 'session' | 'anomaly' | 'recommendation' | 'file';

export interface ParsedTarget {
  kind: ExplainKind;
  value: string;
}

export function parseTarget(target: string): ParsedTarget {
  const idx = target.indexOf(':');
  if (idx === -1) throw new Error(`Invalid target "${target}". Expected kind:value (e.g. session:abc123)`);
  const kind = target.slice(0, idx).toLowerCase() as ExplainKind;
  const value = target.slice(idx + 1);
  const valid: ExplainKind[] = ['agent', 'session', 'anomaly', 'recommendation', 'file'];
  if (!valid.includes(kind)) throw new Error(`Unknown explain kind "${kind}". Valid: ${valid.join(', ')}`);
  if (!value) throw new Error('Empty value');
  return { kind, value };
}

export interface ExplainOpts {
  target: ParsedTarget;
  turns: TurnFact[];
  /** Optional anomalies list (for anomaly: target). */
  anomaliesDir?: string;
}

export interface ExplainResult {
  target: ParsedTarget;
  summary: string;
  rows: Record<string, unknown>[];
  evidence_ids: string[];
}

export function explainTurn(t: TurnFact): Record<string, unknown> {
  return {
    turn_id: t.turn_id,
    ts: t.ts,
    agent: t.agent,
    runtime: t.runtime,
    session_id: t.session_id,
    model: t.model,
    usd_total: t.usd_total,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cache_read: t.cache_read,
    cache_write: t.cache_write,
    is_sidechain: t.is_sidechain,
    trigger: {
      kind: t.trigger_kind,
      name: t.trigger_name,
      prompt: t.trigger_prompt,
    },
    session_opener: t.session_opener,
    tools_used: t.tools_used,
    files_touched: t.files_touched,
    bash_verbs: t.bash_verbs,
    subagents_spawned: t.subagents_spawned,
  };
}

export function explain(opts: ExplainOpts): ExplainResult {
  const { target, turns } = opts;
  switch (target.kind) {
    case 'agent':       return explainAgent(target, turns);
    case 'session':     return explainSession(target, turns);
    case 'file':        return explainFile(target, turns);
    case 'anomaly':     return explainAnomaly(target, turns, opts.anomaliesDir);
    case 'recommendation': return explainRecommendation(target);
  }
}

function explainAgent(target: ParsedTarget, turns: TurnFact[]): ExplainResult {
  const ts = turns.filter((t) => t.agent === target.value);
  const usd = ts.reduce((s, t) => s + t.usd_total, 0);
  const triggers = new Map<string, number>();
  for (const t of ts) {
    const k = `${t.trigger_kind}:${t.trigger_name ?? ''}`;
    triggers.set(k, (triggers.get(k) ?? 0) + t.usd_total);
  }
  const trig = Array.from(triggers.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return {
    target,
    summary: `${target.value}: ${ts.length} turn(s), ${fmt(usd)} total. Top triggers: ${trig.map((e) => `${e[0]} (${fmt(e[1])})`).join(', ')}`,
    rows: trig.map(([k, v]) => ({ trigger: k, usd_total: v })),
    evidence_ids: ts.map((t) => t.turn_id),
  };
}

function explainSession(target: ParsedTarget, turns: TurnFact[]): ExplainResult {
  const ts = turns.filter((t) => t.session_id === target.value).sort((a, b) => a.ts.localeCompare(b.ts));
  const usd = ts.reduce((s, t) => s + t.usd_total, 0);
  return {
    target,
    summary: `Session ${target.value}: ${ts.length} turn(s), ${fmt(usd)} total, agent=${ts[0]?.agent ?? '?'}, trigger=${ts[0]?.trigger_kind ?? '?'}/${ts[0]?.trigger_name ?? '?'}`,
    rows: ts.map(explainTurn),
    evidence_ids: ts.map((t) => t.turn_id),
  };
}

function explainFile(target: ParsedTarget, turns: TurnFact[]): ExplainResult {
  const ts = turns.filter((t) => t.files_touched.includes(target.value)).sort((a, b) => b.usd_total - a.usd_total);
  const usd = ts.reduce((s, t) => s + t.usd_total, 0);
  return {
    target,
    summary: `File ${target.value} touched in ${ts.length} turn(s), ${fmt(usd)} total spend across those turns.`,
    rows: ts.map(explainTurn),
    evidence_ids: ts.map((t) => t.turn_id),
  };
}

function explainAnomaly(target: ParsedTarget, turns: TurnFact[], anomaliesDir?: string): ExplainResult {
  if (!anomaliesDir || !existsSync(anomaliesDir)) {
    return {
      target,
      summary: `Anomaly ${target.value}: anomalies directory not found.`,
      rows: [],
      evidence_ids: [],
    };
  }
  // Walk the anomalies dir for the matching uuid.
  let match: Anomaly | null = null;
  for (const file of readdirSync(anomaliesDir).filter((f) => f.endsWith('.jsonl'))) {
    const content = readFileSync(join(anomaliesDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const a = JSON.parse(line) as Anomaly;
        if (a.anomaly_id === target.value) { match = a; break; }
      } catch { /* */ }
    }
    if (match) break;
  }
  if (!match) {
    return { target, summary: `Anomaly ${target.value}: not found.`, rows: [], evidence_ids: [] };
  }
  const evidenceTurns = turns.filter((t) => match!.evidence_turn_ids.includes(t.turn_id));
  return {
    target,
    summary:
      `Anomaly ${match.anomaly_id} — ${match.kind} — ${match.severity} — ${match.agent} — impact ${fmt(match.usd_impact)}\n${match.why_text}`,
    rows: [{ anomaly: match }, ...evidenceTurns.map(explainTurn)],
    evidence_ids: match.evidence_turn_ids,
  };
}

function explainRecommendation(target: ParsedTarget): ExplainResult {
  // Phase 3 fills this in fully; here we return a stub so the verb is wired.
  return {
    target,
    summary: `Recommendation ${target.value}: Phase 3 — read recommendations/*.jsonl and join with turns. Not yet implemented.`,
    rows: [],
    evidence_ids: [],
  };
}

function fmt(n: number): string {
  return `$${n.toFixed(n < 0.01 && n !== 0 ? 4 : 2)}`;
}
