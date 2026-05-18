/**
 * Wave-1 Task #65 — swarm-runner unit tests.
 *
 * The runner is pure orchestration; we mock the worker dispatcher so no real
 * Claude sessions are spawned. Test coverage required by the task brief:
 *  (1) Single-model run, 3 items, concurrency 2 → 3 result files + summary.
 *  (2) One item fails → other items still complete + error captured.
 *  (3) Multi-model run, reconcile='all' → both models invoked per item,
 *      summary captures agreement.
 *  (4) Concurrency limit honored (peak in-flight <= N when N=2, items=5).
 *  (5) runId is unique + filesystem-safe.
 *
 * Plus a handful of bonus units around renderPrompt + summarizeReconcile +
 * sanitiseForFs to lock the algorithmic edges so future refactors don't drift.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runSwarm,
  generateRunId,
  renderPrompt,
  sanitiseForFs,
  summarizeReconcile,
  runPool,
  collectResults,
  loadSummary,
  computeStatus,
  resolveSwarmRunDir,
  type SwarmConfig,
  type SwarmDispatcher,
  type SwarmResult,
} from '../../../src/daemon/swarm-runner';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'swarm-runner-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a dispatcher that always succeeds and echoes back the prompt. */
function echoDispatcher(): SwarmDispatcher {
  return async (req) => ({
    output: `echo: ${req.prompt}`,
    exitCode: 0,
  });
}

describe('sanitiseForFs', () => {
  it('passes through safe characters', () => {
    expect(sanitiseForFs('repo_alpha-01')).toBe('repo_alpha-01');
  });

  it('collapses unsafe runs to single underscore', () => {
    expect(sanitiseForFs('foo/bar baz')).toBe('foo_bar_baz');
  });

  it('strips leading/trailing underscores produced by unsafe-char collapse', () => {
    // '!foo!' → '_foo_' → 'foo' (the leading/trailing _ from the collapse get stripped)
    expect(sanitiseForFs('!foo!')).toBe('foo');
    // Hyphens are already fs-safe — they survive unchanged.
    expect(sanitiseForFs('--foo--')).toBe('--foo--');
  });

  it('throws on empty input', () => {
    expect(() => sanitiseForFs('')).toThrow(/non-empty/);
  });

  it('throws when input has no safe chars', () => {
    expect(() => sanitiseForFs('!@#$%^&*()')).toThrow(/no fs-safe/);
  });
});

describe('generateRunId', () => {
  it('produces a filesystem-safe id', () => {
    const id = generateRunId();
    expect(id).toMatch(/^swarm-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/);
    // Must round-trip through path join without surprises.
    expect(join('/tmp', id)).toBe(`/tmp/${id}`);
  });

  it('produces unique ids across rapid calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateRunId());
    expect(ids.size).toBe(100);
  });

  it('every id matches the [A-Za-z0-9_-]+ runId regex', () => {
    const re = /^[A-Za-z0-9_-]+$/;
    for (let i = 0; i < 20; i++) {
      const id = generateRunId();
      expect(re.test(id)).toBe(true);
    }
  });
});

describe('renderPrompt', () => {
  it('substitutes {{item}} with payload when set', () => {
    expect(renderPrompt('hello {{item}}', { id: 'a', payload: 'world' })).toBe('hello world');
  });

  it('substitutes {{item.id}} and arbitrary keys', () => {
    const out = renderPrompt('id={{item.id}} repo={{item.repo}} persona={{item.persona}}', {
      id: 'r1',
      repo: 'whisper.cpp',
      persona: 'transcription',
    });
    expect(out).toBe('id=r1 repo=whisper.cpp persona=transcription');
  });

  it('renders missing keys as empty string (no throw)', () => {
    expect(renderPrompt('a={{item.missing}}-b', { id: 'x' })).toBe('a=-b');
  });

  it('{{item}} falls back to JSON when payload is unset', () => {
    const out = renderPrompt('{{item}}', { id: 'r1', extra: 'k' });
    expect(out).toContain('"id":"r1"');
    expect(out).toContain('"extra":"k"');
  });
});

