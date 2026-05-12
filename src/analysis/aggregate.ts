// In-memory aggregation primitives over TurnFact[].
//
// All aggregates return both row data and the evidence_ids that produced
// them, so any caller can drill back via `explain` (Phase 2).

import type { TurnFact, SessionFact } from './types.js';

export type GroupDimension =
  | 'agent'
  | 'model'
  | 'day'
  | 'session'
  | 'tool'
  | 'file'
  | 'subagent'
  | 'bash-verb'
  | 'trigger'
  | 'agent-x-trigger';

export interface AggregateRow {
  key: string;
  usd_total: number;
  usd_input: number;
  usd_output: number;
  usd_cache_read: number;
  usd_cache_write: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  turn_count: number;
  evidence_ids: string[];
}

export interface AggregateResult {
  rows: AggregateRow[];
  totals: Omit<AggregateRow, 'key' | 'evidence_ids'> & { evidence_ids: string[] };
}

function emptyRow(key: string): AggregateRow {
  return {
    key,
    usd_total: 0, usd_input: 0, usd_output: 0, usd_cache_read: 0, usd_cache_write: 0,
    input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
    turn_count: 0, evidence_ids: [],
  };
}

function addToRow(row: AggregateRow, t: TurnFact, usdShare = 1, tokenShare = 1): void {
  row.usd_total += t.usd_total * usdShare;
  row.usd_input += t.usd_input * usdShare;
  row.usd_output += t.usd_output * usdShare;
  row.usd_cache_read += t.usd_cache_read * usdShare;
  row.usd_cache_write += t.usd_cache_write * usdShare;
  row.input_tokens += t.input_tokens * tokenShare;
  row.output_tokens += t.output_tokens * tokenShare;
  row.cache_read += t.cache_read * tokenShare;
  row.cache_write += t.cache_write * tokenShare;
  row.turn_count += 1;
  row.evidence_ids.push(t.turn_id);
}

function keyFor(turn: TurnFact, dim: GroupDimension): string[] {
  switch (dim) {
    case 'agent': return [turn.agent];
    case 'model': return [turn.model];
    case 'day': return [turn.ts.slice(0, 10)];
    case 'session': return [turn.session_id];
    case 'trigger': return [turn.trigger_kind === 'unknown' ? 'unknown' : `${turn.trigger_kind}:${turn.trigger_name ?? ''}`];
    case 'agent-x-trigger': return [`${turn.agent}|${turn.trigger_kind}:${turn.trigger_name ?? ''}`];
    case 'tool': return turn.tools_used.map((tu) => tu.name);
    case 'file': return turn.files_touched;
    case 'subagent': return turn.subagents_spawned;
    case 'bash-verb': return turn.bash_verbs;
  }
}

export function aggregate(turns: TurnFact[], dim: GroupDimension): AggregateResult {
  const map = new Map<string, AggregateRow>();
  const totals = emptyRow('TOTAL');

  for (const t of turns) {
    const keys = keyFor(t, dim);
    // For per-tool/file/etc aggregations: split USD across the keys (each
    // turn allocates its USD evenly across the things it touched).
    // For top-level dims (agent/model/day/session/trigger) there's always
    // exactly one key, so share = 1.
    const fanout = keys.length === 0 ? 0 : keys.length;
    if (fanout === 0) {
      addToRow(totals, t, 1, 1);
      continue;
    }
    const share = 1 / fanout;
    // Per-tool special case: split by input_chars (more characters → more
    // expensive tool use). Falls back to even share if all are zero.
    if (dim === 'tool' && t.tools_used.length > 0) {
      const totalChars = t.tools_used.reduce((s, tu) => s + tu.input_chars, 0);
      for (const tu of t.tools_used) {
        const tShare = totalChars > 0 ? tu.input_chars / totalChars : share;
        let row = map.get(tu.name);
        if (!row) { row = emptyRow(tu.name); map.set(tu.name, row); }
        addToRow(row, t, tShare, tShare);
      }
      addToRow(totals, t, 1, 1);
      continue;
    }
    for (const k of keys) {
      let row = map.get(k);
      if (!row) { row = emptyRow(k); map.set(k, row); }
      addToRow(row, t, share, share);
    }
    addToRow(totals, t, 1, 1);
  }

  const rows = Array.from(map.values()).sort((a, b) => b.usd_total - a.usd_total);
  return { rows, totals };
}

// --- session rollup --------------------------------------------------------

export function rollupSessions(turns: TurnFact[]): SessionFact[] {
  const bySession = new Map<string, TurnFact[]>();
  for (const t of turns) {
    if (!bySession.has(t.session_id)) bySession.set(t.session_id, []);
    bySession.get(t.session_id)!.push(t);
  }
  const out: SessionFact[] = [];
  for (const [sid, ts] of bySession) {
    ts.sort((a, b) => a.ts.localeCompare(b.ts));
    const usd_total = ts.reduce((s, t) => s + t.usd_total, 0);
    out.push({
      session_id: sid,
      agent: ts[0].agent,
      runtime: ts[0].runtime,
      started_at: ts[0].ts,
      ended_at: ts[ts.length - 1].ts,
      turn_count: ts.length,
      usd_total,
      trigger_kind: ts[0].trigger_kind,
      trigger_name: ts[0].trigger_name,
    });
  }
  return out.sort((a, b) => b.usd_total - a.usd_total);
}
