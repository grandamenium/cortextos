// Recommendation generation + lifecycle for the token-optimizer.
//
// State machine: draft → proposed → approved → applied → measured → {kept|reverted}
//                            └→ rejected (terminal)
//
// Storage: <storePaths.root>/recommendations/<YYYY-MM-DD>.jsonl plus a
// <root>/recommendations/index.json that maps id → latest state.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteSync } from '../utils/atomic.js';
import { rollupSessions } from './aggregate.js';
import { detectTriggerAddiction, detectModelMismatch } from './anomalies.js';
import type { StorePaths } from './store.js';
import type { TurnFact } from './types.js';

export type RecommendationKind =
  | 'model_right_size'
  | 'cron_cadence'
  | 'cron_retire'
  | 'hook_removal'
  | 'subagent_routing'
  | 'compact_strategy'
  | 'ab_verdict_adoption';

export type RecommendationState =
  | 'draft'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'measured'
  | 'kept'
  | 'reverted';

export type BlastRadius = 'low' | 'medium' | 'high';

export interface ProposedChange {
  file: string;          // relative path under agent-dir or framework
  field: string;         // dot-path within the file
  from: unknown;
  to: unknown;
}

export interface Recommendation {
  id: string;
  kind: RecommendationKind;
  target: string;        // agent name | cron name | hook name | file path
  hypothesis: string;
  proposed_change: ProposedChange | null;
  evidence_ids: string[];
  window_start: string;
  window_end: string;
  expected_savings_usd_per_week: number;
  blast_radius: BlastRadius;
  state: RecommendationState;
  created_at: string;
  applied_at: string | null;
  notes: string;
  state_history: Array<{ ts: string; from: RecommendationState | null; to: RecommendationState; notes?: string }>;
}

export interface RecommendationOutcome {
  id: string;
  recommendation_id: string;
  measurement_window_start: string;
  measurement_window_end: string;
  actual_savings_usd: number;
  hypothesis_held: boolean;
  notes: string;
}

// --- generation ------------------------------------------------------------

export interface GenerateOpts {
  turns: TurnFact[];
  since: Date;
  until: Date;
  /** Floor on per-week savings — proposals below this are filtered out. */
  minSavingsUsdPerWeek?: number;
  /** Floor on evidence — proposals with fewer turns are filtered out. */
  minEvidenceTurns?: number;
}

