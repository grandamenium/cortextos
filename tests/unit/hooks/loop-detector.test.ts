import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  HISTORY_SIZE,
  REPETITION_BLOCK,
  PINGPONG_WINDOW,
  PINGPONG_BLOCK,
  EMERGENCY_ESCAPE_MS,
  HISTORY_RETAIN_MS,
  hashArgs,
  countRepetitions,
  detectPingPong,
  decideHookAction,
  loadState,
  type ToolCallRecord,
  type LoopDetectorState,
} from '../../../src/hooks/hook-loop-detector';

describe('hook-loop-detector hashArgs', () => {
  it('returns empty string for nullish input', () => {
    expect(hashArgs(null)).toBe('');
    expect(hashArgs(undefined)).toBe('');
  });

  it('is order-independent for object keys', () => {
    const a = hashArgs({ file_path: '/tmp/foo', old_string: 'x', new_string: 'y' });
    const b = hashArgs({ new_string: 'y', old_string: 'x', file_path: '/tmp/foo' });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(hashArgs({ items: [1, 2, 3] })).not.toBe(hashArgs({ items: [3, 2, 1] }));
  });
});

describe('hook-loop-detector repetition detection', () => {
  const makeRecord = (toolName: string, argsHash: string): ToolCallRecord => ({
    toolName,
    argsHash,
    ts: Date.now(),
  });

  it('counts exact tool plus args matches', () => {
    const history = [
      makeRecord('Read', 'abc'),
      makeRecord('Read', 'abc'),
      makeRecord('Edit', 'abc'),
      makeRecord('Read', 'def'),
    ];
    expect(countRepetitions(history, 'Read', 'abc')).toBe(2);
  });

  it('keeps threshold reachable within history size', () => {
    expect(HISTORY_SIZE).toBeGreaterThanOrEqual(REPETITION_BLOCK);
  });
});

describe('hook-loop-detector ping-pong detection', () => {
  const makeRecord = (toolName: string): ToolCallRecord => ({
    toolName,
    argsHash: hashArgs({ tool: toolName }),
    ts: Date.now(),
  });

  it('ignores histories shorter than the window', () => {
    const short = Array.from({ length: PINGPONG_WINDOW - 1 }, () => makeRecord('Read'));
    expect(detectPingPong(short).count).toBe(0);
  });

  it('detects a clean alternating pair', () => {
    const alternating = Array.from({ length: HISTORY_SIZE }, (_, i) =>
      makeRecord(i % 2 === 0 ? 'Read' : 'Edit'),
    );
    const result = detectPingPong(alternating);
    expect(result.count).toBeGreaterThanOrEqual(PINGPONG_BLOCK);
    expect(result.tools).toContain('Read');
    expect(result.tools).toContain('Edit');
  });

  it('does not flag monotone single-tool history as ping-pong', () => {
    const monotone = Array.from({ length: PINGPONG_WINDOW }, () => makeRecord('Read'));
    expect(detectPingPong(monotone).count).toBe(0);
  });
});

describe('hook-loop-detector decideHookAction — blocked-call non-recording', () => {
  const NOW = 1_800_000_000_000;

  function alternatingHistory(length: number): ToolCallRecord[] {
    return Array.from({ length }, (_, i) => ({
      toolName: i % 2 === 0 ? 'Bash' : 'Skill',
      argsHash: hashArgs({ i }),
      ts: NOW - (length - i) * 1000,
    }));
  }

  function repeatingHistory(length: number, toolName: string, argsHash: string): ToolCallRecord[] {
    return Array.from({ length }, (_, i) => ({
      toolName,
      argsHash,
      ts: NOW - (length - i) * 1000,
    }));
  }

  it('does not record blocked calls in history when ping-pong threshold tripped', () => {
    const state: LoopDetectorState = {
      history: alternatingHistory(HISTORY_SIZE),
      firstBlockedAt: null,
      emergencyEscapeUsed: false,
    };
    const decision = decideHookAction(state, 'Skill', hashArgs({ next: true }), NOW);
    expect(decision.action).toBe('block');
    expect(decision.nextState.history).toEqual(state.history);
    expect(decision.nextState.firstBlockedAt).toBe(NOW);
    expect(decision.nextState.emergencyEscapeUsed).toBe(false);
  });

  it('does not record blocked calls in history when repetition threshold tripped', () => {
    const repHash = hashArgs({ same: 'args' });
    const state: LoopDetectorState = {
      history: repeatingHistory(REPETITION_BLOCK, 'Read', repHash),
      firstBlockedAt: null,
      emergencyEscapeUsed: false,
    };
    const decision = decideHookAction(state, 'Read', repHash, NOW);
    expect(decision.action).toBe('block');
    expect(decision.nextState.history).toEqual(state.history);
    expect(decision.nextState.firstBlockedAt).toBe(NOW);
  });

  it('preserves firstBlockedAt across repeated blocks within the same window', () => {
    const earlier = NOW - 60_000;
    const state: LoopDetectorState = {
      history: alternatingHistory(HISTORY_SIZE),
      firstBlockedAt: earlier,
      emergencyEscapeUsed: false,
    };
    const decision = decideHookAction(state, 'Bash', hashArgs({ x: 1 }), NOW);
    expect(decision.action).toBe('block');
    expect(decision.nextState.firstBlockedAt).toBe(earlier);
  });
});

