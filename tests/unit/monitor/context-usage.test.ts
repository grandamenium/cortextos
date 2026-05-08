import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  THRESHOLDS_1M,
  THRESHOLDS_200K,
  thresholdsFor,
  severityForPct,
  nextActionThresholdPct,
  encodeCwdToProjectDir,
  resolveContextLimit,
  findCurrentTranscriptPath,
  readLatestUsage,
  computeContextUsage,
  writeContextUsage,
  usageFromStatusLine,
} from '../../../src/monitor/context-usage';

describe('thresholdsFor', () => {
  it('picks 1M table at exactly 1M', () => {
    expect(thresholdsFor(1_000_000)).toEqual(THRESHOLDS_1M);
  });
  it('picks 1M table above 1M', () => {
    expect(thresholdsFor(1_500_000)).toEqual(THRESHOLDS_1M);
  });
  it('picks 200k table just below 1M', () => {
    expect(thresholdsFor(999_999)).toEqual(THRESHOLDS_200K);
  });
  it('picks 200k table at 200k', () => {
    expect(thresholdsFor(200_000)).toEqual(THRESHOLDS_200K);
  });
});

describe('severityForPct (1M thresholds 25/35/42/50)', () => {
  const t = THRESHOLDS_1M;
  it('green below soft', () => {
    expect(severityForPct(0, t)).toBe('green');
    expect(severityForPct(24.99, t)).toBe('green');
  });
  it('soft at exactly soft boundary (25)', () => {
    expect(severityForPct(25, t)).toBe('soft');
    expect(severityForPct(34.99, t)).toBe('soft');
  });
  it('yellow at 35-42', () => {
    expect(severityForPct(35, t)).toBe('yellow');
    expect(severityForPct(41.99, t)).toBe('yellow');
  });
  it('orange at 42-50', () => {
    expect(severityForPct(42, t)).toBe('orange');
    expect(severityForPct(49.99, t)).toBe('orange');
  });
  it('red at 50+', () => {
    expect(severityForPct(50, t)).toBe('red');
    expect(severityForPct(99, t)).toBe('red');
  });
});

describe('severityForPct (200k thresholds 50/65/75/85)', () => {
  const t = THRESHOLDS_200K;
  it('green below 50', () => {
    expect(severityForPct(49.99, t)).toBe('green');
  });
  it('soft at 50-65', () => {
    expect(severityForPct(50, t)).toBe('soft');
    expect(severityForPct(64.99, t)).toBe('soft');
  });
  it('yellow at 65-75', () => {
    expect(severityForPct(65, t)).toBe('yellow');
  });
  it('orange at 75-85', () => {
    expect(severityForPct(75, t)).toBe('orange');
  });
  it('red at 85+', () => {
    expect(severityForPct(85, t)).toBe('red');
    expect(severityForPct(95, t)).toBe('red');
  });
});

describe('nextActionThresholdPct', () => {
  it('returns the next escalation step for each non-red severity', () => {
    expect(nextActionThresholdPct('green', THRESHOLDS_1M)).toBe(25);
    expect(nextActionThresholdPct('soft', THRESHOLDS_1M)).toBe(35);
    expect(nextActionThresholdPct('yellow', THRESHOLDS_1M)).toBe(42);
    expect(nextActionThresholdPct('orange', THRESHOLDS_1M)).toBe(50);
  });
  it('returns null at red (no further escalation)', () => {
    expect(nextActionThresholdPct('red', THRESHOLDS_1M)).toBeNull();
  });
});

describe('encodeCwdToProjectDir', () => {
  it('replaces forward slashes with dashes', () => {
    expect(encodeCwdToProjectDir('/Volumes/Mac/foo')).toBe('-Volumes-Mac-foo');
  });
  it('leaves a path with no slashes unchanged', () => {
    expect(encodeCwdToProjectDir('foo')).toBe('foo');
  });
});