export function generateRecommendations(opts: GenerateOpts): Recommendation[] {
  const minSavings = opts.minSavingsUsdPerWeek ?? 1.0;
  const minEvidence = opts.minEvidenceTurns ?? 10;
  const windowDays = Math.max(1, (opts.until.getTime() - opts.since.getTime()) / 86_400_000);
  const weekScale = 7 / windowDays;
  const now = new Date().toISOString();

  const out: Recommendation[] = [];

  // 1. model_right_size — from model_mismatch anomaly detector.
  // Re-run the detector here rather than reading the anomalies store so
  // the recommendation references the same evidence set the detector saw.
  const mm = detectModelMismatch(opts.turns, {
    auditRunId: 'recommend',
    completedTasksByAgent: new Map(),
  });
  for (const a of mm) {
    if (a.evidence_turn_ids.length < minEvidence) continue;
    const expectedWeekly = a.usd_impact * weekScale * 0.75; // assume sonnet ≈ 25% of opus cost
    if (expectedWeekly < minSavings) continue;
    out.push({
      id: randomUUID(),
      kind: 'model_right_size',
      target: a.agent,
      hypothesis:
        `Downgrade ${a.agent} from opus → sonnet. ${a.evidence_turn_ids.length} turns over the evidence window had ` +
        `small context and no subagent calls — that's haiku/sonnet-class work. Projected savings ` +
        `~$${expectedWeekly.toFixed(2)}/wk (≈75% reduction on this agent's spend).`,
      proposed_change: {
        file: `<agent-dir>/config.json`,
        field: 'model',
        from: 'opus',
        to: 'claude-sonnet-4-6',
      },
      evidence_ids: a.evidence_turn_ids,
      window_start: opts.since.toISOString(),
      window_end: opts.until.toISOString(),
      expected_savings_usd_per_week: expectedWeekly,
      blast_radius: 'low',
      state: 'draft',
      created_at: now,
      applied_at: null,
      notes: '',
      state_history: [{ ts: now, from: null, to: 'draft' }],
    });
  }

  // 2. cron_cadence — from trigger_addiction.
  const ta = detectTriggerAddiction(opts.turns, {
    auditRunId: 'recommend',
    completedTasksByAgent: new Map(),
  });
  for (const a of ta) {
    if (a.evidence_turn_ids.length < minEvidence) continue;
    const expectedWeekly = a.usd_impact * weekScale * 0.33; // halving cadence saves ~33%
    if (expectedWeekly < minSavings) continue;
    out.push({
      id: randomUUID(),
      kind: 'cron_cadence',
      target: a.agent,
      hypothesis:
        `Halve cron cadence on ${a.agent}. ` + a.why_text + ` ` +
        `Projected savings ~$${expectedWeekly.toFixed(2)}/wk if heartbeat interval doubles (e.g. 4h → 8h).`,
      proposed_change: {
        file: `<agent-dir>/config.json`,
        field: 'crons[name=heartbeat].interval',
        from: '4h',
        to: '8h',
      },
      evidence_ids: a.evidence_turn_ids,
      window_start: opts.since.toISOString(),
      window_end: opts.until.toISOString(),
      expected_savings_usd_per_week: expectedWeekly,
      blast_radius: 'medium',
      state: 'draft',
      created_at: now,
      applied_at: now === '' ? null : null,
      notes: '',
      state_history: [{ ts: now, from: null, to: 'draft' }],
    });
  }

  // 3. cron_retire — sessions for an agent where every session in the window
  // was cron-triggered AND produced zero session output (proxy: no tools used).
  // Conservative: only fire when ≥7 days of evidence and a clear no-op pattern.
  if (windowDays >= 7) {
    const sessions = rollupSessions(opts.turns);
    const byAgent = new Map<string, typeof sessions>();
    for (const s of sessions) {
      if (!byAgent.has(s.agent)) byAgent.set(s.agent, []);
      byAgent.get(s.agent)!.push(s);
    }
    for (const [agent, ss] of byAgent) {
      const cronSessions = ss.filter((s) => s.trigger_kind === 'cron');
      if (cronSessions.length < minEvidence) continue;
      // Inspect tool usage: get all turns for these sessions.
      const cronTurns = opts.turns.filter((t) => cronSessions.some((s) => s.session_id === t.session_id));
      const noopTurns = cronTurns.filter((t) => t.tools_used.length === 0);
      if (noopTurns.length < 0.9 * cronTurns.length) continue; // need ≥90% no-op
      const usd = cronSessions.reduce((s, x) => s + x.usd_total, 0);
      const expectedWeekly = usd * weekScale * 0.9;
      if (expectedWeekly < minSavings) continue;
      // Pick the dominant cron name.
      const cronNames = new Map<string, number>();
      for (const s of cronSessions) {
        if (!s.trigger_name) continue;
        cronNames.set(s.trigger_name, (cronNames.get(s.trigger_name) ?? 0) + 1);
      }
      const dominant = Array.from(cronNames.entries()).sort((a, b) => b[1] - a[1])[0];
      if (!dominant) continue;
      out.push({
        id: randomUUID(),
        kind: 'cron_retire',
        target: `${agent}/${dominant[0]}`,
        hypothesis:
          `Retire the \`${dominant[0]}\` cron on ${agent}. Over the last ${windowDays.toFixed(0)} days it fired ` +
          `${dominant[1]} time(s), and ≥90% of those sessions used zero tools. Projected savings ` +
          `~$${expectedWeekly.toFixed(2)}/wk.`,
        proposed_change: {
          file: `<agent-dir>/config.json`,
          field: `crons[name=${dominant[0]}]`,
          from: 'present',
          to: 'removed',
        },
        evidence_ids: cronTurns.map((t) => t.turn_id),
        window_start: opts.since.toISOString(),
        window_end: opts.until.toISOString(),
        expected_savings_usd_per_week: expectedWeekly,
        blast_radius: 'medium',
        state: 'draft',
        created_at: now,
        applied_at: null,
        notes: '',
        state_history: [{ ts: now, from: null, to: 'draft' }],
      });
    }
  }

  return out;
}

// --- persistence -----------------------------------------------------------

function recsPaths(store: StorePaths): { dir: string; indexPath: string } {
  return {
    dir: join(store.root, 'recommendations'),
    indexPath: join(store.root, 'recommendations', 'index.json'),
  };
}

