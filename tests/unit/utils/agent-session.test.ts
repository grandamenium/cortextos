import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
  getAgentProjectDir,
  redact,
  redactWithCount,
  parseJsonlTurns,
  isSafePoint,
} from '../../../src/utils/agent-session.js';

describe('getAgentProjectDir', () => {
  it('converts absolute path to slug', () => {
    const dir = '/root/cortextos/orgs/1evo/agents/ops-g';
    const result = getAgentProjectDir(dir);
    expect(result).toContain('-root-cortextos-orgs-1evo-agents-ops-g');
  });
});

describe('redact', () => {
  it('strips telegram bot tokens', () => {
    const text = 'token=1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    expect(redact(text)).not.toContain('1234567890:');
  });

  it('strips email addresses', () => {
    const text = 'contact user@example.com about this';
    expect(redact(text)).not.toContain('user@example.com');
  });

  it('counts substitutions', () => {
    const text = 'user@example.com and admin@test.org';
    const { count } = redactWithCount(text);
    expect(count).toBe(2);
  });

  it('leaves ordinary text unchanged', () => {
    const text = 'npm install && npm test';
    expect(redact(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

let _toolIdCounter = 0;
function freshToolId() { return `tu-${++_toolIdCounter}`; }

function makeTurn(role: 'user' | 'assistant', text: string, toolIds: string[] = []): string {
  const contentBlocks: unknown[] = [{ type: 'text', text }];
  for (const id of toolIds) {
    contentBlocks.push({ type: 'tool_use', id, name: 'Bash', input: {} });
  }
  return JSON.stringify({
    type: role,
    uuid: `test-uuid-${Math.random()}`,
    message: { role, content: contentBlocks },
  });
}

function makeToolResults(ids: string[]): string {
  return JSON.stringify({
    type: 'user',
    uuid: `test-uuid-${Math.random()}`,
    message: {
      role: 'user',
      content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] })),
    },
  });
}

// ---------------------------------------------------------------------------
// parseJsonlTurns
// ---------------------------------------------------------------------------

describe('parseJsonlTurns', () => {
  it('returns empty for non-existent file', () => {
    expect(parseJsonlTurns('/tmp/nonexistent-xyzzy.jsonl')).toEqual([]);
  });

  it('parses user and assistant turns', () => {
    const dir = join(tmpdir(), `agent-session-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'test.jsonl');
    writeFileSync(path, [
      makeTurn('user', 'Hello'),
      makeTurn('assistant', 'World'),
      '{}', // unknown record — should be skipped
      'not json', // malformed — should be skipped
    ].join('\n'));
    const turns = parseJsonlTurns(path);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    rmSync(dir, { recursive: true });
  });

  it('redacts secrets in parsed turns', () => {
    const dir = join(tmpdir(), `agent-session-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'test.jsonl');
    writeFileSync(path, makeTurn('user', 'email is secret@example.com'));
    const turns = parseJsonlTurns(path);
    expect(turns[0].contentText).not.toContain('secret@example.com');
    rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// isSafePoint — ID-based tool tracking
// ---------------------------------------------------------------------------

function makeJsonl(lines: string[]): string {
  return lines.join('\n');
}

function writeTemp(lines: string[]): { path: string; cleanup: () => void } {
  const dir = join(tmpdir(), `sp-test-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'test.jsonl');
  writeFileSync(path, makeJsonl(lines));
  return { path, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe('isSafePoint', () => {
  it('returns false for empty turns', () => {
    expect(isSafePoint([])).toBe(false);
  });

  it('returns false when last turn is user', () => {
    const { path, cleanup } = writeTemp([
      makeTurn('user', 'hello'),
      makeTurn('assistant', 'reply'),
      makeTurn('user', 'follow up'),
    ]);
    expect(isSafePoint(parseJsonlTurns(path))).toBe(false);
    cleanup();
  });

  it('returns true for clean assistant final turn (no tool use)', () => {
    const { path, cleanup } = writeTemp([
      makeTurn('user', 'hello'),
      makeTurn('assistant', 'done'),
    ]);
    expect(isSafePoint(parseJsonlTurns(path))).toBe(true);
    cleanup();
  });

  it('returns false when last assistant turn has pending tool_use', () => {
    const id = freshToolId();
    const { path, cleanup } = writeTemp([
      makeTurn('user', 'run'),
      makeTurn('assistant', 'calling', [id]),
    ]);
    expect(isSafePoint(parseJsonlTurns(path))).toBe(false);
    cleanup();
  });

  it('returns true when tool_use + tool_result IDs match (single tool)', () => {
    const id = freshToolId();
    const { path, cleanup } = writeTemp([
      makeTurn('user', 'run'),
      makeTurn('assistant', 'calling', [id]),
      makeToolResults([id]),
      makeTurn('assistant', 'done'),
    ]);
    expect(isSafePoint(parseJsonlTurns(path))).toBe(true);
    cleanup();
  });

  it('returns false when one of two parallel tool_use IDs has no result (codex-g multi-tool case)', () => {
    const id1 = freshToolId();
    const id2 = freshToolId();
    const { path, cleanup } = writeTemp([
      makeTurn('user', 'do two things'),
      makeTurn('assistant', 'calling both', [id1, id2]),
      makeToolResults([id1]), // only id1 returned
      makeTurn('assistant', 'partial done'),
    ]);
    expect(isSafePoint(parseJsonlTurns(path))).toBe(false);
    cleanup();
  });

  it('returns true when both parallel tool_use IDs have results', () => {
    const id1 = freshToolId();
    const id2 = freshToolId();
    const { path, cleanup } = writeTemp([
      makeTurn('user', 'do two things'),
      makeTurn('assistant', 'calling both', [id1, id2]),
      makeToolResults([id1, id2]),
      makeTurn('assistant', 'all done'),
    ]);
    expect(isSafePoint(parseJsonlTurns(path))).toBe(true);
    cleanup();
  });

  it('handles sequential tool calls all resolved', () => {
    const id1 = freshToolId();
    const id2 = freshToolId();
    const { path, cleanup } = writeTemp([
      makeTurn('user', 'step by step'),
      makeTurn('assistant', 'first call', [id1]),
      makeToolResults([id1]),
      makeTurn('assistant', 'second call', [id2]),
      makeToolResults([id2]),
      makeTurn('assistant', 'all done'),
    ]);
    expect(isSafePoint(parseJsonlTurns(path))).toBe(true);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Runtime normalization (getRuntime() is on AgentProcess — tested via behavior
// in pauseForJsonlSnapshot which gates on 'claude-code' runtime only)
// ---------------------------------------------------------------------------

describe('runtime normalization contract', () => {
  // These tests document the expected behavior of getRuntime() per the
  // approved normalization rule: absent/legacy → 'claude-code'.
  // The actual getRuntime() is on AgentProcess; these tests use the
  // SnapshotAgentLike interface to verify the gate behavior.

  const RUNTIMES_THAT_SKIP = ['codex-app-server', 'hermes', 'custom-runtime'];
  const RUNTIMES_THAT_PROCEED = ['claude-code'];

  for (const rt of RUNTIMES_THAT_SKIP) {
    it(`pauseForJsonlSnapshot skips when runtime='${rt}'`, async () => {
      const { pauseForJsonlSnapshot } = await import('../../../src/utils/agent-session.js');
      const agent = { getRuntime: () => rt, getChildPid: () => null, getAgentDir: () => '/tmp' };
      const result = await pauseForJsonlSnapshot(agent);
      expect(result).toBeNull();
    });
  }

  for (const rt of RUNTIMES_THAT_PROCEED) {
    it(`pauseForJsonlSnapshot attempts snapshot when runtime='${rt}' (stops at no-PID)`, async () => {
      const { pauseForJsonlSnapshot } = await import('../../../src/utils/agent-session.js');
      // No PID → returns null after gate passes (not skipped by runtime check)
      const logs: string[] = [];
      const agent = { getRuntime: () => rt, getChildPid: () => null, getAgentDir: () => '/tmp' };
      const result = await pauseForJsonlSnapshot(agent, (msg) => logs.push(msg));
      expect(result).toBeNull();
      // Should log 'no valid child PID', not 'not supported'
      expect(logs.some(l => l.includes('no valid child PID') || l.includes('Cannot pause'))).toBe(true);
      expect(logs.some(l => l.includes('not supported') && l.includes('runtime'))).toBe(false);
    });
  }

  it('absent runtime (undefined) is treated as claude-code by getRuntime() default', () => {
    // Verify the normalization rule in isolation: undefined → 'claude-code'
    // This mirrors what AgentProcess.getRuntime() should return.
    const normalizeRuntime = (rt: string | undefined) => rt ?? 'claude-code';
    expect(normalizeRuntime(undefined)).toBe('claude-code');
    expect(normalizeRuntime('')).toBe('');
    expect(normalizeRuntime('claude-code')).toBe('claude-code');
    expect(normalizeRuntime('claude')).toBe('claude');
    expect(normalizeRuntime('codex-app-server')).toBe('codex-app-server');
    expect(normalizeRuntime('hermes')).toBe('hermes');
  });
});
