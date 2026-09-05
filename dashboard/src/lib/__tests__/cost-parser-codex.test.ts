/**
 * cost-parser-codex.test.ts — codex-only peer to cost-parser.test.ts.
 *
 * Per PR 09 §4 + reject conditions: this suite exercises ONLY codex paths in
 * the dashboard cost-parser (no claude regression coverage). It is the test
 * surface a designer can deliberately break the codex parser against and watch
 * fail without polluting the broader cost-parser suite.
 *
 * Coverage:
 *   - resolvePricingKey returns 'gpt-5-codex' for codex/gpt-5 substring matches
 *   - calculateCost applies codex cache_read pricing distinctly from claude
 *   - parseCodexJsonlFile extracts the codex JSONL schema (flat shape)
 *   - scanCodexLogsCosts walks per-agent dirs and produces CostEntry[]
 *   - syncCosts dedup contract holds when codex + claude entries are merged
 *   - source_file always points at codex-tokens.jsonl (dedup key invariant)
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-parser-codex-test-'));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;
process.env.HOME = tmpDir;

// Seed the pre-index schema before importing db.ts so initialization exercises
// the upgrade path for databases that already contain duplicate cost rows.
const legacyDbDir = path.join(tmpDir, 'dashboard');
fs.mkdirSync(legacyDbDir, { recursive: true });
const legacyDb = new Database(path.join(legacyDbDir, 'cortextos-default.db'));
legacyDb.exec(`
  CREATE TABLE cost_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    agent TEXT NOT NULL,
    org TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    source_file TEXT
  );
  INSERT INTO cost_entries
    (timestamp, agent, org, model, input_tokens, output_tokens, total_tokens, cost_usd, source_file)
  VALUES
    ('2026-05-01T00:00:00Z', 'legacy-agent', 'legacy-org', 'gpt-5-codex', 100, 50, 150, 0.1, '/tmp/codex-tokens.jsonl'),
    ('2026-05-01T00:00:00Z', 'legacy-agent', 'legacy-org', 'gpt-5-codex', 110, 55, 165, 0.2, '/tmp/codex-tokens.jsonl');
`);
legacyDb.close();

let calculateCost: typeof import('../cost-parser')['calculateCost'];
let scanCodexLogsCosts: typeof import('../cost-parser')['scanCodexLogsCosts'];
let persistCostEntries: typeof import('../cost-parser')['persistCostEntries'];
let syncCosts: typeof import('../cost-parser')['syncCosts'];
let db: typeof import('../db')['db'];
let migratedLegacyCount: number;
let migratedLegacyTokens: number;

beforeAll(async () => {
  const mod = await import('../cost-parser');
  calculateCost = mod.calculateCost;
  scanCodexLogsCosts = mod.scanCodexLogsCosts;
  persistCostEntries = mod.persistCostEntries;
  syncCosts = mod.syncCosts;
  ({ db } = await import('../db'));
  migratedLegacyCount = (
    db.prepare("SELECT COUNT(*) AS count FROM cost_entries WHERE agent = 'legacy-agent'").get() as { count: number }
  ).count;
  migratedLegacyTokens = (
    db.prepare("SELECT total_tokens FROM cost_entries WHERE agent = 'legacy-agent'").get() as { total_tokens: number }
  ).total_tokens;

  const cfgDir = path.join(tmpDir, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'enabled-agents.json'),
    JSON.stringify(
      {
        'codex-alpha': { enabled: true, org: 'lifeos' },
        'codex-beta': { enabled: true, org: 'lifeos' },
        'codex-gamma': { enabled: true, org: 'testorg' },
      },
      null,
      2,
    ),
  );
});

beforeEach(() => {
  const logsDir = path.join(tmpDir, 'logs');
  if (fs.existsSync(logsDir)) fs.rmSync(logsDir, { recursive: true, force: true });
  db.prepare('DELETE FROM cost_entries').run();
});

function writeCodexLog(agent: string, lines: Array<Record<string, unknown>>): string {
  const dir = path.join(tmpDir, 'logs', agent);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'codex-tokens.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

describe('codex pricing — gpt-5-codex pricing key resolution', () => {
  it('exact "gpt-5-codex" model resolves to codex pricing', () => {
    expect(calculateCost('gpt-5-codex', 1_000_000, 0)).toBeCloseTo(1.25, 5);
  });

  it('"codex" substring matches (any future codex variant)', () => {
    expect(calculateCost('codex-thinking', 1_000_000, 0)).toBeCloseTo(1.25, 5);
  });

  it('"gpt-5" prefix matches without "codex"', () => {
    expect(calculateCost('gpt-5', 1_000_000, 0)).toBeCloseTo(1.25, 5);
  });

  it('output token pricing applies $10/M (10× input)', () => {
    const cost = calculateCost('gpt-5-codex', 0, 100_000);
    expect(cost).toBeCloseTo(1.0, 5);
  });

  it('cache_read tokens priced at $0.125/M (10× discount vs input)', () => {
    const cost = calculateCost('gpt-5-codex', 0, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(0.125, 5);
  });

  it('cache_write tokens priced at $0/M (no separate codex cache write cost)', () => {
    const cost = calculateCost('gpt-5-codex', 0, 0, 1_000_000, 0);
    expect(cost).toBe(0);
  });

  it('full mixed pricing: input + output + cache_read combine correctly', () => {
    // 100k input × $1.25/M + 50k output × $10/M + 200k cache_read × $0.125/M
    // = 0.125 + 0.50 + 0.025 = 0.65
    const cost = calculateCost('gpt-5-codex', 100_000, 50_000, 0, 200_000);
    expect(cost).toBeCloseTo(0.65, 5);
  });
});

describe('codex JSONL parsing — flat schema shape', () => {
  it('parses one entry per line and converts to CostEntry shape', () => {
    writeCodexLog('codex-alpha', [
      {
        timestamp: '2026-05-08T01:00:00Z',
        model: 'gpt-5-codex',
        input_tokens: 1_000,
        output_tokens: 500,
        cache_read_tokens: 100,
        cache_write_tokens: 0,
        session_id: 'thread-A',
        turn_id: 'turn-1',
      },
    ]);

    const entries = scanCodexLogsCosts();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.agent).toBe('codex-alpha');
    expect(e.org).toBe('lifeos');
    expect(e.model).toBe('gpt-5-codex');
    expect(e.timestamp).toBe('2026-05-08T01:00:00Z');
    expect(e.input_tokens).toBe(1_000);
    expect(e.output_tokens).toBe(500);
    expect(e.total_tokens).toBe(1_600);
    expect(e.source_file).toContain('codex-tokens.jsonl');
  });

  it('source_file always points at the codex-tokens.jsonl (dedup key invariant)', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50 },
    ]);
    writeCodexLog('codex-beta', [
      { timestamp: '2026-05-08T02:00:00Z', model: 'gpt-5-codex', input_tokens: 200, output_tokens: 75 },
    ]);
    const entries = scanCodexLogsCosts();
    for (const e of entries) {
      expect(e.source_file?.endsWith('codex-tokens.jsonl')).toBe(true);
    }
  });

  it('converts cumulative rows to per-turn deltas within one session', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, cache_read_tokens: 20, session_id: 'thread-A', turn_id: 'turn-1' },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', input_tokens: 250, output_tokens: 90, cache_read_tokens: 50, session_id: 'thread-A', turn_id: 'turn-2' },
      { timestamp: '2026-05-08T01:02:00Z', model: 'gpt-5-codex', input_tokens: 400, output_tokens: 120, cache_read_tokens: 70, session_id: 'thread-A', turn_id: 'turn-3' },
    ]);
    const entries = scanCodexLogsCosts();
    expect(entries.map((entry) => [entry.input_tokens, entry.output_tokens, entry.total_tokens])).toEqual([
      [100, 50, 170],
      [150, 40, 220],
      [150, 30, 200],
    ]);
    expect(entries.reduce((total, entry) => total + entry.input_tokens, 0)).toBe(400);
    expect(entries.reduce((total, entry) => total + entry.output_tokens, 0)).toBe(120);
  });

  it('treats a counter decrease as a session reset baseline', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', input_tokens: 200, output_tokens: 75, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:02:00Z', model: 'gpt-5-codex', input_tokens: 10, output_tokens: 5, session_id: 'thread-A' },
    ]);
    expect(scanCodexLogsCosts().map((entry) => [entry.input_tokens, entry.output_tokens])).toEqual([
      [100, 50],
      [100, 25],
      [10, 5],
    ]);
  });

  it.each([
    ['output_tokens', { input_tokens: 220, output_tokens: 5, cache_read_tokens: 35, cache_write_tokens: 12 }],
    ['cache_read_tokens', { input_tokens: 220, output_tokens: 80, cache_read_tokens: 5, cache_write_tokens: 12 }],
    ['cache_write_tokens', { input_tokens: 220, output_tokens: 80, cache_read_tokens: 35, cache_write_tokens: 2 }],
  ])('treats a %s decrease as a whole-row reset', (_field, current) => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, cache_read_tokens: 20, cache_write_tokens: 10, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', ...current, session_id: 'thread-A' },
    ]);
    const latest = scanCodexLogsCosts()[1];
    expect(latest).toMatchObject({
      input_tokens: current.input_tokens,
      output_tokens: current.output_tokens,
      total_tokens: current.input_tokens + current.output_tokens + current.cache_read_tokens + current.cache_write_tokens,
    });
  });

  it('tracks cumulative baselines independently for interleaved sessions', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', input_tokens: 300, output_tokens: 80, session_id: 'thread-B' },
      { timestamp: '2026-05-08T01:02:00Z', model: 'gpt-5-codex', input_tokens: 160, output_tokens: 70, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:03:00Z', model: 'gpt-5-codex', input_tokens: 350, output_tokens: 100, session_id: 'thread-B' },
    ]);
    expect(scanCodexLogsCosts().map((entry) => [entry.input_tokens, entry.output_tokens])).toEqual([
      [100, 50],
      [300, 80],
      [60, 20],
      [50, 20],
    ]);
  });

  it('emits a zero correction for duplicate snapshots without losing the next delta', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:00:30Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', input_tokens: 160, output_tokens: 80, session_id: 'thread-A' },
    ]);
    expect(scanCodexLogsCosts().map((entry) => [entry.input_tokens, entry.output_tokens])).toEqual([
      [100, 50],
      [0, 0],
      [60, 30],
    ]);
  });

  it('preserves legacy independent-row behavior without a session id', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50 },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', input_tokens: 200, output_tokens: 75 },
    ]);
    expect(scanCodexLogsCosts().map((entry) => [entry.input_tokens, entry.output_tokens])).toEqual([
      [100, 50],
      [200, 75],
    ]);
  });

  it('multi-agent walk produces entries for every codex agent with logs', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50 },
    ]);
    writeCodexLog('codex-gamma', [
      { timestamp: '2026-05-08T02:00:00Z', model: 'gpt-5-codex', input_tokens: 200, output_tokens: 75 },
    ]);

    const agents = new Set(scanCodexLogsCosts().map((e) => e.agent));
    expect(agents).toContain('codex-alpha');
    expect(agents).toContain('codex-gamma');
    expect(agents.has('codex-beta')).toBe(false);
  });

  it('returns empty array when no codex logs exist anywhere', () => {
    expect(scanCodexLogsCosts()).toEqual([]);
  });

  it('cost_usd matches calculateCost output for gpt-5-codex pricing', () => {
    writeCodexLog('codex-alpha', [
      {
        timestamp: '2026-05-08T01:00:00Z',
        model: 'gpt-5-codex',
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    ]);
    const e = scanCodexLogsCosts()[0];
    expect(e.cost_usd).toBeCloseTo(2.25, 5);
    expect(e.cost_usd).toBeCloseTo(calculateCost(e.model, e.input_tokens, e.output_tokens), 5);
  });
});

describe('codex parser robustness', () => {
  it('skips records with both zero input and zero output (no signal to record)', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 0, output_tokens: 0 },
    ]);
    expect(scanCodexLogsCosts()).toEqual([]);
  });

  it('skips records missing the model field (cannot price safely)', () => {
    writeCodexLog('codex-alpha', [{ input_tokens: 100, output_tokens: 50 }]);
    expect(scanCodexLogsCosts()).toEqual([]);
  });

  it('tolerates malformed JSONL lines mixed with valid records', () => {
    const dir = path.join(tmpDir, 'logs', 'codex-alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'codex-tokens.jsonl'),
      '{garbage\n' +
        JSON.stringify({
          timestamp: '2026-05-08T01:00:00Z',
          model: 'gpt-5-codex',
          input_tokens: 100,
          output_tokens: 50,
        }) +
        '\n' +
        'not json either\n',
    );
    expect(scanCodexLogsCosts()).toHaveLength(1);
  });

  it('handles empty JSONL file without throwing', () => {
    const dir = path.join(tmpDir, 'logs', 'codex-alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'codex-tokens.jsonl'), '');
    expect(scanCodexLogsCosts()).toEqual([]);
  });
});

describe('codex cost persistence', () => {
  const sourceFile = path.join(tmpDir, 'logs', 'codex-alpha', 'codex-tokens.jsonl');
  const identity = {
    timestamp: '2026-05-08T01:01:00Z',
    agent: 'codex-alpha',
    org: 'lifeos',
    model: 'gpt-5-codex',
    source_file: sourceFile,
  };

  it('keeps the newest duplicate when upgrading a database without the identity index', () => {
    expect(migratedLegacyCount).toBe(1);
    expect(migratedLegacyTokens).toBe(165);
  });

  it('does not duplicate an unchanged row on repeated syncs', () => {
    const entry = {
      ...identity,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cost_usd: calculateCost(identity.model, 100, 50),
    };

    expect(persistCostEntries([entry])).toBe(1);
    expect(persistCostEntries([entry])).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cost_entries').get()).toEqual({ count: 1 });
  });

  it('replaces a previously imported cumulative total with its corrected delta', () => {
    const inflated = {
      ...identity,
      input_tokens: 250,
      output_tokens: 90,
      total_tokens: 340,
      cost_usd: calculateCost(identity.model, 250, 90),
    };
    const corrected = {
      ...identity,
      input_tokens: 150,
      output_tokens: 40,
      total_tokens: 190,
      cost_usd: calculateCost(identity.model, 150, 40),
    };

    expect(persistCostEntries([inflated])).toBe(1);
    expect(persistCostEntries([corrected])).toBe(1);
    expect(
      db.prepare(
        'SELECT input_tokens, output_tokens, total_tokens, cost_usd FROM cost_entries',
      ).get(),
    ).toEqual({
      input_tokens: corrected.input_tokens,
      output_tokens: corrected.output_tokens,
      total_tokens: corrected.total_tokens,
      cost_usd: corrected.cost_usd,
    });
  });

  it('repairs inflated rows through a full sync and stays idempotent', () => {
    const sourceFile = writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', input_tokens: 250, output_tokens: 90, session_id: 'thread-A' },
    ]);
    persistCostEntries([
      {
        timestamp: '2026-05-08T01:00:00Z', agent: 'codex-alpha', org: 'lifeos', model: 'gpt-5-codex',
        input_tokens: 100, output_tokens: 50, total_tokens: 150,
        cost_usd: calculateCost('gpt-5-codex', 100, 50), source_file: sourceFile,
      },
      {
        timestamp: '2026-05-08T01:01:00Z', agent: 'codex-alpha', org: 'lifeos', model: 'gpt-5-codex',
        input_tokens: 250, output_tokens: 90, total_tokens: 340,
        cost_usd: calculateCost('gpt-5-codex', 250, 90), source_file: sourceFile,
      },
    ]);

    expect(syncCosts()).toEqual({ scanned: 2, changed: 1 });
    expect(syncCosts()).toEqual({ scanned: 2, changed: 0 });
    expect(
      db.prepare(
        'SELECT COUNT(*) AS count, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM cost_entries',
      ).get(),
    ).toEqual({ count: 2, input: 250, output: 90 });
  });

  it('zeroes an inflated duplicate snapshot during historical repair', () => {
    const sourceFile = writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:00:30Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, session_id: 'thread-A' },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', input_tokens: 160, output_tokens: 80, session_id: 'thread-A' },
    ]);
    persistCostEntries([
      {
        timestamp: '2026-05-08T01:00:00Z', agent: 'codex-alpha', org: 'lifeos', model: 'gpt-5-codex',
        input_tokens: 100, output_tokens: 50, total_tokens: 150,
        cost_usd: calculateCost('gpt-5-codex', 100, 50), source_file: sourceFile,
      },
      {
        timestamp: '2026-05-08T01:00:30Z', agent: 'codex-alpha', org: 'lifeos', model: 'gpt-5-codex',
        input_tokens: 100, output_tokens: 50, total_tokens: 150,
        cost_usd: calculateCost('gpt-5-codex', 100, 50), source_file: sourceFile,
      },
      {
        timestamp: '2026-05-08T01:01:00Z', agent: 'codex-alpha', org: 'lifeos', model: 'gpt-5-codex',
        input_tokens: 160, output_tokens: 80, total_tokens: 240,
        cost_usd: calculateCost('gpt-5-codex', 160, 80), source_file: sourceFile,
      },
    ]);

    expect(syncCosts()).toEqual({ scanned: 3, changed: 2 });
    expect(syncCosts()).toEqual({ scanned: 3, changed: 0 });
    expect(
      db.prepare(
        'SELECT COUNT(*) AS count, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM cost_entries',
      ).get(),
    ).toEqual({ count: 3, input: 160, output: 80 });
  });
});
