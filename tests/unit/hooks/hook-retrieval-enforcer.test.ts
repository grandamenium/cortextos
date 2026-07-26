import { describe, it, expect } from 'vitest';
import {
  decideGates,
  parseEnvelope,
  sessionKey,
  extractKeywords,
  readCache,
  RETRIEVAL_INTENT,
  URGENT,
  type CacheState,
} from '../../../src/hooks/hook-retrieval-enforcer.js';

describe('parseEnvelope', () => {
  it('extracts prompt and session_id from the JSON envelope', () => {
    const r = parseEnvelope(JSON.stringify({ prompt: 'hello', session_id: 'abc-123' }));
    expect(r.prompt).toBe('hello');
    expect(r.sessionId).toBe('abc-123');
  });
  it('falls back to raw text on non-JSON, empty session id', () => {
    const r = parseEnvelope('not json');
    expect(r.prompt).toBe('not json');
    expect(r.sessionId).toBe('');
  });
  it('supports user_prompt/message aliases', () => {
    expect(parseEnvelope(JSON.stringify({ user_prompt: 'x' })).prompt).toBe('x');
    expect(parseEnvelope(JSON.stringify({ message: 'y' })).prompt).toBe('y');
  });
});

describe('sessionKey', () => {
  it('is stable and identical for the same session id', () => {
    expect(sessionKey('sess-1', '/a.jsonl')).toBe(sessionKey('sess-1', '/b.jsonl'));
  });
  it('differs across session ids (session boundary = new key)', () => {
    expect(sessionKey('sess-1', '/a.jsonl')).not.toBe(sessionKey('sess-2', '/a.jsonl'));
  });
  it('falls back to transcript path when no session id', () => {
    expect(sessionKey('', '/a.jsonl')).not.toBe(sessionKey('', '/b.jsonl'));
  });
});

describe('readCache fail-open', () => {
  it('returns fresh first-turn state for a missing cache file', () => {
    const c = readCache('definitely-not-a-real-key-xyz');
    expect(c.turnCount).toBe(0);
  });
});

describe('decideGates — the splitter', () => {
  const fresh: CacheState = { turnCount: 0 };
  const repeat: CacheState = { turnCount: 5 };

  it('first turn: full context (direction + kb)', () => {
    const g = decideGates('continue please', fresh);
    expect(g.wantDirection).toBe(true);
    expect(g.wantKb).toBe(true);
  });

  it('routine repeat turn: suppress direction + kb + transcripts', () => {
    const g = decideGates('ok go', repeat);
    expect(g.wantDirection).toBe(false);
    expect(g.wantKb).toBe(false);
    expect(g.wantTranscripts).toBe(false);
    expect(g.forceOpen).toBe(false);
  });

  it('retrieval intent forces full context even on a repeat turn', () => {
    const g = decideGates('what did we discuss earlier about the pipeline', repeat);
    expect(g.forceOpen).toBe(true);
    expect(g.wantDirection).toBe(true);
    expect(g.wantKb).toBe(true);
    expect(g.wantTranscripts).toBe(true);
  });

  it('urgency keyword forces open on a repeat turn', () => {
    const g = decideGates('production down, need help now', repeat);
    expect(g.forceOpen).toBe(true);
    expect(g.wantKb).toBe(true);
  });

  it('a strong keyword triggers transcripts + kb (Josh plain-question case)', () => {
    const g = decideGates('status of the fleet-context-diet rollout', repeat);
    expect(g.wantTranscripts).toBe(true);
    expect(g.wantKb).toBe(true);
  });

  it('long ambiguous prompt runs kb even without intent/keywords (safety valve)', () => {
    const longRoutine = 'a '.repeat(120); // >200 chars, no strong keywords
    const g = decideGates(longRoutine, repeat);
    expect(g.wantKb).toBe(true);
  });
});

describe('regexes', () => {
  it('RETRIEVAL_INTENT matches recall/earlier/history asks', () => {
    expect(RETRIEVAL_INTENT.test('recall what happened')).toBe(true);
    expect(RETRIEVAL_INTENT.test('just say ok')).toBe(false);
  });
  it('URGENT matches incident language', () => {
    expect(URGENT.test('security incident')).toBe(true);
    expect(URGENT.test('outage on prod')).toBe(true);
    expect(URGENT.test('routine update')).toBe(false);
  });
});

describe('extractKeywords', () => {
  it('splits strong (long/hyphenated) from weak tokens', () => {
    const { strong, weak } = extractKeywords('fix the retrieval-enforcer hook now');
    expect(strong).toContain('retrieval-enforcer');
    expect(weak.length).toBeGreaterThanOrEqual(0);
  });
});