describe('summarizeReconcile', () => {
  const baseTs = '2026-05-17T00:00:00.000Z';

  function res(itemId: string, model: string, output: string, exitCode = 0): SwarmResult {
    return {
      runId: 'r',
      itemId,
      model,
      output,
      exitCode,
      durationMs: 1,
      startedAt: baseTs,
      finishedAt: baseTs,
    };
  }

  it('marks agreement when all models produce same normalised output', () => {
    const rows = summarizeReconcile(
      [res('a', 'claude', 'hello'), res('a', 'codex', 'HELLO')],
      'all',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].agreement).toBe(true);
    expect(rows[0].divergent).toEqual([]);
  });

  it('flags divergence when models disagree', () => {
    const rows = summarizeReconcile(
      [res('a', 'claude', 'green'), res('a', 'codex', 'red')],
      'all',
    );
    expect(rows[0].agreement).toBe(false);
    expect(rows[0].divergent.sort()).toEqual(['codex']);
  });

  it('picks a majority winner and reports divergent models', () => {
    const rows = summarizeReconcile(
      [
        res('a', 'claude-opus', 'green'),
        res('a', 'claude-sonnet', 'green'),
        res('a', 'codex', 'red'),
      ],
      'majority',
    );
    expect(rows[0].agreement).toBe(false);
    expect(rows[0].majorityWinner).toBe('green');
    expect(rows[0].divergent).toEqual(['codex']);
  });

  it('handles single-model rows cleanly', () => {
    const rows = summarizeReconcile([res('a', 'claude', 'hi')], 'first');
    expect(rows[0].agreement).toBe(true);
    expect(rows[0].exitCodes).toEqual({ claude: 0 });
  });

  it('produces stable per-item sort order', () => {
    const rows = summarizeReconcile(
      [res('c', 'claude', 'x'), res('a', 'claude', 'x'), res('b', 'claude', 'x')],
      'first',
    );
    expect(rows.map(r => r.itemId)).toEqual(['a', 'b', 'c']);
  });
});

describe('runPool concurrency limiter', () => {
  it('honors the limit (peak in-flight <= N)', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 8 }, (_, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
      return i;
    });
    const out = await runPool(tasks, 3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(out.length).toBe(8);
    for (const r of out) expect(r.ok).toBe(true);
  });

  it('returns results in input order even when tasks finish out-of-order', async () => {
    const tasks = [
      async () => { await new Promise(r => setTimeout(r, 30)); return 0; },
      async () => { await new Promise(r => setTimeout(r, 5)); return 1; },
      async () => { await new Promise(r => setTimeout(r, 15)); return 2; },
    ];
    const out = await runPool(tasks, 3);
    const values = out.map(r => (r.ok ? r.value : -1));
    expect(values).toEqual([0, 1, 2]);
  });

  it('captures task errors as { ok: false }', async () => {
    const tasks = [
      async () => 'ok',
      async () => { throw new Error('boom'); },
    ];
    const out = await runPool(tasks, 2);
    expect(out[0].ok).toBe(true);
    expect(out[1].ok).toBe(false);
    if (!out[1].ok) expect(out[1].error.message).toBe('boom');
  });

  it('floors limit to 1', async () => {
    let peak = 0;
    let inFlight = 0;
    const tasks = Array.from({ length: 4 }, () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    await runPool(tasks, 0);
    expect(peak).toBe(1);
  });
});