describe('resolveContextLimit', () => {
  it('1M when CLAUDE_CODE_DISABLE_1M_CONTEXT is unset and model is opus', () => {
    expect(resolveContextLimit({}, 'claude-opus-4-7')).toBe(1_000_000);
  });
  it('1M when CLAUDE_CODE_DISABLE_1M_CONTEXT=false and model is opus', () => {
    expect(resolveContextLimit({ CLAUDE_CODE_DISABLE_1M_CONTEXT: 'false' }, 'claude-opus-4-7')).toBe(1_000_000);
  });
  it('200k when CLAUDE_CODE_DISABLE_1M_CONTEXT=true on opus', () => {
    expect(resolveContextLimit({ CLAUDE_CODE_DISABLE_1M_CONTEXT: 'true' }, 'claude-opus-4-7')).toBe(200_000);
  });
  it('200k for non-opus models even when 1M is enabled', () => {
    expect(resolveContextLimit({}, 'claude-sonnet-4-6')).toBe(200_000);
    expect(resolveContextLimit({}, 'claude-haiku-4-5-20251001')).toBe(200_000);
  });
  it('200k when modelHint is empty', () => {
    expect(resolveContextLimit({}, '')).toBe(200_000);
  });
  it('case-insensitive on opus', () => {
    expect(resolveContextLimit({}, 'Claude-Opus-4-7')).toBe(1_000_000);
  });
});

describe('findCurrentTranscriptPath', () => {
  let projectsRoot: string;
  let cwd: string;
  let projDir: string;

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'cortextos-projects-'));
    cwd = '/some/abs/path';
    projDir = join(projectsRoot, encodeCwdToProjectDir(cwd));
    mkdirSync(projDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  it('returns null when project dir does not exist', () => {
    expect(findCurrentTranscriptPath(projectsRoot, '/nonexistent')).toBeNull();
  });
  it('returns null when project dir has no .jsonl files', () => {
    writeFileSync(join(projDir, 'README'), 'irrelevant');
    expect(findCurrentTranscriptPath(projectsRoot, cwd)).toBeNull();
  });
  it('picks the most-recently-modified .jsonl when multiple exist', () => {
    const older = join(projDir, 'older.jsonl');
    const newer = join(projDir, 'newer.jsonl');
    writeFileSync(older, '{}');
    writeFileSync(newer, '{}');
    // Force older mtime in the past, newer to now
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);
    const result = findCurrentTranscriptPath(projectsRoot, cwd);
    expect(result).toBe(newer);
  });
  it('keys on encoded cwd, not session id (session-restart-immunity)', () => {
    // Two distinct sessions in same cwd should both be discoverable
    // through the same cwd lookup; the most recent wins.
    const s1 = join(projDir, 'session-aaa.jsonl');
    const s2 = join(projDir, 'session-bbb.jsonl');
    writeFileSync(s1, '{}');
    writeFileSync(s2, '{}');
    const past = new Date(Date.now() - 5000);
    utimesSync(s1, past, past);
    expect(findCurrentTranscriptPath(projectsRoot, cwd)).toBe(s2);
  });
});

