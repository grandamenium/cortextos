import { describe, it, expect } from 'vitest';
import {
  detectTriggerAddiction,
  detectModelMismatch,
} from '../../../src/analysis/anomalies';
import { history } from '../../../src/analysis/history';
import { abCompare } from '../../../src/analysis/ab-compare';
import { parseTarget, explain } from '../../../src/analysis/explain';
import type { TurnFact, Anomaly } from '../../../src/analysis/types';

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

describe('detectTriggerAddiction', () => {
  it('flags agents with cron USD > 3× user USD', () => {
    const turns: TurnFact[] = [];
    // cron-triggered: 11 turns at $1 = $11 → ratio 11:1, > 10 → critical
    for (let i = 0; i < 11; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        trigger_kind: 'cron', trigger_name: 'heartbeat', usd_total: 1,
      }));
    }
    // user-triggered: 1 turn at $1
    turns.push(fixtureTurn({
      turn_id: 'a::user::u1', session_id: 'user',
      trigger_kind: 'user', trigger_name: 'terminal', usd_total: 1,
    }));

    const out = detectTriggerAddiction(turns, { auditRunId: 'r', completedTasksByAgent: new Map() });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('trigger_addiction');
    expect(out[0].severity).toBe('critical');
  });

  it('does not flag balanced agents', () => {
    const turns: TurnFact[] = [
      fixtureTurn({ trigger_kind: 'cron', trigger_name: 'heartbeat', usd_total: 2 }),
      fixtureTurn({ turn_id: 'a::s2::u1', session_id: 's2', trigger_kind: 'user', trigger_name: 'terminal', usd_total: 5 }),
    ];
    expect(detectTriggerAddiction(turns, { auditRunId: 'r', completedTasksByAgent: new Map() })).toHaveLength(0);
  });
});

describe('detectModelMismatch', () => {
  it('flags opus agents with small-context, no-subagent work', () => {
    const turns: TurnFact[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        model: 'claude-opus-4-7', input_tokens: 5_000, cache_read: 10_000,
        usd_total: 0.8, subagents_spawned: [],
      }));
    }
    const out = detectModelMismatch(turns, { auditRunId: 'r', completedTasksByAgent: new Map() });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('model_mismatch');
  });

  it('does not flag opus agents that use subagents', () => {
    const turns: TurnFact[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        model: 'opus', input_tokens: 5_000, subagents_spawned: ['Explore'],
      }));
    }
    expect(detectModelMismatch(turns, { auditRunId: 'r', completedTasksByAgent: new Map() })).toHaveLength(0);
  });

  it('does not flag opus with large context', () => {
    const turns: TurnFact[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push(fixtureTurn({
        turn_id: `a::s${i}::u1`, session_id: `s${i}`,
        model: 'opus', input_tokens: 100_000, cache_read: 200_000,
      }));
    }
    expect(detectModelMismatch(turns, { auditRunId: 'r', completedTasksByAgent: new Map() })).toHaveLength(0);
  });
});

describe('history', () => {
  it('rolls up daily buckets', () => {
    const turns: TurnFact[] = [
      fixtureTurn({ ts: '2026-05-10T10:00:00Z', usd_total: 1 }),
      fixtureTurn({ turn_id: 'a::s2::u1', session_id: 's2', ts: '2026-05-10T15:00:00Z', usd_total: 2 }),
      fixtureTurn({ turn_id: 'a::s3::u1', session_id: 's3', ts: '2026-05-11T10:00:00Z', usd_total: 4 }),
    ];
    const rows = history(turns, { bucket: 'day' });
    expect(rows).toHaveLength(2);
    expect(rows[0].bucket).toBe('2026-05-10');
    expect(rows[0].usd_total).toBe(3);
    expect(rows[1].bucket).toBe('2026-05-11');
    expect(rows[1].usd_total).toBe(4);
  });

  it('filters by agent', () => {
    const turns: TurnFact[] = [
      fixtureTurn({ agent: 'engineer', usd_total: 1 }),
      fixtureTurn({ turn_id: 'a::s2::u1', agent: 'analyst', usd_total: 5 }),
    ];
    const rows = history(turns, { agent: 'engineer', bucket: 'day' });
    expect(rows).toHaveLength(1);
    expect(rows[0].usd_total).toBe(1);
  });
});

describe('abCompare', () => {
  it('produces a verdict citing USD/task ratio', () => {
    const turns: TurnFact[] = [
      fixtureTurn({ agent: 'devops', usd_total: 10 }),
      fixtureTurn({ turn_id: 'a::s2::u1', agent: 'devops-c', usd_total: 2 }),
    ];
    const tasks = new Map([['devops', 5], ['devops-c', 5]]);
    const result = abCompare({
      agentA: 'devops',
      agentB: 'devops-c',
      turns,
      anomalies: [],
      tasksByAgent: tasks,
      since: new Date('2026-05-01'),
      until: new Date('2026-05-08'),
    });
    expect(result.rows[0].usd_per_task).toBeCloseTo(2, 4);
    expect(result.rows[1].usd_per_task).toBeCloseTo(0.4, 4);
    expect(result.verdict).toMatch(/devops-c spent/);
  });
});

describe('explain', () => {
  it('parses target syntax', () => {
    expect(parseTarget('session:abc')).toEqual({ kind: 'session', value: 'abc' });
    expect(parseTarget('agent:engineer')).toEqual({ kind: 'agent', value: 'engineer' });
    expect(() => parseTarget('nope')).toThrow();
    expect(() => parseTarget('bad:value')).toThrow();
  });

  it('explains a session by listing its turns', () => {
    const turns: TurnFact[] = [
      fixtureTurn({ turn_id: 'a::s1::u1', session_id: 's1', ts: '2026-05-12T10:00:00Z', usd_total: 1 }),
      fixtureTurn({ turn_id: 'a::s1::u2', session_id: 's1', ts: '2026-05-12T10:01:00Z', usd_total: 2 }),
      fixtureTurn({ turn_id: 'a::s2::u1', session_id: 's2', usd_total: 5 }),
    ];
    const result = explain({ target: parseTarget('session:s1'), turns });
    expect(result.rows).toHaveLength(2);
    expect(result.evidence_ids).toEqual(['a::s1::u1', 'a::s1::u2']);
  });

  it('explains anomaly drill-back', () => {
    // synthetic anomaly + matching turn
    const t = fixtureTurn({ turn_id: 'a::s1::u1' });
    const anomaly: Anomaly = {
      anomaly_id: 'x-uuid',
      audit_run_id: 'r',
      kind: 'outlier_session',
      severity: 'warning',
      agent: 'engineer',
      session_id: 's1',
      evidence_turn_ids: ['a::s1::u1'],
      usd_impact: 1,
      why_text: 'test',
      detected_at: '2026-05-12T10:00:00Z',
      status: 'open',
    };
    // Write to a synthetic anomalies dir.
    const dir = `/tmp/_phase2_test_${Date.now()}`;
    require('fs').mkdirSync(dir, { recursive: true });
    require('fs').writeFileSync(`${dir}/2026-05-12.jsonl`, JSON.stringify(anomaly) + '\n');

    const result = explain({
      target: parseTarget('anomaly:x-uuid'),
      turns: [t],
      anomaliesDir: dir,
    });
    expect(result.evidence_ids).toEqual(['a::s1::u1']);
    expect(result.summary).toContain('outlier_session');
    require('fs').rmSync(dir, { recursive: true, force: true });
  });
});