export function persistRecommendations(store: StorePaths, recs: Recommendation[]): void {
  if (recs.length === 0) return;
  const { dir } = recsPaths(store);
  mkdirSync(dir, { recursive: true });
  const byDay = new Map<string, string[]>();
  for (const r of recs) {
    const day = r.created_at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(JSON.stringify(r));
  }
  for (const [day, lines] of byDay) {
    appendFileSync(join(dir, `${day}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  }
  // Update index: append id → latest record location.
  const idx = readIndex(store);
  for (const r of recs) idx[r.id] = { state: r.state, created_at: r.created_at };
  writeIndex(store, idx);
}

function readIndex(store: StorePaths): Record<string, { state: RecommendationState; created_at: string }> {
  const { indexPath } = recsPaths(store);
  if (!existsSync(indexPath)) return {};
  try { return JSON.parse(readFileSync(indexPath, 'utf-8')); } catch { return {}; }
}

function writeIndex(store: StorePaths, idx: Record<string, { state: RecommendationState; created_at: string }>): void {
  const { indexPath } = recsPaths(store);
  atomicWriteSync(indexPath, JSON.stringify(idx, null, 2));
}

export function readRecommendations(store: StorePaths): Recommendation[] {
  const { dir } = recsPaths(store);
  if (!existsSync(dir)) return [];
  // For each recommendation id, return the latest record.
  const byId = new Map<string, Recommendation>();
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Recommendation;
        const existing = byId.get(r.id);
        // Keep the latest version (most recent created_at OR if appended later in file).
        if (!existing || new Date(r.created_at).getTime() >= new Date(existing.created_at).getTime()) {
          byId.set(r.id, r);
        }
      } catch { /* skip */ }
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const VALID_TRANSITIONS: Record<RecommendationState, RecommendationState[]> = {
  draft: ['proposed', 'rejected'],
  proposed: ['approved', 'rejected'],
  approved: ['applied', 'rejected'],
  rejected: [],
  applied: ['measured'],
  measured: ['kept', 'reverted'],
  kept: [],
  reverted: [],
};

export function updateRecommendationState(
  store: StorePaths,
  id: string,
  to: RecommendationState,
  notes?: string,
): Recommendation | null {
  const all = readRecommendations(store);
  const r = all.find((x) => x.id === id);
  if (!r) return null;
  const allowed = VALID_TRANSITIONS[r.state] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid transition ${r.state} → ${to} for ${id}. Allowed: ${allowed.join(', ')}`);
  }
  const now = new Date().toISOString();
  const updated: Recommendation = {
    ...r,
    state: to,
    applied_at: to === 'applied' ? now : r.applied_at,
    notes: notes ?? r.notes,
    state_history: [...r.state_history, { ts: now, from: r.state, to, notes }],
  };
  // Append a new record (history is preserved via the file's append-only log).
  persistRecommendations(store, [{ ...updated, created_at: now }]);
  return updated;
}

// --- outcome measurement ---------------------------------------------------

export interface MeasureOpts {
  recommendation: Recommendation;
  postApplyTurns: TurnFact[];
}

export function measureOutcome(opts: MeasureOpts): RecommendationOutcome {
  const r = opts.recommendation;
  // Compute actual USD spent in the post-apply window for the affected agent.
  // Naive: assume target identifies an agent for model_right_size + cron_cadence.
  const agent = r.target.split('/')[0];
  const usd = opts.postApplyTurns
    .filter((t) => t.agent === agent)
    .reduce((s, t) => s + t.usd_total, 0);
  // Roll to weekly.
  const windowDays = opts.postApplyTurns.length > 0
    ? (new Date(opts.postApplyTurns[opts.postApplyTurns.length - 1].ts).getTime() -
       new Date(opts.postApplyTurns[0].ts).getTime()) / 86_400_000
    : 7;
  const weekly = usd * (7 / Math.max(windowDays, 1));
  // Heuristic: hypothesis held if post-apply weekly is < 0.5 × baseline weekly.
  // baseline weekly = pre-apply usd * 7 / preWindowDays; we don't have pre-apply
  // turns here, so we use expected_savings as a proxy. A more rigorous version
  // would store baseline_usd_per_week on the Recommendation; deferred.
  const expected = r.expected_savings_usd_per_week;
  const actualSavings = Math.max(0, expected - weekly);
  const hypothesisHeld = actualSavings >= 0.5 * expected;
  return {
    id: randomUUID(),
    recommendation_id: r.id,
    measurement_window_start: opts.postApplyTurns[0]?.ts ?? new Date().toISOString(),
    measurement_window_end: opts.postApplyTurns[opts.postApplyTurns.length - 1]?.ts ?? new Date().toISOString(),
    actual_savings_usd: actualSavings,
    hypothesis_held: hypothesisHeld,
    notes: hypothesisHeld
      ? `Post-apply weekly $${weekly.toFixed(2)} — savings $${actualSavings.toFixed(2)}/wk ≥ 50% of expected $${expected.toFixed(2)}.`
      : `Post-apply weekly $${weekly.toFixed(2)} — savings only $${actualSavings.toFixed(2)}/wk vs expected $${expected.toFixed(2)}. File a revert proposal.`,
  };
}

export function persistOutcome(store: StorePaths, outcome: RecommendationOutcome): void {
  const dir = join(store.root, 'recommendation-outcomes');
  mkdirSync(dir, { recursive: true });
  const day = outcome.measurement_window_end.slice(0, 10);
  appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify(outcome) + '\n', 'utf-8');
  void writeFileSync; // unused
}
