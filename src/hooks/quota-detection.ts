/**
 * BL-2026-05-08-003 phase 2 — quota detection module.
 *
 * Extracted from `hook-crash-alert.ts` so that file stays under
 * the 500-line hard cap per `.claude/rules/code-quality.md`. Also
 * gives phase 3's boss-failover skill a stable import surface for
 * the helpers without dragging in the whole SessionEnd hook.
 *
 * Distinct from `detectRateLimitInLog` (which lives in
 * `hook-crash-alert.ts`):
 *
 *   - `detectRateLimitInLog` is a UX classifier: broader patterns
 *     including "weekly limit", "5h limit", "used 80% of your".
 *     Boolean-returning. Used to suppress crash alerts during pause
 *     windows.
 *   - `detectProfileQuotaExhaustion` (here) is the failover signal:
 *     narrower, regex-only, returns the matched pattern name so
 *     phase-3 boss can attribute. Emits a bus event boss
 *     subscribes to.
 *
 * The two intentionally remain separate functions: merging them
 * would require a single return shape that serves both audiences,
 * which loses the clean "did we hit a known quota error" check
 * (boss needs the pattern name; the rate-limit classifier just
 * needs a boolean). Both call `readLogTail` from `src/utils/`
 * — single source of truth for bounded log reads.
 *
 * Pattern source: spec
 *   orgs/sb-personal/backlog/BL-2026-05-08-003-multi-claude-account-profiles.md
 *   §"Quota detection".
 * Validate against any new Anthropic error semantics before adding
 * patterns — false positives here cascade into spurious failovers
 * (see `.claude/rules/code-quality/llm-vague-triage-hallucinates.md`).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';

import { readLogTail } from '../utils/log-tail.js';

export const QUOTA_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'rate_limit_exceeded', regex: /rate_limit_exceeded/i },
  { name: 'credit_balance_too_low', regex: /credit_balance_too_low/i },
  // Word-separator-only gap between "quota" and "exceeded" — \s,
  // underscore, hyphen. Avoids matching English prose like
  // "quota was exceeded by" or "quota:not-exceeded" that could
  // appear in unrelated text and trigger spurious failover.
  { name: 'quota_exceeded', regex: /quota[\s_-]{0,10}exceeded/i },
  { name: 'http_429', regex: /HTTP\s+429/ },
  { name: 'usage_limit_reached', regex: /usage_limit_reached/i },
];

/**
 * Scan the tail of `logPath` for any QUOTA_PATTERNS match. Returns
 * the FIRST match's name by array-priority order (deterministic —
 * iteration order = priority) so the emitted
 * `profile_quota_exhausted` event includes a stable
 * `error_pattern` field rather than the full matched substring
 * (which could carry secrets / stack frames / megabytes of
 * context).
 *
 * Case handling: relies on the `/i` flag on each regex; does NOT
 * lowercase the input the way `detectRateLimitInLog` does. If a
 * future maintainer adds a CASE-SENSITIVE pattern (e.g. a literal
 * Anthropic SDK error code), it will work as expected here. Adding
 * the same pattern to the rate-limit detector would require
 * recasing or it'd silently miss after that detector's
 * `.toLowerCase()`.
 */
export function detectProfileQuotaExhaustion(logPath: string): {
  matched: boolean;
  pattern: string | null;
} {
  const slice = readLogTail(logPath, 200 * 1024);
  if (!slice) return { matched: false, pattern: null };
  // Strip ANSI color codes — Anthropic error messages render with them.
  const text = slice.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  for (const { name, regex } of QUOTA_PATTERNS) {
    if (regex.test(text)) {
      return { matched: true, pattern: name };
    }
  }
  return { matched: false, pattern: null };
}

/**
 * Read `claude_profile` from the agent's config.json. Returns null
 * when absent, malformed, or non-string. Caller treats null as
 * "agent uses default profile" for event metadata — phase-3 boss
 * skill checks the registry to find the agent's actual resolved
 * profile.
 */