describe('readLatestUsage', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cortextos-transcript-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns null on missing file', () => {
    expect(readLatestUsage(join(dir, 'nope.jsonl'))).toBeNull();
  });
  it('returns null when no assistant turn has usage', () => {
    const path = join(dir, 't.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    expect(readLatestUsage(path)).toBeNull();
  });
  it('extracts usage from the last assistant turn (not earlier)', () => {
    const path = join(dir, 't.jsonl');
    const earlier = {
      type: 'assistant',
      sessionId: 'sess-1',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    };
    const later = {
      type: 'assistant',
      sessionId: 'sess-1',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 200_000 } },
    };
    writeFileSync(path, JSON.stringify(earlier) + '\n' + JSON.stringify(later) + '\n');
    const u = readLatestUsage(path);
    expect(u).toEqual({ input_tokens: 5, cache_creation: 1000, cache_read: 200_000, model: 'claude-opus-4-7', session_id: 'sess-1' });
  });
  it('skips non-assistant lines and malformed JSON gracefully', () => {
    const path = join(dir, 't.jsonl');
    const lines = [
      'not-json-at-all',
      JSON.stringify({ type: 'attachment' }),
      JSON.stringify({ type: 'assistant', sessionId: 's', message: { model: 'opus', usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      '',
      JSON.stringify({ type: 'user' }),
    ].join('\n');
    writeFileSync(path, lines);
    const u = readLatestUsage(path);
    expect(u?.input_tokens).toBe(7);
    expect(u?.session_id).toBe('s');
  });
  it('coerces NaN/missing usage fields to 0 (no false trigger on bad data)', () => {
    const path = join(dir, 't.jsonl');
    const obj = {
      type: 'assistant',
      sessionId: 's',
      message: { model: 'opus', usage: { input_tokens: 'oops', cache_creation_input_tokens: null } },
    };
    writeFileSync(path, JSON.stringify(obj) + '\n');
    expect(readLatestUsage(path)).toEqual({ input_tokens: 0, cache_creation: 0, cache_read: 0, model: 'opus', session_id: 's' });
  });
});

describe('computeContextUsage (end-to-end)', () => {
  let projectsRoot: string;
  let cwd: string;
  let projDir: string;
  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'cortextos-compute-'));
    cwd = '/abs/cwd/x';
    projDir = join(projectsRoot, encodeCwdToProjectDir(cwd));
    mkdirSync(projDir, { recursive: true });
  });
  afterEach(() => { rmSync(projectsRoot, { recursive: true, force: true }); });

  it('returns null when no transcript exists', () => {
    expect(computeContextUsage({ agent: 'a', cwd, projectsRoot, env: {} })).toBeNull();
  });

  it('computes loaded = input + cache_creation + cache_read and pct against 1M for opus with 1M enabled', () => {
    const tp = join(projDir, 'sess.jsonl');
    const obj = {
      type: 'assistant',
      sessionId: 'sid-1',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, cache_creation_input_tokens: 2867, cache_read_input_tokens: 128414 } },
    };
    writeFileSync(tp, JSON.stringify(obj) + '\n');
    const u = computeContextUsage({ agent: 'fullstack', cwd, projectsRoot, env: {}, now: new Date('2026-05-08T19:00:00Z') });
    expect(u).not.toBeNull();
    expect(u!.context_limit).toBe(1_000_000);
    expect(u!.current_loaded_tokens).toBe(131_282);
    expect(u!.pct).toBeCloseTo(13.13, 2);
    expect(u!.severity).toBe('green');
    expect(u!.next_action_threshold_pct).toBe(25);
    expect(u!.session_id).toBe('sid-1');
    expect(u!.agent).toBe('fullstack');
    expect(u!.transcript_path).toBe(tp);
    expect(u!.updated_at).toBe('2026-05-08T19:00:00Z');
  });

  it('escalates to orange at 1M opus near the 42-50% band', () => {
    const tp = join(projDir, 'sess.jsonl');
    // 450,000 / 1,000,000 = 45% → orange
    const obj = {
      type: 'assistant',
      sessionId: 'sid-2',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 450_000 } },
    };
    writeFileSync(tp, JSON.stringify(obj) + '\n');
    const u = computeContextUsage({ agent: 'a', cwd, projectsRoot, env: {} });
    expect(u!.severity).toBe('orange');
    expect(u!.pct).toBeCloseTo(45, 2);
    expect(u!.next_action_threshold_pct).toBe(50);
  });

  it('uses 200k thresholds when CLAUDE_CODE_DISABLE_1M_CONTEXT=true', () => {
    const tp = join(projDir, 'sess.jsonl');
    // 130k / 200k = 65% → yellow on 200k table
    const obj = {
      type: 'assistant',
      sessionId: 'sid-3',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 130_000 } },
    };
    writeFileSync(tp, JSON.stringify(obj) + '\n');
    const u = computeContextUsage({ agent: 'a', cwd, projectsRoot, env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: 'true' } });
    expect(u!.context_limit).toBe(200_000);
    expect(u!.severity).toBe('yellow');
    expect(u!.pct).toBeCloseTo(65, 2);
  });
});

describe('writeContextUsage', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cortextos-write-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes JSON the consumer reads at <stateDir>/context-pct.json', () => {
    const usage = {
      agent: 'a', session_id: 's', transcript_path: '/x', model: 'm',
      context_limit: 1_000_000, current_loaded_tokens: 100, pct: 0.01,
      severity: 'green' as const, next_action_threshold_pct: 25, updated_at: '2026-05-08T00:00:00Z',
    };
    const stateDir = join(dir, 'state', 'a');
    const p = writeContextUsage(stateDir, usage);
    expect(p).toBe(join(stateDir, 'context-pct.json'));
    expect(existsSync(p)).toBe(true);
    const round = JSON.parse(readFileSync(p, 'utf-8'));
    expect(round).toEqual(usage);
  });
});