describe('runSwarm: single-model, 3 items, concurrency 2', () => {
  it('writes one result file per item + a summary.json, marks all succeeded', async () => {
    const config: SwarmConfig = {
      items: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }],
      promptTemplate: 'process {{item.id}}',
      model: 'claude-sonnet',
      maxConcurrent: 2,
    };
    const out = await runSwarm(config, {
      dispatcher: echoDispatcher(),
      log: () => {},
      swarmStateRoot: tmpRoot,
    });

    expect(out.results).toHaveLength(3);
    expect(out.summary.outcomes.succeeded).toBe(3);
    expect(out.summary.outcomes.failed).toBe(0);
    expect(out.summary.totalDispatches).toBe(3);
    expect(out.summary.models).toEqual(['claude-sonnet']);

    // One file per item, plus summary.json
    const files = readdirSync(out.runDir).filter(f => f.endsWith('.jsonl') || f === 'summary.json');
    expect(files.sort()).toEqual([
      'alpha.claude-sonnet.jsonl',
      'beta.claude-sonnet.jsonl',
      'gamma.claude-sonnet.jsonl',
      'summary.json',
    ]);

    // Each result file is parseable + contains the prompt-substituted output.
    const alpha = JSON.parse(readFileSync(join(out.runDir, 'alpha.claude-sonnet.jsonl'), 'utf-8'));
    expect(alpha.itemId).toBe('alpha');
    expect(alpha.model).toBe('claude-sonnet');
    expect(alpha.output).toBe('echo: process alpha');
    expect(alpha.exitCode).toBe(0);
  });

  it('runs items in deterministic (sorted) order', async () => {
    const dispatched: string[] = [];
    const dispatcher: SwarmDispatcher = async (req) => {
      dispatched.push(req.itemId);
      return { output: '', exitCode: 0 };
    };
    const config: SwarmConfig = {
      items: [{ id: 'zulu' }, { id: 'alpha' }, { id: 'mike' }],
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 1, // serialise so the sort order is observable
    };
    await runSwarm(config, { dispatcher, log: () => {}, swarmStateRoot: tmpRoot });
    expect(dispatched).toEqual(['alpha', 'mike', 'zulu']);
  });
});

describe('runSwarm: one item fails', () => {
  it('still completes the other items and records the error', async () => {
    const dispatcher: SwarmDispatcher = async (req) => {
      if (req.itemId === 'b') {
        return { output: 'boom', exitCode: 2, error: 'simulated worker fail' };
      }
      return { output: `ok-${req.itemId}`, exitCode: 0 };
    };
    const config: SwarmConfig = {
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 2,
    };
    const out = await runSwarm(config, { dispatcher, log: () => {}, swarmStateRoot: tmpRoot });

    expect(out.summary.outcomes.succeeded).toBe(2);
    expect(out.summary.outcomes.failed).toBe(1);

    // a and c succeeded, b failed
    const a = out.results.find(r => r.itemId === 'a')!;
    const b = out.results.find(r => r.itemId === 'b')!;
    const c = out.results.find(r => r.itemId === 'c')!;
    expect(a.exitCode).toBe(0);
    expect(c.exitCode).toBe(0);
    expect(b.exitCode).toBe(2);
    expect(b.error).toBe('simulated worker fail');

    // All three files present on disk
    expect(existsSync(join(out.runDir, 'a.m.jsonl'))).toBe(true);
    expect(existsSync(join(out.runDir, 'b.m.jsonl'))).toBe(true);
    expect(existsSync(join(out.runDir, 'c.m.jsonl'))).toBe(true);
  });

  it('captures dispatcher promise rejection as failure (does not abort run)', async () => {
    const dispatcher: SwarmDispatcher = async (req) => {
      if (req.itemId === 'b') throw new Error('rejected');
      return { output: 'ok', exitCode: 0 };
    };
    const out = await runSwarm({
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 2,
    }, { dispatcher, log: () => {}, swarmStateRoot: tmpRoot });

    expect(out.summary.outcomes.failed).toBe(1);
    const b = out.results.find(r => r.itemId === 'b')!;
    expect(b.exitCode).toBe(1);
    expect(b.error).toBe('rejected');
  });
});

