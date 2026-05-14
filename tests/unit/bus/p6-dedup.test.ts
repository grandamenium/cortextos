import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { jaccardTokenSimilarity, checkDuplicate } from '../../../src/bus/p6-dedup';

// ─── Jaccard tests ────────────────────────────────────────────────────────────

describe('jaccardTokenSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaccardTokenSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely disjoint strings', () => {
    expect(jaccardTokenSimilarity('foo bar', 'baz qux')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(jaccardTokenSimilarity('Hello World', 'hello world')).toBe(1);
  });

  it('returns 0.5 for half-overlapping tokens', () => {
    // {a, b} vs {a, c} → intersection=1, union=3  ✗
    // {a, b} vs {b, c} → intersection=1, union=3 → 0.333
    // {a, b, c} vs {b, c, d} → intersection=2, union=4 → 0.5
    expect(jaccardTokenSimilarity('a b c', 'b c d')).toBeCloseTo(0.5);
  });

  it('returns 1 for both empty strings', () => {
    expect(jaccardTokenSimilarity('', '')).toBe(1);
  });

  it('returns 0 when one string is empty', () => {
    expect(jaccardTokenSimilarity('hello', '')).toBe(0);
    expect(jaccardTokenSimilarity('', 'hello')).toBe(0);
  });

  it('treats duplicate tokens as one (set semantics)', () => {
    // "a a b" tokens = {a, b}, "a b b" tokens = {a, b} → Jaccard = 1
    expect(jaccardTokenSimilarity('a a b', 'a b b')).toBe(1);
  });
});

// ─── checkDuplicate tests ─────────────────────────────────────────────────────

describe('checkDuplicate', () => {
  let tmpDir: string;
  const agentName = 'test-agent';
  const chatId = '12345';

  function logDir() {
    return join(tmpDir, 'logs', agentName);
  }

  function writeOutbound(entries: Array<{ timestamp: string; chat_id: string; text: string }>) {
    mkdirSync(logDir(), { recursive: true });
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(logDir(), 'outbound-messages.jsonl'), lines, 'utf-8');
  }

  function recentTimestamp(offsetMs = 0): string {
    return new Date(Date.now() - offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'p6-dedup-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns not-duplicate when no log file exists', () => {
    const result = checkDuplicate(tmpDir, agentName, chatId, 'hello world');
    expect(result.isDuplicate).toBe(false);
  });

  it('returns not-duplicate when log is empty', () => {
    mkdirSync(logDir(), { recursive: true });
    writeFileSync(join(logDir(), 'outbound-messages.jsonl'), '', 'utf-8');
    const result = checkDuplicate(tmpDir, agentName, chatId, 'hello world');
    expect(result.isDuplicate).toBe(false);
  });

  it('returns not-duplicate when message is older than 60s', () => {
    writeOutbound([
      { timestamp: recentTimestamp(61_000), chat_id: chatId, text: 'hello world' },
    ]);
    const result = checkDuplicate(tmpDir, agentName, chatId, 'hello world');
    expect(result.isDuplicate).toBe(false);
  });

  it('returns not-duplicate when Jaccard is <= 0.7', () => {
    writeOutbound([
      { timestamp: recentTimestamp(5_000), chat_id: chatId, text: 'hello world foo bar baz' },
    ]);
    // "hello completely different text" shares only "hello" with a 5-token set
    const result = checkDuplicate(tmpDir, agentName, chatId, 'hello completely different text here');
    expect(result.isDuplicate).toBe(false);
  });

  it('detects a duplicate within the 60s window', () => {
    const msg = 'This is an important status update for the team';
    writeOutbound([{ timestamp: recentTimestamp(10_000), chat_id: chatId, text: msg }]);
    const result = checkDuplicate(tmpDir, agentName, chatId, msg);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchedScore).toBeDefined();
    expect(result.matchedScore!).toBeGreaterThan(0.7);
  });

  it('does not match entries from a different chat_id', () => {
    const msg = 'hello world exactly the same message';
    writeOutbound([{ timestamp: recentTimestamp(5_000), chat_id: '99999', text: msg }]);
    const result = checkDuplicate(tmpDir, agentName, chatId, msg);
    expect(result.isDuplicate).toBe(false);
  });

  it('includes matchedTimestamp in result when duplicate found', () => {
    const ts = recentTimestamp(3_000);
    const msg = 'duplicate message content here';
    writeOutbound([{ timestamp: ts, chat_id: chatId, text: msg }]);
    const result = checkDuplicate(tmpDir, agentName, chatId, msg);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchedTimestamp).toBe(ts);
  });

  it('only looks at the last 5 entries for that chat_id', () => {
    // 7 entries: first 2 are fresh duplicates but come from different chat, last 5 are non-dupes
    const msg = 'important alert';
    const entries = [
      { timestamp: recentTimestamp(1_000), chat_id: '99999', text: msg },
      { timestamp: recentTimestamp(2_000), chat_id: '99999', text: msg },
      { timestamp: recentTimestamp(3_000), chat_id: chatId, text: 'alpha beta gamma delta epsilon' },
      { timestamp: recentTimestamp(4_000), chat_id: chatId, text: 'one two three four five' },
      { timestamp: recentTimestamp(5_000), chat_id: chatId, text: 'red green blue yellow purple' },
      { timestamp: recentTimestamp(6_000), chat_id: chatId, text: 'foo bar baz qux quux' },
      { timestamp: recentTimestamp(7_000), chat_id: chatId, text: 'cat dog bird fish turtle' },
    ];
    // The 8th entry for this chatId (which would be the dup) is not in the last 5
    entries.unshift({ timestamp: recentTimestamp(50_000), chat_id: chatId, text: msg });
    writeOutbound(entries);
    const result = checkDuplicate(tmpDir, agentName, chatId, msg);
    expect(result.isDuplicate).toBe(false);
  });
});
