import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { MODEL_PRICING, calculateCost, costBreakdown } from '../../../src/analysis/pricing';
import { parseClaudeTranscript, parseCodexLog, ingestAll } from '../../../src/analysis/ingest';
import { aggregate, rollupSessions } from '../../../src/analysis/aggregate';
import {
  detectOutlierSessions,
  detectCacheRunaway,
  detectCompactCandidates,
  detectIdleBurn,
  detectAll,
} from '../../../src/analysis/anomalies';
import { runAudit, readWindow } from '../../../src/analysis/token-audit';
import type { TurnFact } from '../../../src/analysis/types';

// -- pricing drift check ----------------------------------------------------
// The pricing table in src/analysis/pricing.ts is intentionally duplicated
// from dashboard/src/lib/cost-parser.ts for mergeability (see the pricing.ts
// header). This test asserts byte-for-byte equivalence. If it fails, sync
// the table that changed into the other.

describe('MODEL_PRICING drift check', () => {
  it('matches dashboard cost-parser MODEL_PRICING shape exactly', async () => {
    // Inline the dashboard table here rather than importing it (the dashboard
    // module pulls in @/lib/db which requires next runtime). Keep this block
    // byte-identical to dashboard/src/lib/cost-parser.ts:21-28.
    const DASHBOARD_PRICING = {
      opus: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 3.75, cacheReadPerMillion: 1.50 },
      sonnet: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30 },
      haiku: { inputPerMillion: 0.8, outputPerMillion: 4, cacheWritePerMillion: 1.00, cacheReadPerMillion: 0.08 },
      'gpt-5-codex': { inputPerMillion: 1.25, outputPerMillion: 10, cacheWritePerMillion: 0, cacheReadPerMillion: 0.125 },
    };
    expect(MODEL_PRICING).toEqual(DASHBOARD_PRICING);
  });
});

// -- cost math --------------------------------------------------------------