describe('runSwarm: multi-model reconcile', () => {
  it('invokes every model per item and records agreement in the summary', async () => {
    const dispatcher: SwarmDispatcher = async (req) => ({
      // Both models produce the same output → agreement
      output: `seen-${req.itemId}`,
      exitCode: 0,
    });
    const out = await runSwarm({
      items: [{ id: 'a' }, { id: 'b' }],
      promptTemplate: 'x',
      model: ['claude-opus', 'codex'],
      maxConcurrent: 2,
      reconcileMode: 'all',
    }, { dispatcher, log: () => {}, swarmStateRoot: tmpRoot });

    // 2 items × 2 models = 4 dispatches.
    expect(out.results).toHaveLength(4);
    expect(out.summary.totalDispatches).toBe(4);
    expect(out.summary.models).toEqual(['claude-opus', 'codex']);
    expect(out.summary.reconcileMode).toBe('all');

    // 4 jsonl files
    const jsonl = readdirSync(out.runDir).filter(f => f.endsWith('.jsonl')).sort();
    expect(jsonl).toEqual([
      'a.claude-opus.jsonl',
      'a.codex.jsonl',
      'b.claude-opus.jsonl',
      'b.codex.jsonl',
    ]);

    // Reconcile: both items have full agreement (same output across models).
    expect(out.summary.reconcile).toHaveLength(2);
    for (const row of out.summary.reconcile) {
      expect(row.agreement).toBe(true);
      expect(row.exitCodes).toEqual({ 'claude-opus': 0, codex: 0 });
    }
  });

  it('flags divergence when models disagree on an item', async () => {
    const dispatcher: SwarmDispatcher = async (req) => {
      if (req.itemId === 'b' && req.model === 'codex') {
        return { output: 'different answer', exitCode: 0 };
      }
      return { output: 'standard answer', exitCode: 0 };
    };
    const out = await runSwarm({
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      promptTemplate: 'x',
      model: ['claude-opus', 'codex'],
      maxConcurrent: 4,
      reconcileMode: 'all',
    }, { dispatcher, log: () => {}, swarmStateRoot: tmpRoot });

    const bRow = out.summary.reconcile.find(r => r.itemId === 'b')!;
    expect(bRow.agreement).toBe(false);
    expect(bRow.divergent).toEqual(['codex']);

    const aRow = out.summary.reconcile.find(r => r.itemId === 'a')!;
    expect(aRow.agreement).toBe(true);
  });
});

describe('runSwarm: concurrency limit honored end-to-end', () => {
  it('peak in-flight dispatcher calls never exceed maxConcurrent', async () => {
    let inFlight = 0;
    let peak = 0;
    const dispatcher: SwarmDispatcher = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 15));
      inFlight--;
      return { output: 'x', exitCode: 0 };
    };
    const config: SwarmConfig = {
      items: Array.from({ length: 10 }, (_, i) => ({ id: `i${i.toString().padStart(2, '0')}` })),
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 3,
    };
    await runSwarm(config, { dispatcher, log: () => {}, swarmStateRoot: tmpRoot });
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('runSwarm: stable JSON output (idempotency)', () => {
  it('result files have sorted keys', async () => {
    const dispatcher: SwarmDispatcher = async () => ({ output: 'x', exitCode: 0 });
    const out = await runSwarm({
      items: [{ id: 'a' }],
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 1,
    }, { dispatcher, log: () => {}, swarmStateRoot: tmpRoot });

    const raw = readFileSync(join(out.runDir, 'a.m.jsonl'), 'utf-8').trim();
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj);
    expect(keys).toEqual([...keys].sort());
  });

  it('summary.json has sorted keys', async () => {
    const dispatcher: SwarmDispatcher = async () => ({ output: 'x', exitCode: 0 });
    const out = await runSwarm({
      items: [{ id: 'a' }, { id: 'b' }],
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 2,
    }, { dispatcher, log: () => {}, swarmStateRoot: tmpRoot });

    const raw = readFileSync(join(out.runDir, 'summary.json'), 'utf-8').trim();
    const obj = JSON.parse(raw);
    expect(Object.keys(obj)).toEqual([...Object.keys(obj)].sort());
  });
});

