import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  HISTORY_SIZE,
  REPETITION_BLOCK,
  PINGPONG_WINDOW,
  PINGPONG_BLOCK,
  hashArgs,
  countRepetitions,
  detectPingPong,
  loadState,
  type ToolCallRecord,
} from '../../../src/hooks/hook-loop-detector';

// ---------------------------------------------------------------------------
// hashArgs
// ---------------------------------------------------------------------------

describe('hashArgs', () => {
  it('returns empty string for null/undefined', () => {
    expect(hashArgs(null)).toBe('');
    expect(hashArgs(undefined)).toBe('');
  });

  it('returns a non-empty hex string for an object', () => {
    const h = hashArgs({ file_path: '/tmp/foo', content: 'bar' });
    expect(h).toMatch(/^[0-9a-f]+$/);
    expect(h.length).toBeGreaterThan(0);
  });

  it('is order-independent for object keys', () => {
    const a = hashArgs({ file_path: '/tmp/foo', old_string: 'x', new_string: 'y' });
    const b = hashArgs({ new_string: 'y', old_string: 'x', file_path: '/tmp/foo' });
    expect(a).toBe(b);
  });

  it('produces different hashes for different values', () => {
    const a = hashArgs({ file_path: '/tmp/a' });
    const b = hashArgs({ file_path: '/tmp/b' });
    expect(a).not.toBe(b);
  });

  it('preserves array order', () => {
    const a = hashArgs({ items: [1, 2, 3] });
    const b = hashArgs({ items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// countRepetitions
// ---------------------------------------------------------------------------

describe('countRepetitions', () => {
  const makeRecord = (toolName: string, argsHash: string): ToolCallRecord => ({
    toolName,
    argsHash,
    ts: Date.now(),
  });

  it('returns 0 for empty history', () => {
    expect(countRepetitions([], 'Read', 'abc')).toBe(0);
  });

  it('counts exact matches', () => {
    const history = [
      makeRecord('Read', 'abc'),
      makeRecord('Read', 'abc'),
      makeRecord('Edit', 'abc'),
      makeRecord('Read', 'def'),
    ];
    expect(countRepetitions(history, 'Read', 'abc')).toBe(2);
  });

  it('requires both tool name and args hash to match', () => {
    const history = [makeRecord('Read', 'abc'), makeRecord('Edit', 'abc')];
    expect(countRepetitions(history, 'Read', 'abc')).toBe(1);
    expect(countRepetitions(history, 'Edit', 'abc')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detectPingPong
// ---------------------------------------------------------------------------

describe('detectPingPong', () => {
  const makeRecord = (toolName: string): ToolCallRecord => ({
    toolName,
    argsHash: hashArgs({ tool: toolName }),
    ts: Date.now(),
  });

  it('returns 0 for history shorter than PINGPONG_WINDOW', () => {
    const short = Array.from({ length: PINGPONG_WINDOW - 1 }, () => makeRecord('Read'));
    expect(detectPingPong(short).count).toBe(0);
  });

  it('returns 0 when no two tools dominate the window', () => {
    // 4 different tools spread evenly — no pair dominates 80%
    const tools = ['Read', 'Write', 'Grep', 'Bash', 'Edit', 'Glob', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Grep', 'Bash'];
    const history = tools.map(makeRecord);
    expect(detectPingPong(history).count).toBe(0);
  });

  it('detects a clean A/B alternation pattern', () => {
    // PINGPONG_WINDOW alternating Read/Edit = PINGPONG_WINDOW-1 alternations
    const alternating = Array.from({ length: PINGPONG_WINDOW }, (_, i) =>
      makeRecord(i % 2 === 0 ? 'Read' : 'Edit'),
    );
    const result = detectPingPong(alternating);
    expect(result.count).toBeGreaterThan(0);
    expect(result.tools).not.toBeNull();
    expect(result.tools).toContain('Read');
    expect(result.tools).toContain('Edit');
  });

  it('does not detect when same tool fills the window (no alternation)', () => {
    // All Read — no ping-pong
    const monotone = Array.from({ length: PINGPONG_WINDOW }, () => makeRecord('Read'));
    expect(detectPingPong(monotone).count).toBe(0);
  });

  it('uses the last PINGPONG_WINDOW records to identify the pair', () => {
    // Build HISTORY_SIZE records with varied tools, then append a clean alternating window
    const noise = Array.from({ length: HISTORY_SIZE - PINGPONG_WINDOW }, () =>
      makeRecord('Glob'),
    );
    const alternating = Array.from({ length: PINGPONG_WINDOW }, (_, i) =>
      makeRecord(i % 2 === 0 ? 'Read' : 'Edit'),
    );
    const history = [...noise, ...alternating];
    const result = detectPingPong(history);
    expect(result.count).toBeGreaterThan(0);
  });

  it('counts alternations across the full history (not just the window)', () => {
    // Build HISTORY_SIZE alternating Read/Edit entries so alternation count
    // spans the full history — necessary for PINGPONG_BLOCK (14) to be reachable
    // since max alternations in PINGPONG_WINDOW (12) alone is only 11.
    const fullAlternating = Array.from({ length: HISTORY_SIZE }, (_, i) =>
      makeRecord(i % 2 === 0 ? 'Read' : 'Edit'),
    );
    const result = detectPingPong(fullAlternating);
    // Full alternation across 30 records gives 29 alternations — well above PINGPONG_BLOCK
    expect(result.count).toBeGreaterThanOrEqual(PINGPONG_BLOCK);
  });
});

// ---------------------------------------------------------------------------
// loadState
// ---------------------------------------------------------------------------

describe('loadState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loop-detector-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty history when state file does not exist', () => {
    const state = loadState(tmpDir);
    expect(state.history).toEqual([]);
  });

  it('filters out corrupt records on load (Bug-1 fix)', () => {
    const stateFile = join(tmpDir, 'loop-detector.json');
    const corrupt = {
      history: [
        { toolName: 'Read', argsHash: 'abc', ts: 1000 }, // valid
        { toolName: null, argsHash: 'def', ts: 2000 },   // null toolName — corrupt
        { toolName: 'Edit', argsHash: 789, ts: 3000 },   // argsHash not string — corrupt
        { toolName: 'Grep' },                             // missing argsHash and ts — corrupt
        { toolName: 'Bash', argsHash: 'xyz', ts: 5000 }, // valid
      ],
    };
    writeFileSync(stateFile, JSON.stringify(corrupt), 'utf-8');
    const state = loadState(tmpDir);
    expect(state.history).toHaveLength(2);
    expect(state.history[0].toolName).toBe('Read');
    expect(state.history[1].toolName).toBe('Bash');
  });
});

// ---------------------------------------------------------------------------
// Threshold sanity
// ---------------------------------------------------------------------------

describe('threshold constants', () => {
  it('HISTORY_SIZE >= REPETITION_BLOCK', () => {
    expect(HISTORY_SIZE).toBeGreaterThanOrEqual(REPETITION_BLOCK);
  });

  it('PINGPONG_WINDOW <= HISTORY_SIZE', () => {
    expect(PINGPONG_WINDOW).toBeLessThanOrEqual(HISTORY_SIZE);
  });

  it('PINGPONG_BLOCK > PINGPONG_WINDOW (alternations counted across full history)', () => {
    // The block threshold is checked against the FULL history alternation count,
    // not just the PINGPONG_WINDOW, so it can exceed the window size. This is
    // intentional — without this, the max reachable alternation count in a
    // 12-call window is only 11, making a threshold of 14 unreachable.
    expect(PINGPONG_BLOCK).toBeGreaterThan(PINGPONG_WINDOW);
  });
});