describe('usageFromStatusLine', () => {
  it('returns null when context_window block is absent', () => {
    expect(usageFromStatusLine({ agent: 'a', input: {} })).toBeNull();
    expect(usageFromStatusLine({ agent: 'a', input: { session_id: 's' } })).toBeNull();
  });

  it('uses Claude-Code-reported context_window_size as the limit (no env-flag heuristic)', () => {
    // 1M opus reported directly
    const u = usageFromStatusLine({
      agent: 'a',
      input: {
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 13.13,
          current_usage: { input_tokens: 1, cache_creation_input_tokens: 2867, cache_read_input_tokens: 128414 },
        },
        session_id: 'sid-1',
        model: 'claude-opus-4-7',
      },
    });
    expect(u!.context_limit).toBe(1_000_000);
    expect(u!.current_loaded_tokens).toBe(131_282);
    expect(u!.pct).toBeCloseTo(13.13, 2);
    expect(u!.severity).toBe('green');
    expect(u!.next_action_threshold_pct).toBe(25);
    expect(u!.session_id).toBe('sid-1');
    expect(u!.model).toBe('claude-opus-4-7');
    expect(u!.transcript_path).toBe('statusline://current-session');
  });

  it('falls back to fallbackLimit (default 200k) when context_window_size missing', () => {
    const u = usageFromStatusLine({
      agent: 'a',
      input: {
        context_window: {
          // no context_window_size
          current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 130_000 },
        },
      },
    });
    expect(u!.context_limit).toBe(200_000);
    expect(u!.severity).toBe('yellow'); // 130k/200k = 65% on 200k table
  });

  it('honors explicit fallbackLimit', () => {
    const u = usageFromStatusLine({
      agent: 'a',
      input: {
        context_window: {
          current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000 },
        },
      },
      fallbackLimit: 1_000_000,
    });
    expect(u!.context_limit).toBe(1_000_000);
    expect(u!.severity).toBe('green'); // 10% on 1M
  });

  it('prefers Claude-Code-reported used_percentage when present', () => {
    // Claude reports 30% even though our naive sum would compute differently
    const u = usageFromStatusLine({
      agent: 'a',
      input: {
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 30,
          current_usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 },
        },
      },
    });
    expect(u!.pct).toBe(30);
    expect(u!.severity).toBe('soft'); // 30% on 1M = soft (25-35 band)
  });

  it('computes pct from current_usage when used_percentage missing', () => {
    const u = usageFromStatusLine({
      agent: 'a',
      input: {
        context_window: {
          context_window_size: 1_000_000,
          // used_percentage absent
          current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 450_000 },
        },
      },
    });
    expect(u!.pct).toBeCloseTo(45, 2);
    expect(u!.severity).toBe('orange');
  });

  it('coerces NaN/null fields without crashing', () => {
    const u = usageFromStatusLine({
      agent: 'a',
      input: {
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: null as any,
          current_usage: { input_tokens: NaN as any, cache_creation_input_tokens: undefined as any, cache_read_input_tokens: 5 },
        },
      },
    });
    expect(u!.current_loaded_tokens).toBe(5);
    expect(u!.severity).toBe('green');
  });

  it('escalates to red when reported pct ≥ 50% on 1M opus', () => {
    const u = usageFromStatusLine({
      agent: 'a',
      input: {
        context_window: { context_window_size: 1_000_000, used_percentage: 51 },
      },
    });
    expect(u!.severity).toBe('red');
    expect(u!.next_action_threshold_pct).toBeNull();
  });

  it('respects 200k thresholds when limit is 200k', () => {
    const u = usageFromStatusLine({
      agent: 'a',
      input: {
        context_window: { context_window_size: 200_000, used_percentage: 86 },
      },
    });
    expect(u!.context_limit).toBe(200_000);
    expect(u!.severity).toBe('red');
  });
});