describe('runSwarm: input validation', () => {
  it('throws on empty items', async () => {
    await expect(
      runSwarm({ items: [], promptTemplate: 'x', model: 'm', maxConcurrent: 1 }),
    ).rejects.toThrow(/at least one item/);
  });

  it('throws on missing prompt template', async () => {
    await expect(
      runSwarm({ items: [{ id: 'a' }], promptTemplate: '', model: 'm', maxConcurrent: 1 }),
    ).rejects.toThrow(/promptTemplate required/);
  });

  it('throws on bad maxConcurrent', async () => {
    await expect(
      runSwarm({ items: [{ id: 'a' }], promptTemplate: 'x', model: 'm', maxConcurrent: 0 }),
    ).rejects.toThrow(/maxConcurrent must be >= 1/);
  });

  it('throws on unsafe runId override', async () => {
    await expect(
      runSwarm({
        items: [{ id: 'a' }],
        promptTemplate: 'x',
        model: 'm',
        maxConcurrent: 1,
        runId: '../escape',
      }, { dispatcher: echoDispatcher(), log: () => {}, swarmStateRoot: tmpRoot }),
    ).rejects.toThrow(/runId/);
  });

  it('throws when an item id has no fs-safe chars', async () => {
    await expect(
      runSwarm({
        items: [{ id: '!!!' }],
        promptTemplate: 'x',
        model: 'm',
        maxConcurrent: 1,
      }, { dispatcher: echoDispatcher(), log: () => {}, swarmStateRoot: tmpRoot }),
    ).rejects.toThrow(/no fs-safe/);
  });
});

describe('runSwarm: collect/status/loadSummary round-trip', () => {
  it('collectResults reads back every persisted result', async () => {
    const out = await runSwarm({
      items: [{ id: 'a' }, { id: 'b' }],
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 2,
    }, { dispatcher: echoDispatcher(), log: () => {}, swarmStateRoot: tmpRoot });

    const collected = collectResults(out.runId, { swarmStateRoot: tmpRoot });
    expect(collected).toHaveLength(2);
    expect(collected.map(r => r.itemId).sort()).toEqual(['a', 'b']);
  });

  it('loadSummary returns the persisted summary verbatim', async () => {
    const out = await runSwarm({
      items: [{ id: 'a' }],
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 1,
    }, { dispatcher: echoDispatcher(), log: () => {}, swarmStateRoot: tmpRoot });

    const summary = loadSummary(out.runId, { swarmStateRoot: tmpRoot });
    expect(summary).not.toBeNull();
    expect(summary!.runId).toBe(out.runId);
    expect(summary!.outcomes.succeeded).toBe(1);
  });

  it('loadSummary returns null when summary.json absent', () => {
    const summary = loadSummary('swarm-nonexistent', { swarmStateRoot: tmpRoot });
    expect(summary).toBeNull();
  });

  it('computeStatus reports completed/succeeded/failed counts and avg duration', async () => {
    const out = await runSwarm({
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      promptTemplate: 'x',
      model: 'm',
      maxConcurrent: 3,
    }, { dispatcher: echoDispatcher(), log: () => {}, swarmStateRoot: tmpRoot });

    const status = computeStatus(out.runId, { swarmStateRoot: tmpRoot });
    expect(status.runId).toBe(out.runId);
    expect(status.completed).toBe(3);
    expect(status.succeeded).toBe(3);
    expect(status.failed).toBe(0);
    expect(status.totalDispatches).toBe(3);
    expect(status.recent.length).toBeGreaterThan(0);
  });
});

describe('resolveSwarmRunDir', () => {
  it('honors swarmStateRoot override', () => {
    const dir = resolveSwarmRunDir('swarm-test', { swarmStateRoot: '/tmp/foo' });
    expect(dir).toBe('/tmp/foo/swarm-test');
  });
});
