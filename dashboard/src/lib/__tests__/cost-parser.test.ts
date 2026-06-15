import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-parser-test-'));
process.env.CTX_ROOT = tmpDir;
process.env.CTX_FRAMEWORK_ROOT = tmpDir;

let calculateCost: typeof import('../cost-parser')['calculateCost'];
let scanCodexLogsCosts: typeof import('../cost-parser')['scanCodexLogsCosts'];

beforeAll(async () => {
  const mod = await import('../cost-parser');
  calculateCost = mod.calculateCost;
  scanCodexLogsCosts = mod.scanCodexLogsCosts;

  // Set up enabled-agents.json so getAllAgents() returns a known fixture
  const cfgDir = path.join(tmpDir, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'enabled-agents.json'),
    JSON.stringify(
      {
        'codex-agent-1': { enabled: true, org: 'acme' },
        'codex-agent-2': { enabled: true, org: 'acme' },
        'claude-agent': { enabled: true, org: 'acme' },
        'disabled-agent': { enabled: false, org: 'acme' },
      },
      null,
      2,
    ),
  );
});

beforeEach(() => {
  // Wipe logs dir between tests
  const logsDir = path.join(tmpDir, 'logs');
  if (fs.existsSync(logsDir)) {
    fs.rmSync(logsDir, { recursive: true, force: true });
  }
});