export function readClaudeProfile(agentDir: string | undefined): string | null {
  if (!agentDir) return null;
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    return typeof cfg.claude_profile === 'string' && cfg.claude_profile ? cfg.claude_profile : null;
  } catch {
    return null;
  }
}

/**
 * Emit a `profile_quota_exhausted` bus event. Best-effort, fire-
 * and-forget — a failure here must not block the SessionEnd hook
 * (which still needs to fire crash alerts, dedup, etc.). Boss
 * subscribes to this event in phase 3 and uses the metadata to
 * decide whether to fail over the agent to its `fallback_profile`.
 */
export function emitProfileQuotaExhausted(meta: {
  agent: string;
  profile: string | null;
  error_pattern: string;
  observed_at: string;
  /** Reserved field — spec requires it but the hook does not yet
   *  parse stdin for session context. Always `null` in phase 2;
   *  phase-3 boss skill should treat undefined and null
   *  identically as "exit code unknown". */
  exit_code: number | null;
}): void {
  try {
    execFile(
      'cortextos',
      ['bus', 'log-event', 'action', 'profile_quota_exhausted', 'warning', '--meta', JSON.stringify(meta)],
      { timeout: 5_000 },
      () => { /* async errors land here — never propagate */ },
    );
    // The outer try/catch covers SYNCHRONOUS throws only (e.g.
    // JSON.stringify failure, which the typed input prevents).
    // Async failures from the spawned process surface in the
    // callback and are deliberately swallowed — the SessionEnd
    // hook must never crash on a downstream tool failure.
  } catch { /* never throw out of the SessionEnd hook */ }
}

/**
 * Run the quota detection + emit-on-match wiring for a SessionEnd.
 * Extracted from `hook-crash-alert.ts:main()` so that wiring is
 * unit-testable in isolation — the per-phase code-evaluator and
 * pr-deep-evaluator both flagged the lack of a main()-driven
 * integration test. Now the test calls THIS instead of stubbing
 * stdin and waiting for `main()` to compose itself.
 *
 * Scans stderr.log first, then stdout.log — Anthropic SDK in
 * Node typically emits errors to stderr, but Claude Code wrapping
 * can surface them via stdout.
 */
export function maybeEmitQuotaEvent(opts: {
  agentName: string;
  agentDir: string | undefined;
  stdoutPath: string;
  stderrPath: string;
  now: Date;
  /** Optional warn-stream sink for the unset-CTX_AGENT_DIR case;
   *  defaults to process.stderr. Tests inject a fake to assert
   *  the warning fires without polluting test stderr. */
  warnSink?: (msg: string) => void;
}): { matched: boolean; pattern: string | null } {
  let result: { matched: boolean; pattern: string | null } = { matched: false, pattern: null };
  for (const path of [opts.stderrPath, opts.stdoutPath]) {
    const r = detectProfileQuotaExhaustion(path);
    if (r.matched) {
      result = r;
      break;
    }
  }
  if (!result.matched || !result.pattern) return result;

  // Surface the env-fallback path explicitly: an unset
  // CTX_AGENT_DIR means we'd be reading config.json from cwd,
  // which on a hook spawn might be anywhere. The resulting
  // `profile` would be wrong rather than null, and phase-3
  // failover would route to the wrong fallback.
  if (!opts.agentDir) {
    const warn = opts.warnSink ?? ((m: string) => {
      try { process.stderr.write(m); } catch { /* ignore */ }
    });
    warn(`[hook-crash-alert] WARN: CTX_AGENT_DIR unset; profile resolution may be incorrect for agent=${opts.agentName}\n`);
  }

  emitProfileQuotaExhausted({
    agent: opts.agentName,
    profile: readClaudeProfile(opts.agentDir),
    error_pattern: result.pattern,
    observed_at: opts.now.toISOString(),
    exit_code: null,
  });
  return result;
}
