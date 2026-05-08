/**
 * BL-2026-05-08-003 phase 2 — quota-detection unit tests for the
 * SessionEnd hook. Covers:
 *  - QUOTA_PATTERNS regex matching against fixture log content
 *  - readClaudeProfile config.json shapes
 *  - emitProfileQuotaExhausted shells out to `cortextos bus log-event`
 *
 * These tests use real tmp files so the read-200KB-tail + ANSI-strip
 * path is exercised end-to-end. A mocked execFile lets us verify
 * the bus-event spawn args without actually invoking the CLI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  detectProfileQuotaExhaustion,
  readClaudeProfile,
  emitProfileQuotaExhausted,
  maybeEmitQuotaEvent,
} from '../../../src/hooks/quota-detection';

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'crashalert-quota-'));
  logPath = join(tmp, 'stderr.log');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('detectProfileQuotaExhaustion', () => {
  it('returns no-match for missing file (never throws)', () => {
    expect(detectProfileQuotaExhaustion('/nope/does-not-exist.log')).toEqual({
      matched: false,
      pattern: null,
    });
  });

  it('returns no-match for empty log', () => {
    writeFileSync(logPath, '', 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath)).toEqual({ matched: false, pattern: null });
  });

  it('returns no-match for log with no quota signature', () => {
    writeFileSync(logPath, 'some boring stderr line\nanother line\n', 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath)).toEqual({ matched: false, pattern: null });
  });

  it('matches rate_limit_exceeded (case-insensitive)', () => {
    writeFileSync(logPath, 'Error: RATE_LIMIT_EXCEEDED while calling messages.create\n', 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath)).toEqual({
      matched: true,
      pattern: 'rate_limit_exceeded',
    });
  });

  it('matches credit_balance_too_low', () => {
    writeFileSync(logPath, 'API error: credit_balance_too_low — please top up\n', 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath)).toEqual({
      matched: true,
      pattern: 'credit_balance_too_low',
    });
  });

  it('matches "quota exceeded" (with whitespace gap, generic)', () => {
    writeFileSync(logPath, 'Error: quota   exceeded for this account.\n', 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath)).toEqual({
      matched: true,
      pattern: 'quota_exceeded',
    });
  });

  it('matches HTTP 429', () => {
    writeFileSync(logPath, 'failed: HTTP 429 Too Many Requests\n', 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath)).toEqual({
      matched: true,
      pattern: 'http_429',
    });
  });

  it('matches usage_limit_reached', () => {
    writeFileSync(logPath, 'usage_limit_reached on weekly window\n', 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath)).toEqual({
      matched: true,
      pattern: 'usage_limit_reached',
    });
  });

  it('strips ANSI color codes before matching', () => {
    // Anthropic SDK error output usually carries ANSI escapes in
    // terminal mode; without stripping, the regex would miss them.
    const ansiText = '\x1b[31mError:\x1b[0m \x1b[1mrate_limit_exceeded\x1b[0m\n';
    writeFileSync(logPath, ansiText, 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath)).toEqual({
      matched: true,
      pattern: 'rate_limit_exceeded',
    });
  });

  it('returns the FIRST matched pattern by array-priority order (independent of textual position)', () => {
    // If a log contains BOTH patterns, array-priority order — not
    // textual occurrence order — must determine the winner.
    // Fixture writes credit_balance_too_low FIRST in the text and
    // rate_limit_exceeded SECOND, but rate_limit_exceeded comes
    // EARLIER in the QUOTA_PATTERNS array (priority slot 0 vs 1).
    // The detector iterates QUOTA_PATTERNS; the array-first match
    // wins regardless of where in the file each signature lives.
    //
    // If a future PR reorders QUOTA_PATTERNS, this test breaks
    // visibly — that's the protection.
    writeFileSync(
      logPath,
      'line A — credit_balance_too_low\nline B — rate_limit_exceeded\n',
      'utf-8',
    );
    expect(detectProfileQuotaExhaustion(logPath).pattern).toBe('rate_limit_exceeded');

    // Reversed text order — same outcome, proving the priority
    // is array-driven, not text-position-driven.
    writeFileSync(
      logPath,
      'line A — rate_limit_exceeded\nline B — credit_balance_too_low\n',
      'utf-8',
    );
    expect(detectProfileQuotaExhaustion(logPath).pattern).toBe('rate_limit_exceeded');
  });

  it('reads only the last 200KB of large logs (perf bound)', () => {
    // 200KB of innocuous content followed by the quota signature —
    // the signature is in the trailing window, so it MUST match.
    // (The reverse case — signature in the leading 200KB only — is
    // intentional: if a profile recovered and then ran clean for
    // hours, we don't want a stale signature triggering failover.)
    const filler = 'x'.repeat(200 * 1024);
    writeFileSync(logPath, filler + '\nrate_limit_exceeded\n', 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath).matched).toBe(true);
  });

  it('does not match the signature if it sits before the 200KB tail window', () => {
    // 250KB of content with the signature in the leading 50KB and
    // innocuous bytes in the trailing 200KB. Per the trailing-window
    // policy, this should NOT match.
    const head = 'rate_limit_exceeded\n' + 'a'.repeat(50 * 1024);
    const tail = 'b'.repeat(220 * 1024);
    writeFileSync(logPath, head + tail, 'utf-8');
    expect(detectProfileQuotaExhaustion(logPath).matched).toBe(false);
  });
});

describe('readClaudeProfile', () => {
  it('returns null when agentDir is undefined', () => {
    expect(readClaudeProfile(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readClaudeProfile(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{not json', 'utf-8');
    expect(readClaudeProfile(tmp)).toBeNull();
  });

  it('returns null when claude_profile is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readClaudeProfile(tmp)).toBeNull();
  });

  it('returns null when claude_profile is non-string', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ claude_profile: 42 }), 'utf-8');
    expect(readClaudeProfile(tmp)).toBeNull();
  });

  it('returns null when claude_profile is empty string', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ claude_profile: '' }), 'utf-8');
    expect(readClaudeProfile(tmp)).toBeNull();
  });

  it('returns the profile name when configured', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ claude_profile: 'work' }), 'utf-8');
    expect(readClaudeProfile(tmp)).toBe('work');
  });
});

describe('emitProfileQuotaExhausted', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('shells out to `cortextos bus log-event` with the right shape', () => {
    emitProfileQuotaExhausted({
      agent: 'engineer',
      profile: 'personal',
      error_pattern: 'rate_limit_exceeded',
      observed_at: '2026-05-08T20:00:00Z',
      exit_code: null,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execFileMock.mock.calls[0];
    expect(bin).toBe('cortextos');
    expect(args[0]).toBe('bus');
    expect(args[1]).toBe('log-event');
    expect(args[2]).toBe('action');
    expect(args[3]).toBe('profile_quota_exhausted');
    expect(args[4]).toBe('warning');
    expect(args[5]).toBe('--meta');
    const meta = JSON.parse(args[6]);
    expect(meta).toEqual({
      agent: 'engineer',
      profile: 'personal',
      error_pattern: 'rate_limit_exceeded',
      observed_at: '2026-05-08T20:00:00Z',
      exit_code: null,
    });
  });

  it('passes profile=null when the agent has no claude_profile set', () => {
    // The bus event still fires — phase-3 boss skill resolves the
    // null to the registry default before deciding fallback.
    emitProfileQuotaExhausted({
      agent: 'engineer',
      profile: null,
      error_pattern: 'http_429',
      observed_at: '2026-05-08T20:00:00Z',
      exit_code: null,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, args] = execFileMock.mock.calls[0];
    const meta = JSON.parse(args[6]);
    expect(meta.profile).toBeNull();
  });

  it('emits exit_code=null in metadata (spec field reserved for phase 3)', () => {
    // Spec line 109 names exit_code in the metadata. Phase 2 doesn't
    // parse stdin for session context, but the field is emitted as
    // explicit null (not undefined / omitted) so phase-3 boss code
    // doing `if (meta.exit_code != null)` gets unambiguous semantics.
    emitProfileQuotaExhausted({
      agent: 'x',
      profile: null,
      error_pattern: 'http_429',
      observed_at: 't',
      exit_code: null,
    });
    const [, args] = execFileMock.mock.calls[0];
    const meta = JSON.parse(args[6]);
    expect(Object.keys(meta)).toContain('exit_code');
    expect(meta.exit_code).toBeNull();
  });

  it('does not throw when execFile itself throws (best-effort contract)', () => {
    execFileMock.mockImplementationOnce(() => {
      throw new Error('simulated spawn failure');
    });
    expect(() =>
      emitProfileQuotaExhausted({
        agent: 'x',
        profile: null,
        error_pattern: 'http_429',
        observed_at: 't',
        exit_code: null,
      }),
    ).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────
// maybeEmitQuotaEvent — integration test that drives the wiring
// previously inline in hook-crash-alert.ts:main(). Extracted so the
// scan→read-profile→emit chain has a single test entry point. Both
// the per-phase code-evaluator and pr-deep-evaluator flagged this
// as a coverage gap; closing it here.
// ──────────────────────────────────────────────────────────────────

describe('maybeEmitQuotaEvent', () => {
  let agentDir: string;
  let stderrPath: string;
  let stdoutPath: string;

  beforeEach(() => {
    execFileMock.mockReset();
    agentDir = join(tmp, 'agent');
    require('fs').mkdirSync(agentDir, { recursive: true });
    stderrPath = join(tmp, 'stderr.log');
    stdoutPath = join(tmp, 'stdout.log');
  });

  it('emits the bus event with resolved profile when stderr matches', () => {
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ claude_profile: 'work' }), 'utf-8');
    writeFileSync(stderrPath, 'rate_limit_exceeded\n', 'utf-8');
    writeFileSync(stdoutPath, '', 'utf-8');

    const result = maybeEmitQuotaEvent({
      agentName: 'engineer',
      agentDir,
      stdoutPath,
      stderrPath,
      now: new Date('2026-05-08T20:30:00Z'),
    });

    expect(result.matched).toBe(true);
    expect(result.pattern).toBe('rate_limit_exceeded');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(execFileMock.mock.calls[0][1][6]);
    expect(meta).toEqual({
      agent: 'engineer',
      profile: 'work',
      error_pattern: 'rate_limit_exceeded',
      observed_at: '2026-05-08T20:30:00.000Z',
      exit_code: null,
    });
  });

  it('falls back to scanning stdout when stderr has no match', () => {
    writeFileSync(stderrPath, 'just normal output\n', 'utf-8');
    writeFileSync(stdoutPath, 'HTTP 429 Too Many Requests\n', 'utf-8');

    const result = maybeEmitQuotaEvent({
      agentName: 'engineer',
      agentDir,
      stdoutPath,
      stderrPath,
      now: new Date(),
    });

    expect(result.matched).toBe(true);
    expect(result.pattern).toBe('http_429');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('does not emit when neither log matches', () => {
    writeFileSync(stderrPath, 'normal\n', 'utf-8');
    writeFileSync(stdoutPath, 'also normal\n', 'utf-8');

    const result = maybeEmitQuotaEvent({
      agentName: 'engineer',
      agentDir,
      stdoutPath,
      stderrPath,
      now: new Date(),
    });

    expect(result.matched).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('warns to the warnSink when CTX_AGENT_DIR is unset', () => {
    // The warn fires only when a quota pattern is detected (otherwise
    // there's no failover-routing concern). Profile resolves to null
    // because no agentDir → no config.json read.
    writeFileSync(stderrPath, 'rate_limit_exceeded\n', 'utf-8');
    writeFileSync(stdoutPath, '', 'utf-8');
    const warnings: string[] = [];

    const result = maybeEmitQuotaEvent({
      agentName: 'engineer',
      agentDir: undefined,
      stdoutPath,
      stderrPath,
      now: new Date(),
      warnSink: (m) => warnings.push(m),
    });

    expect(result.matched).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/CTX_AGENT_DIR unset/);
    // Event still fires — operator can correlate the warn line with
    // the bus event's null profile field for triage.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(execFileMock.mock.calls[0][1][6]);
    expect(meta.profile).toBeNull();
  });

  it('does NOT warn on the no-match path (warn is failover-scoped)', () => {
    writeFileSync(stderrPath, 'normal\n', 'utf-8');
    writeFileSync(stdoutPath, 'normal\n', 'utf-8');
    const warnings: string[] = [];

    maybeEmitQuotaEvent({
      agentName: 'engineer',
      agentDir: undefined,
      stdoutPath,
      stderrPath,
      now: new Date(),
      warnSink: (m) => warnings.push(m),
    });

    // No warn — an unset CTX_AGENT_DIR is only a problem if we're
    // about to emit the failover signal. On the happy path (no
    // quota match) it's a non-event.
    expect(warnings).toHaveLength(0);
  });
});
