import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  generateRecommendations,
  persistRecommendations,
  readRecommendations,
  updateRecommendationState,
  measureOutcome,
} from '../../../src/analysis/recommendations';
import { resolveStorePaths } from '../../../src/analysis/store';
import type { TurnFact } from '../../../src/analysis/types';

function fixtureTurn(over: Partial<TurnFact>): TurnFact {
  return {
    turn_id: 'agent::s1::u1',
    agent: 'engineer',
    runtime: 'claude',
    session_id: 's1',
    ts: '2026-05-12T10:00:00Z',
    model: 'opus',
    input_tokens: 100, output_tokens: 50, cache_read: 0, cache_write: 0,
    usd_input: 0, usd_output: 0, usd_cache_read: 0, usd_cache_write: 0,
    usd_total: 0,
    is_sidechain: false,
    trigger_kind: 'unknown', trigger_name: null, trigger_prompt: null, session_opener: null, parent_session: null,
    tools_used: [], files_touched: [], bash_verbs: [], subagents_spawned: [],
    audit_run_id: 'r', source_file: '/x',
    ...over,
  };
}

describe('generateRecommendations', () => {
  it('proposes model_right_size for opus agents doing haiku work', () => {
    const turns: TurnFact[] = [];
    for (let i = 0; i < 12; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        ts: `2026-05-${(10 + Math.floor(i / 2)).toString().padStart(2, '0')}T10:00:00Z`,
        model: 'claude-opus-4-7',
        input_tokens: 5_000, cache_read: 10_000,
        usd_total: 1.5,
      }));
    }
    const recs = generateRecommendations({
      turns,
      since: new Date('2026-05-09'),
      until: new Date('2026-05-16'),
    });
    expect(recs.length).toBeGreaterThanOrEqual(1);
    const mr = recs.find((r) => r.kind === 'model_right_size');
    expect(mr).toBeDefined();
    expect(mr!.evidence_ids.length).toBeGreaterThanOrEqual(10);
    expect(mr!.expected_savings_usd_per_week).toBeGreaterThan(1);
    expect(mr!.state).toBe('draft');
    expect(mr!.proposed_change).not.toBeNull();
  });

  it('skips proposals below the savings floor', () => {
    const turns: TurnFact[] = [];
    // 12 turns at $0.001 each = $0.012 over 7d → weekly savings far below $1
    for (let i = 0; i < 12; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        ts: `2026-05-${(10 + Math.floor(i / 2)).toString().padStart(2, '0')}T10:00:00Z`,
        model: 'opus', input_tokens: 1000, usd_total: 0.001,
      }));
    }
    const recs = generateRecommendations({
      turns,
      since: new Date('2026-05-09'),
      until: new Date('2026-05-16'),
    });
    expect(recs.filter((r) => r.kind === 'model_right_size')).toHaveLength(0);
  });

  it('skips proposals below the evidence floor', () => {
    const turns: TurnFact[] = [];
    for (let i = 0; i < 5; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        ts: `2026-05-${(10 + Math.floor(i / 2)).toString().padStart(2, '0')}T10:00:00Z`,
        model: 'opus', input_tokens: 5_000, usd_total: 1.5,
      }));
    }
    const recs = generateRecommendations({
      turns,
      since: new Date('2026-05-09'),
      until: new Date('2026-05-16'),
    });
    expect(recs).toHaveLength(0);
  });
});

describe('lifecycle persistence + state machine', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'recs-')); });
  afterEach(() => rmSync(ctxRoot, { recursive: true, force: true }));

  it('persists and reads recommendations', () => {
    const store = resolveStorePaths(ctxRoot);
    const turns: TurnFact[] = [];
    for (let i = 0; i < 12; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        ts: `2026-05-${(10 + Math.floor(i / 2)).toString().padStart(2, '0')}T10:00:00Z`,
        model: 'opus', input_tokens: 5_000, usd_total: 1.5,
      }));
    }
    const recs = generateRecommendations({
      turns, since: new Date('2026-05-09'), until: new Date('2026-05-16'),
    });
    persistRecommendations(store, recs);
    const read = readRecommendations(store);
    expect(read).toHaveLength(recs.length);
    expect(read[0].id).toBe(recs[0].id);
  });

  it('drives a recommendation through the state machine', () => {
    const store = resolveStorePaths(ctxRoot);
    const turns: TurnFact[] = [];
    for (let i = 0; i < 12; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        ts: `2026-05-${(10 + Math.floor(i / 2)).toString().padStart(2, '0')}T10:00:00Z`,
        model: 'opus', input_tokens: 5_000, usd_total: 1.5,
      }));
    }
    const recs = generateRecommendations({
      turns, since: new Date('2026-05-09'), until: new Date('2026-05-16'),
    });
    persistRecommendations(store, recs);
    const id = recs[0].id;

    expect(updateRecommendationState(store, id, 'proposed')!.state).toBe('proposed');
    expect(updateRecommendationState(store, id, 'approved')!.state).toBe('approved');
    expect(updateRecommendationState(store, id, 'applied')!.state).toBe('applied');
    expect(updateRecommendationState(store, id, 'measured')!.state).toBe('measured');
    expect(updateRecommendationState(store, id, 'kept')!.state).toBe('kept');
  });

  it('rejects invalid transitions', () => {
    const store = resolveStorePaths(ctxRoot);
    const turns: TurnFact[] = [];
    for (let i = 0; i < 12; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        ts: `2026-05-${(10 + Math.floor(i / 2)).toString().padStart(2, '0')}T10:00:00Z`,
        model: 'opus', input_tokens: 5_000, usd_total: 1.5,
      }));
    }
    const recs = generateRecommendations({
      turns, since: new Date('2026-05-09'), until: new Date('2026-05-16'),
    });
    persistRecommendations(store, recs);
    const id = recs[0].id;
    expect(() => updateRecommendationState(store, id, 'applied')).toThrow(); // can't skip from draft
    expect(() => updateRecommendationState(store, id, 'kept')).toThrow();
  });
});

describe('measureOutcome', () => {
  it('returns hypothesis_held=true when post-apply savings ≥ 50% of expected', () => {
    const rec = {
      id: 'r1',
      kind: 'model_right_size' as const,
      target: 'engineer',
      hypothesis: 'x',
      proposed_change: null,
      evidence_ids: [],
      window_start: '2026-05-01T00:00:00Z',
      window_end: '2026-05-08T00:00:00Z',
      expected_savings_usd_per_week: 10,
      blast_radius: 'low' as const,
      state: 'applied' as const,
      created_at: '2026-05-08T00:00:00Z',
      applied_at: '2026-05-08T00:00:00Z',
      notes: '',
      state_history: [],
    };
    // Post-apply: $2/wk spend → savings = expected - actual = 10 - 2 = 8 ≥ 5 (50%).
    const postApply = [
      fixtureTurn({ ts: '2026-05-08T10:00:00Z', usd_total: 1 }),
      fixtureTurn({ turn_id: 'a::s2::u1', session_id: 's2', ts: '2026-05-15T10:00:00Z', usd_total: 1 }),
    ];
    const outcome = measureOutcome({ recommendation: rec, postApplyTurns: postApply });
    expect(outcome.hypothesis_held).toBe(true);
    expect(outcome.actual_savings_usd).toBeGreaterThanOrEqual(5);
  });
});