function writeCodexJsonl(agent: string, lines: Array<Record<string, unknown>>): string {
  const dir = path.join(tmpDir, 'logs', agent);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'codex-tokens.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

describe('calculateCost — gpt-5-codex pricing', () => {
  it('uses gpt-5-codex pricing for "gpt-5-codex" model (no silent sonnet downgrade)', () => {
    const cost = calculateCost('gpt-5-codex', 1_000_000, 100_000);
    // 1M input × $1.25 + 100k output × $10/M = $1.25 + $1.00 = $2.25
    expect(cost).toBeCloseTo(2.25, 5);
  });

  it('uses gpt-5-codex pricing for any model containing "codex"', () => {
    const cost = calculateCost('gpt-5-codex-preview', 1_000_000, 0);
    expect(cost).toBeCloseTo(1.25, 5);
  });

  it('uses gpt-5-codex pricing for any model containing "gpt-5"', () => {
    const cost = calculateCost('gpt-5', 1_000_000, 0);
    expect(cost).toBeCloseTo(1.25, 5);
  });

  it('still maps opus correctly (no regression)', () => {
    const cost = calculateCost('claude-3-opus-20240229', 1_000_000, 0);
    expect(cost).toBeCloseTo(15, 5);
  });

  it('still maps sonnet correctly (no regression)', () => {
    const cost = calculateCost('claude-3-5-sonnet-20240620', 1_000_000, 0);
    expect(cost).toBeCloseTo(3, 5);
  });

  it('still maps haiku correctly (no regression)', () => {
    const cost = calculateCost('claude-3-5-haiku-20241022', 1_000_000, 0);
    expect(cost).toBeCloseTo(0.8, 5);
  });
});

describe('calculateCost — Claude 4.x / Fable generation pricing (#520)', () => {
  it('prices Claude 4.x Opus at $5/$25, not the retired $15/$75', () => {
    expect(calculateCost('claude-opus-4-8', 1_000_000, 0)).toBeCloseTo(5, 5);
    // input 1M x $5 + output 1M x $25 = $30
    expect(calculateCost('claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(30, 5);
    // regression guard: must NOT fall back to the Claude 3 Opus rate
    expect(calculateCost('claude-opus-4-8', 1_000_000, 0)).not.toBeCloseTo(15, 5);
  });

  it('still prices the retired Claude 3 Opus at $15/$75', () => {
    expect(calculateCost('claude-3-opus-20240229', 1_000_000, 0)).toBeCloseTo(15, 5);
  });

  it('prices Haiku 4.5 at $1/$5 (Haiku 3.5 stays $0.80/$4)', () => {
    expect(calculateCost('claude-haiku-4-5', 1_000_000, 0)).toBeCloseTo(1, 5);
    expect(calculateCost('claude-3-5-haiku-20241022', 1_000_000, 0)).toBeCloseTo(0.8, 5);
  });

  it('prices Sonnet 4.x at $3/$15 (unchanged from 3.x)', () => {
    expect(calculateCost('claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(3, 5);
  });

  it('prices Claude Fable 5 at $10/$50 (no silent sonnet downgrade)', () => {
    expect(calculateCost('claude-fable-5', 1_000_000, 0)).toBeCloseTo(10, 5);
    expect(calculateCost('claude-fable-5', 0, 1_000_000)).toBeCloseTo(50, 5);
  });

  it('applies generation-correct cache pricing for Claude 4.x Opus', () => {
    // cacheWrite 1M x $6.25 + cacheRead 1M x $0.50 = $6.75
    expect(calculateCost('claude-opus-4-8', 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(6.75, 5);
  });

  it('applies cache pricing for Haiku 4.5', () => {
    // cacheWrite 1M x $1.25 + cacheRead 1M x $0.10 = $1.35
    expect(calculateCost('claude-haiku-4-5', 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(1.35, 5);
  });

  it('applies cache pricing for Fable 5', () => {
    // cacheWrite 1M x $12.50 + cacheRead 1M x $1.00 = $13.50
    expect(calculateCost('claude-fable-5', 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(13.5, 5);
  });

  it('defaults an untagged/future Opus id (no "claude-3") to the current rate, not the retired $15', () => {
    // representative future-Opus id without the legacy "claude-3" segment → current ($5)
    expect(calculateCost('claude-opus-9-9', 1_000_000, 0)).toBeCloseTo(5, 5);
  });

  it('prices Mythos 5 the same as Fable 5 ($10/$50)', () => {
    expect(calculateCost('claude-mythos-5', 1_000_000, 0)).toBeCloseTo(10, 5);
    expect(calculateCost('claude-mythos-5', 0, 1_000_000)).toBeCloseTo(50, 5);
  });

  it('uses the shared sonnet key for Sonnet 4.x cache pricing ($3.75 write / $0.30 read)', () => {
    // cacheWrite 1M x $3.75 + cacheRead 1M x $0.30 = $4.05 — guards the shared
    // sonnet key from silently drifting off the 3.x baseline.
    expect(calculateCost('claude-sonnet-4-6', 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(4.05, 5);
  });
});

describe('scanCodexLogsCosts', () => {
  it('returns [] when no codex log files exist', () => {
    expect(scanCodexLogsCosts()).toEqual([]);
  });

  it('parses a single codex-tokens.jsonl file and computes cost via gpt-5-codex pricing', () => {
    writeCodexJsonl('codex-agent-1', [
      {
        timestamp: '2026-05-08T01:00:00Z',
        model: 'gpt-5-codex',
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        session_id: 'thread-A',
        turn_id: 'turn-1',
      },
    ]);

    const entries = scanCodexLogsCosts();
    expect(entries).toHaveLength(1);
    expect(entries[0].agent).toBe('codex-agent-1');
    expect(entries[0].org).toBe('acme');
    expect(entries[0].model).toBe('gpt-5-codex');
    expect(entries[0].input_tokens).toBe(1_000_000);
    expect(entries[0].output_tokens).toBe(100_000);
    expect(entries[0].cost_usd).toBeCloseTo(2.25, 5);
    expect(entries[0].source_file).toContain('codex-tokens.jsonl');
  });

  it('parses multiple turns from one file', () => {
    writeCodexJsonl('codex-agent-1', [
      {
        timestamp: '2026-05-08T01:00:00Z',
        model: 'gpt-5-codex',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        session_id: 'thread-A',
        turn_id: 'turn-1',
      },
      {
        timestamp: '2026-05-08T01:01:00Z',
        model: 'gpt-5-codex',
        input_tokens: 200,
        output_tokens: 75,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        session_id: 'thread-A',
        turn_id: 'turn-2',
      },
    ]);
    expect(scanCodexLogsCosts()).toHaveLength(2);
  });

  it('walks logs from multiple agents', () => {
    writeCodexJsonl('codex-agent-1', [
      {
        timestamp: '2026-05-08T01:00:00Z',
        model: 'gpt-5-codex',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        session_id: 'thread-A',
        turn_id: 'turn-1',
      },
    ]);
    writeCodexJsonl('codex-agent-2', [
      {
        timestamp: '2026-05-08T02:00:00Z',
        model: 'gpt-5-codex',
        input_tokens: 200,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        session_id: 'thread-B',
        turn_id: 'turn-1',
      },
    ]);

    const entries = scanCodexLogsCosts();
    const agents = entries.map((e) => e.agent).sort();
    expect(agents).toEqual(['codex-agent-1', 'codex-agent-2']);
  });

  it('skips zero-token records (no cost-bearing data)', () => {
    writeCodexJsonl('codex-agent-1', [
      {
        timestamp: '2026-05-08T01:00:00Z',
        model: 'gpt-5-codex',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        session_id: 'thread-A',
        turn_id: 'turn-1',
      },
    ]);
    expect(scanCodexLogsCosts()).toEqual([]);
  });

  it('skips records missing the model field', () => {
    writeCodexJsonl('codex-agent-1', [
      { input_tokens: 1000, output_tokens: 100 },
    ]);
    expect(scanCodexLogsCosts()).toEqual([]);
  });

  it('tolerates malformed JSONL lines', () => {
    const dir = path.join(tmpDir, 'logs', 'codex-agent-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'codex-tokens.jsonl'),
      'not json\n' +
        JSON.stringify({
          timestamp: '2026-05-08T01:00:00Z',
          model: 'gpt-5-codex',
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          session_id: 'thread-A',
          turn_id: 'turn-1',
        }) +
        '\n',
    );
    expect(scanCodexLogsCosts()).toHaveLength(1);
  });
});