describe('calculateCost', () => {
  it('opus: 1M input + 1M output + 1M cache_write + 1M cache_read', () => {
    const c = calculateCost('opus', 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(c).toBeCloseTo(15 + 75 + 3.75 + 1.5, 4);
  });
  it('haiku: 100k input only', () => {
    expect(calculateCost('haiku', 100_000, 0)).toBeCloseTo(0.08, 4);
  });
  it('gpt-5-codex resolves via lowercase substring', () => {
    expect(calculateCost('gpt-5-codex', 1_000_000, 1_000_000)).toBeCloseTo(11.25, 4);
  });
  it('unknown model falls back to sonnet pricing', () => {
    expect(calculateCost('mystery-claude-5', 1_000_000, 1_000_000)).toBeCloseTo(18, 4);
  });
});

describe('costBreakdown', () => {
  it('breaks USD into input/output/cache buckets', () => {
    const b = costBreakdown('sonnet', 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(b.usd_input).toBeCloseTo(3, 4);
    expect(b.usd_output).toBeCloseTo(15, 4);
    expect(b.usd_cache_write).toBeCloseTo(3.75, 4);
    expect(b.usd_cache_read).toBeCloseTo(0.3, 4);
    expect(b.usd_total).toBeCloseTo(22.05, 4);
  });
});

// -- claude transcript parse ------------------------------------------------

describe('parseClaudeTranscript', () => {
  let dir: string;
  let fp: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tokenaudit-'));
    fp = join(dir, 't.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(lines: object[]): void {
    writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it('emits one TurnFact per assistant turn with usage', () => {
    const ts1 = '2026-05-12T10:00:00Z';
    const ts2 = '2026-05-12T10:01:00Z';
    write([
      // user message — ignored
      { type: 'user', timestamp: ts1, message: { role: 'user', content: 'hi' } },
      // assistant turn 1 — tool use
      {
        type: 'assistant', sessionId: 's1', uuid: 'u1', timestamp: ts1, isSidechain: false,
        message: {
          role: 'assistant', model: 'claude-opus-4-7',
          content: [
            { type: 'text', text: 'reading' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/foo/bar.ts' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
          ],
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 },
        },
      },
      // assistant turn 2 — sidechain
      {
        type: 'assistant', sessionId: 's1', uuid: 'u2', timestamp: ts2, isSidechain: true, parentUuid: 'u1',
        message: {
          role: 'assistant', model: 'claude-haiku-4-5',
          content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore' } }],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      },
    ]);

    const turns = parseClaudeTranscript(fp, 'engineer', 'run-1', new Date('2026-05-12T00:00:00Z'), new Date('2026-05-12T23:59:59Z'));
    expect(turns).toHaveLength(2);

    const t1 = turns[0];
    expect(t1.agent).toBe('engineer');
    expect(t1.runtime).toBe('claude');
    expect(t1.session_id).toBe('s1');
    expect(t1.turn_id).toBe('engineer::s1::u1');
    expect(t1.model).toBe('claude-opus-4-7');
    expect(t1.is_sidechain).toBe(false);
    expect(t1.files_touched).toEqual(['/foo/bar.ts']);
    expect(t1.bash_verbs).toEqual(['git']);
    expect(t1.tools_used).toHaveLength(2);
    expect(t1.usd_total).toBeGreaterThan(0);

    const t2 = turns[1];
    expect(t2.is_sidechain).toBe(true);
    expect(t2.subagents_spawned).toEqual(['Explore']);
  });

  it('skips turns outside the time window', () => {
    write([
      {
        type: 'assistant', sessionId: 's1', uuid: 'u1', timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'assistant', model: 'sonnet', content: [], usage: { input_tokens: 100, output_tokens: 50 } },
      },
    ]);
    const turns = parseClaudeTranscript(fp, 'engineer', 'r', new Date('2026-01-01T00:00:00Z'), new Date());
    expect(turns).toHaveLength(0);
  });

  it('skips zero-usage turns', () => {
    write([
      {
        type: 'assistant', sessionId: 's1', uuid: 'u1', timestamp: new Date().toISOString(),
        message: { role: 'assistant', model: 'sonnet', content: [], usage: { input_tokens: 0, output_tokens: 0 } },
      },
    ]);
    const turns = parseClaudeTranscript(fp, 'engineer', 'r', new Date(0), new Date());
    expect(turns).toHaveLength(0);
  });
});

// -- codex log parse --------------------------------------------------------

describe('parseCodexLog', () => {
  let dir: string;
  let fp: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tokenaudit-'));
    fp = join(dir, 'codex-tokens.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('dedupes by (session_id, turn_id) within the same pass', () => {
    const ts = new Date().toISOString();
    writeFileSync(fp, [
      { timestamp: ts, model: 'gpt-5-codex', input_tokens: 1000, output_tokens: 200, session_id: 'sX', turn_id: 't1' },
      { timestamp: ts, model: 'gpt-5-codex', input_tokens: 1000, output_tokens: 200, session_id: 'sX', turn_id: 't1' },
      { timestamp: ts, model: 'gpt-5-codex', input_tokens: 1000, output_tokens: 200, session_id: 'sX', turn_id: 't2' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const turns = parseCodexLog(fp, 'devops-c', 'r', new Date(0), new Date(Date.now() + 1000));
    expect(turns).toHaveLength(2);
    expect(turns[0].runtime).toBe('codex');
  });
});

// -- aggregation ------------------------------------------------------------

function fixtureTurn(over: Partial<TurnFact> = {}): TurnFact {
  return {
    turn_id: 'agent::s1::u1',
    agent: 'engineer',
    runtime: 'claude',
    session_id: 's1',
    ts: '2026-05-12T10:00:00Z',
    model: 'opus',
    input_tokens: 100, output_tokens: 50, cache_read: 0, cache_write: 0,
    usd_input: 0.0015, usd_output: 0.00375, usd_cache_read: 0, usd_cache_write: 0,
    usd_total: 0.00525,
    is_sidechain: false,
    trigger_kind: 'unknown', trigger_name: null, trigger_prompt: null, session_opener: null, parent_session: null,
    tools_used: [], files_touched: [], bash_verbs: [], subagents_spawned: [],
    audit_run_id: 'r', source_file: '/x',
    ...over,
  };
}

describe('aggregate', () => {
  it('aggregates by agent', () => {
    const turns = [
      fixtureTurn({ turn_id: 'a::s1::u1', agent: 'engineer', usd_total: 1 }),
      fixtureTurn({ turn_id: 'a::s1::u2', agent: 'engineer', usd_total: 2 }),
      fixtureTurn({ turn_id: 'a::s2::u1', agent: 'analyst', usd_total: 5 }),
    ];
    const result = aggregate(turns, 'agent');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].key).toBe('analyst');
    expect(result.rows[0].usd_total).toBe(5);
    expect(result.totals.usd_total).toBe(8);
  });

  it('aggregates by tool with input-chars share', () => {
    const turns = [
      fixtureTurn({
        usd_total: 10,
        tools_used: [
          { name: 'Read', input_chars: 100 },
          { name: 'Bash', input_chars: 300 },
        ],
      }),
    ];
    const result = aggregate(turns, 'tool');
    expect(result.rows).toHaveLength(2);
    const bash = result.rows.find((r) => r.key === 'Bash')!;
    const read = result.rows.find((r) => r.key === 'Read')!;
    expect(bash.usd_total).toBeCloseTo(7.5, 4);
    expect(read.usd_total).toBeCloseTo(2.5, 4);
  });
});

describe('rollupSessions', () => {
  it('rolls turns into sessions ordered by usd', () => {
    const turns = [
      fixtureTurn({ turn_id: 'a::s1::u1', session_id: 's1', usd_total: 1 }),
      fixtureTurn({ turn_id: 'a::s1::u2', session_id: 's1', usd_total: 2 }),
      fixtureTurn({ turn_id: 'a::s2::u1', session_id: 's2', usd_total: 5 }),
    ];
    const sessions = rollupSessions(turns);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].session_id).toBe('s2');
    expect(sessions[0].usd_total).toBe(5);
  });
});

// -- anomaly detection ------------------------------------------------------

describe('detectOutlierSessions', () => {
  it('flags sessions > 3× median', () => {
    const turns: TurnFact[] = [];
    // 9 cheap sessions ($0.10 each)
    for (let i = 0; i < 9; i++) {
      turns.push(fixtureTurn({ turn_id: `a::s${i}::u1`, session_id: `s${i}`, usd_total: 0.1 }));
    }
    // 1 expensive session ($10) — should flag
    turns.push(fixtureTurn({ turn_id: 'a::big::u1', session_id: 'big', usd_total: 10 }));

    const anomalies = detectOutlierSessions(turns, { auditRunId: 'r', completedTasksByAgent: new Map() });
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    const big = anomalies.find((a) => a.session_id === 'big')!;
    expect(big.severity).toBe('critical');
    expect(big.evidence_turn_ids).toContain('a::big::u1');
  });
});

describe('detectCacheRunaway', () => {
  it('flags turns with cache_write/output > 50', () => {
    const turns: TurnFact[] = [
      fixtureTurn({
        turn_id: 'a::s1::u1', session_id: 's1',
        output_tokens: 10, cache_write: 1000, usd_cache_write: 3,
      }),
    ];
    const anomalies = detectCacheRunaway(turns, { auditRunId: 'r', completedTasksByAgent: new Map() });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('cache_runaway');
  });

  it('does not flag normal cache use', () => {
    const turns: TurnFact[] = [
      fixtureTurn({ output_tokens: 100, cache_write: 100 }),
    ];
    expect(detectCacheRunaway(turns, { auditRunId: 'r', completedTasksByAgent: new Map() })).toHaveLength(0);
  });
});

describe('detectCompactCandidates', () => {
  it('flags sessions with turns over the cache_read threshold', () => {
    const turns: TurnFact[] = [
      fixtureTurn({ turn_id: 'a::s1::u1', cache_read: 250_000, usd_cache_read: 0.5 }),
      fixtureTurn({ turn_id: 'a::s1::u2', cache_read: 600_000, usd_cache_read: 1.2 }),
    ];
    const anomalies = detectCompactCandidates(turns, { auditRunId: 'r', completedTasksByAgent: new Map() });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('compact_candidate');
    expect(anomalies[0].evidence_turn_ids).toHaveLength(2);
  });
});

describe('detectIdleBurn', () => {
  it('flags agents with USD>0 and zero completed_task events', () => {
    const turns: TurnFact[] = [
      fixtureTurn({ agent: 'lazy', usd_total: 5 }),
      fixtureTurn({ turn_id: 'b::s1::u1', agent: 'busy', usd_total: 1 }),
    ];
    const completed = new Map<string, number>([['busy', 10], ['lazy', 0]]);
    const { anomalies, rows } = detectIdleBurn(turns, { auditRunId: 'r', completedTasksByAgent: completed }, 24);
    expect(anomalies.find((a) => a.agent === 'lazy')).toBeTruthy();
    const lazyRow = rows.find((r) => r.agent === 'lazy')!;
    expect(lazyRow.verdict).toBe('idle_burn');
  });
});

// -- end-to-end runAudit ----------------------------------------------------

describe('runAudit end-to-end', () => {
  let ctxRoot: string;
  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'tokenaudit-ctx-'));
    // Seed state/<agent> dir so discoverAgents picks the agent up.
    mkdirSync(join(ctxRoot, 'state', 'engineer'), { recursive: true });
    // Seed a codex log
    const logDir = join(ctxRoot, 'logs', 'engineer');
    mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(join(logDir, 'codex-tokens.jsonl'), [
      { timestamp: ts, model: 'gpt-5-codex', input_tokens: 10_000, output_tokens: 5_000, session_id: 's-test', turn_id: 't-1' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
  afterEach(() => rmSync(ctxRoot, { recursive: true, force: true }));

  it('runs, writes turns, returns result', () => {
    const result = runAudit({
      since: new Date(Date.now() - 3_600_000),
      ctxRoot,
      org: '',
    });
    expect(result.error).toBeNull();
    expect(result.turns_ingested).toBe(1);
    expect(result.turns_new).toBe(1);

    // Verify turns file written
    const turnsDir = join(ctxRoot, 'analytics', 'token-audit', 'turns');
    expect(existsSync(turnsDir)).toBe(true);
    const files = readdirSync(turnsDir);
    expect(files.length).toBe(1);

    // Re-run should produce 0 new turns (dedup index)
    const result2 = runAudit({
      since: new Date(Date.now() - 3_600_000),
      ctxRoot,
      org: '',
    });
    expect(result2.turns_new).toBe(0);
    expect(result2.turns_ingested).toBe(1);

    // readWindow round-trips
    const turns = readWindow({ ctxRoot, org: '', since: new Date(Date.now() - 3_600_000), until: new Date() });
    expect(turns.length).toBe(1);
    expect(turns[0].agent).toBe('engineer');
    expect(turns[0].runtime).toBe('codex');
  });

  it('emits audit_run_started + audit_run_completed events under token-auditor', () => {
    runAudit({ since: new Date(Date.now() - 3_600_000), ctxRoot, org: '' });
    const eventsDir = join(ctxRoot, 'analytics', 'events', 'token-auditor');
    expect(existsSync(eventsDir)).toBe(true);
    const files = readdirSync(eventsDir);
    expect(files.length).toBe(1);
    const content = readFileSync(join(eventsDir, files[0]), 'utf-8');
    expect(content).toContain('audit_run_started');
    expect(content).toContain('audit_run_completed');
  });
});

// Silence unused import (only invoked indirectly through runAudit's call path).
void detectAll;