describe('hook-loop-detector decideHookAction — emergency escape', () => {
  const NOW = 1_800_000_000_000;

  function alternatingHistory(length: number): ToolCallRecord[] {
    return Array.from({ length }, (_, i) => ({
      toolName: i % 2 === 0 ? 'Bash' : 'Skill',
      argsHash: hashArgs({ i }),
      ts: NOW - (length - i) * 1000,
    }));
  }

  it('grants emergency escape after EMERGENCY_ESCAPE_MS blocked', () => {
    const state: LoopDetectorState = {
      history: alternatingHistory(HISTORY_SIZE),
      firstBlockedAt: NOW - EMERGENCY_ESCAPE_MS - 1,
      emergencyEscapeUsed: false,
    };
    const decision = decideHookAction(state, 'Bash', hashArgs({ alert: true }), NOW);
    expect(decision.action).toBe('escape');
    expect(decision.nextState.emergencyEscapeUsed).toBe(true);
    expect(decision.nextState.history).toEqual(state.history);
    expect(decision.alertMessage).toMatch(/Emergency escape granted after \d+ min blocked/);
  });

  it('only grants one emergency escape per blocked window', () => {
    const state: LoopDetectorState = {
      history: alternatingHistory(HISTORY_SIZE),
      firstBlockedAt: NOW - 2 * EMERGENCY_ESCAPE_MS,
      emergencyEscapeUsed: true,
    };
    const decision = decideHookAction(state, 'Skill', hashArgs({ retry: true }), NOW);
    expect(decision.action).toBe('block');
    expect(decision.nextState.emergencyEscapeUsed).toBe(true);
  });

  it('resets blocked-window state when call is allowed', () => {
    const calmHistory: ToolCallRecord[] = [
      { toolName: 'Read', argsHash: hashArgs({ a: 1 }), ts: NOW - 5000 },
      { toolName: 'Read', argsHash: hashArgs({ b: 2 }), ts: NOW - 4000 },
    ];
    const state: LoopDetectorState = {
      history: calmHistory,
      firstBlockedAt: NOW - 60_000,
      emergencyEscapeUsed: true,
    };
    const decision = decideHookAction(state, 'Read', hashArgs({ c: 3 }), NOW);
    expect(decision.action).toBe('allow');
    expect(decision.nextState.firstBlockedAt).toBeNull();
    expect(decision.nextState.emergencyEscapeUsed).toBe(false);
    expect(decision.nextState.history).toHaveLength(3);
  });
});

