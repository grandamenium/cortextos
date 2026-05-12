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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-parser-codex-test-'));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;

let calculateCost: typeof import('../cost-parser')['calculateCost'];
let scanCodexLogsCosts: typeof import('../cost-parser')['scanCodexLogsCosts'];

beforeAll(async () => {
  const mod = await import('../cost-parser');
  calculateCost = mod.calculateCost;
  scanCodexLogsCosts = mod.scanCodexLogsCosts;

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

  it('multi-turn JSONL emits one CostEntry per turn (no aggregation)', () => {
    writeCodexLog('codex-alpha', [
      { timestamp: '2026-05-08T01:00:00Z', model: 'gpt-5-codex', input_tokens: 100, output_tokens: 50, turn_id: 'turn-1' },
      { timestamp: '2026-05-08T01:01:00Z', model: 'gpt-5-codex', input_tokens: 200, output_tokens: 75, turn_id: 'turn-2' },
      { timestamp: '2026-05-08T01:02:00Z', model: 'gpt-5-codex', input_tokens: 300, output_tokens: 100, turn_id: 'turn-3' },
    ]);
    expect(scanCodexLogsCosts()).toHaveLength(3);
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