describe('hook-loop-detector decideHookAction — threshold sanity', () => {
  it('PINGPONG_BLOCK is set above the legitimate-alternation band', () => {
    expect(PINGPONG_BLOCK).toBeGreaterThanOrEqual(20);
    expect(PINGPONG_BLOCK).toBeLessThanOrEqual(HISTORY_SIZE);
  });

  it('HISTORY_RETAIN_MS is short enough to clear stale prior-session history', () => {
    expect(HISTORY_RETAIN_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(HISTORY_RETAIN_MS).toBeGreaterThanOrEqual(30 * 1000);
  });
});

describe('hook-loop-detector decideHookAction — cross-session staleness', () => {
  const NOW = 1_800_000_000_000;

  function staleAlternatingHistory(length: number, ageMs: number): ToolCallRecord[] {
    return Array.from({ length }, (_, i) => ({
      toolName: i % 2 === 0 ? 'Bash' : 'Skill',
      argsHash: hashArgs({ i }),
      ts: NOW - ageMs - (length - i) * 1000,
    }));
  }

  it('boot scenario: stale alternation from a prior session does not block the first new call', () => {
    const state: LoopDetectorState = {
      history: staleAlternatingHistory(HISTORY_SIZE, HISTORY_RETAIN_MS + 1000),
      firstBlockedAt: null,
      emergencyEscapeUsed: false,
    };
    const decision = decideHookAction(state, 'Bash', hashArgs({ first: 'boot' }), NOW);
    expect(decision.action).toBe('allow');
    expect(decision.nextState.history).toHaveLength(1);
    expect(decision.nextState.history[0].toolName).toBe('Bash');
  });

  it('drops stale entries from nextState.history on allow', () => {
    const stale = staleAlternatingHistory(5, HISTORY_RETAIN_MS + 1000);
    const fresh: ToolCallRecord[] = [
      { toolName: 'Read', argsHash: hashArgs({ a: 1 }), ts: NOW - 2000 },
    ];
    const state: LoopDetectorState = {
      history: [...stale, ...fresh],
      firstBlockedAt: null,
      emergencyEscapeUsed: false,
    };
    const decision = decideHookAction(state, 'Edit', hashArgs({ b: 2 }), NOW);
    expect(decision.action).toBe('allow');
    expect(decision.nextState.history).toHaveLength(2);
    expect(decision.nextState.history.map(r => r.toolName)).toEqual(['Read', 'Edit']);
  });

  it('drops stale entries from nextState.history on block', () => {
    const stale = staleAlternatingHistory(5, HISTORY_RETAIN_MS + 1000);
    const recentRepeats: ToolCallRecord[] = Array.from({ length: REPETITION_BLOCK }, (_, i) => ({
      toolName: 'Read',
      argsHash: 'samehash',
      ts: NOW - (REPETITION_BLOCK - i) * 100,
    }));
    const state: LoopDetectorState = {
      history: [...stale, ...recentRepeats],
      firstBlockedAt: null,
      emergencyEscapeUsed: false,
    };
    const decision = decideHookAction(state, 'Read', 'samehash', NOW);
    expect(decision.action).toBe('block');
    expect(decision.nextState.history.every(r => NOW - r.ts <= HISTORY_RETAIN_MS)).toBe(true);
    expect(decision.nextState.history).toHaveLength(REPETITION_BLOCK);
  });

  it('still blocks when alternation is fresh and within the retain window', () => {
    const recent: ToolCallRecord[] = Array.from({ length: HISTORY_SIZE }, (_, i) => ({
      toolName: i % 2 === 0 ? 'Bash' : 'Skill',
      argsHash: hashArgs({ i }),
      ts: NOW - (HISTORY_SIZE - i) * 1000,
    }));
    const state: LoopDetectorState = {
      history: recent,
      firstBlockedAt: null,
      emergencyEscapeUsed: false,
    };
    const decision = decideHookAction(state, 'Bash', hashArgs({ next: true }), NOW);
    expect(decision.action).toBe('block');
  });
});

describe('hook-loop-detector state loading', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loop-detector-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty history when state file does not exist', () => {
    expect(loadState(tmpDir).history).toEqual([]);
  });

  it('filters corrupt records on load', () => {
    writeFileSync(join(tmpDir, 'loop-detector.json'), JSON.stringify({
      history: [
        { toolName: 'Read', argsHash: 'abc', ts: 1000 },
        { toolName: null, argsHash: 'def', ts: 2000 },
        { toolName: 'Edit', argsHash: 789, ts: 3000 },
        { toolName: 'Bash', argsHash: 'xyz', ts: 5000 },
      ],
    }), 'utf-8');
    const state = loadState(tmpDir);
    expect(state.history).toHaveLength(2);
    expect(state.history.map(r => r.toolName)).toEqual(['Read', 'Bash']);
  });
});
