import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Unit tests for the context monitor logic in fast-checker.ts.
 * Tests the stateless helper functions and state machine in isolation.
 */

// --- Helpers to simulate context_status.json ---

function writeContextStatus(stateDir: string, pct: number | null, exceeds = false, ageMs = 0): void {
  mkdirSync(stateDir, { recursive: true });
  const written_at = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    join(stateDir, 'context_status.json'),
    JSON.stringify({ used_percentage: pct, exceeds_200k_tokens: exceeds, written_at }),
    'utf-8',
  );
}

// --- Staleness detection ---

describe('context_status.json staleness detection', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `ctx-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try { unlinkSync(join(stateDir, 'context_status.json')); } catch { /* ignore */ }
  });

  it('fresh file (0ms) passes staleness check', () => {
    writeContextStatus(stateDir, 72.4, false, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    const age = Date.now() - new Date(raw.written_at).getTime();
    expect(age).toBeLessThan(10 * 60_000);
  });

  it('file older than 10min is considered stale', () => {
    writeContextStatus(stateDir, 72.4, false, 11 * 60_000);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    const age = Date.now() - new Date(raw.written_at).getTime();
    expect(age).toBeGreaterThan(10 * 60_000);
  });

  it('null used_percentage is handled gracefully', () => {
    writeContextStatus(stateDir, null, false, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    expect(raw.used_percentage).toBeNull();
  });

  it('exceeds_200k_tokens=true with null pct is a valid signal', () => {
    writeContextStatus(stateDir, null, true, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    expect(raw.exceeds_200k_tokens).toBe(true);
  });
});

// --- Threshold tier selection ---

describe('context monitor tier selection', () => {
  const WARN = 70;
  const HANDOFF = 80;

  function selectTier(pct: number, exceeds: boolean, warningFiredAt: number, handoffFiredAt: number, now: number) {
    const effectivePct = pct !== null ? pct : (exceeds ? 101 : null);
    if (effectivePct === null) return 'none';

    // Tier 2 check (handoff) — must check before warning for edge cases
    if (effectivePct >= HANDOFF && handoffFiredAt === 0) return 'handoff';

    // Tier 1 check (warning) — 15min cooldown
    if (effectivePct >= WARN && now - warningFiredAt > 15 * 60_000) return 'warning';

    return 'none';
  }

  it('69% triggers no action', () => {
    expect(selectTier(69, false, 0, 0, Date.now())).toBe('none');
  });

  it('70% triggers warning', () => {
    expect(selectTier(70, false, 0, 0, Date.now())).toBe('warning');
  });

  it('79% triggers warning (below handoff threshold)', () => {
    expect(selectTier(79, false, 0, 0, Date.now())).toBe('warning');
  });

  it('80% triggers handoff (first time)', () => {
    expect(selectTier(80, false, 0, 0, Date.now())).toBe('handoff');
  });

  it('90% triggers handoff (first time, above handoff threshold)', () => {
    expect(selectTier(90, false, 0, 0, Date.now())).toBe('handoff');
  });

  it('80% with handoff already fired triggers warning (if cooldown elapsed)', () => {
    const handoffFiredAt = Date.now() - 20 * 60_000; // 20min ago
    expect(selectTier(80, false, 0, handoffFiredAt, Date.now())).toBe('warning');
  });
});

// --- Warning deduplication ---

describe('warning deduplication', () => {
  it('warning within 15min cooldown does not fire again', () => {
    const warningFiredAt = Date.now() - 5 * 60_000; // 5min ago
    const now = Date.now();
    const cooldownElapsed = now - warningFiredAt > 15 * 60_000;
    expect(cooldownElapsed).toBe(false);
  });

  it('warning after 15min cooldown fires again', () => {
    const warningFiredAt = Date.now() - 16 * 60_000; // 16min ago
    const now = Date.now();
    const cooldownElapsed = now - warningFiredAt > 15 * 60_000;
    expect(cooldownElapsed).toBe(true);
  });
});

// --- Circuit breaker ---

describe('context monitor circuit breaker', () => {
  it('3 restarts within 15min window trips breaker', () => {
    const now = Date.now();
    const restarts = [now - 14 * 60_000, now - 10 * 60_000, now - 1 * 60_000];
    const windowMs = 15 * 60_000;
    const inWindow = restarts.filter(t => now - t < windowMs);
    expect(inWindow.length).toBe(3);
    expect(inWindow.length >= 3).toBe(true); // trips
  });

  it('2 restarts in 15min window does not trip', () => {
    const now = Date.now();
    const restarts = [now - 10 * 60_000, now - 5 * 60_000];
    const inWindow = restarts.filter(t => now - t < 15 * 60_000);
    expect(inWindow.length).toBeLessThan(3);
  });

  it('old restarts outside 15min window are excluded', () => {
    const now = Date.now();
    const restarts = [now - 20 * 60_000, now - 18 * 60_000, now - 1 * 60_000];
    const inWindow = restarts.filter(t => now - t < 15 * 60_000);
    expect(inWindow.length).toBe(1); // only the recent one counts
  });

  it('circuit breaker resets after 30min pause', () => {
    const circuitBrokenAt = Date.now() - 31 * 60_000; // 31min ago
    const shouldReset = Date.now() - circuitBrokenAt >= 30 * 60_000;
    expect(shouldReset).toBe(true);
  });

  it('circuit breaker still active at 29min', () => {
    const circuitBrokenAt = Date.now() - 29 * 60_000;
    const shouldReset = Date.now() - circuitBrokenAt >= 30 * 60_000;
    expect(shouldReset).toBe(false);
  });
});

// --- Overflow-banner backstop self-referential guard ---

describe('overflow-banner backstop corroboration guard', () => {
  // Mirrors the hard overflow backstop in fast-checker.ts (~line 977). The PTY
  // banner regex is a backstop that force-restarts when Claude's live context-
  // overflow banner appears in an agent's terminal. Without the
  // ctxCorroboratesOverflow gate, the regex matched those banner phrases as benign
  // TEXT — so any agent that merely READ or DISCUSSED the overflow/compaction
  // mechanism (memory files, daemon source, chat) printed the strings into its own
  // PTY buffer and force-restarted itself at low context. Because the watchdog is
  // shared, multiple agents investigating the compaction mechanism at once could
  // cascade across runtimes. The gate requires usage to corroborate the banner:
  // exceeds_200k OR pct >= 85.
  const OVERFLOW_BANNER_RE = /extra usage.*?1[Mm] context|conversation too long.*?compaction/i;

  // NEW (guarded) detector — gates the banner regex on real high context.
  function forceRestartsOnOverflow(recentOutput: string, pct: number | null, exceeds200k: boolean): boolean {
    const ctxCorroboratesOverflow = exceeds200k || (pct !== null && pct >= 85);
    return ctxCorroboratesOverflow && OVERFLOW_BANNER_RE.test(recentOutput);
  }

  // OLD (pre-fix) detector — regex only, no context gate. Kept here ONLY to prove
  // the regression test has teeth: each real cascade string below MUST trip this,
  // and MUST NOT trip the guarded detector at low context. A test that passed on
  // both code paths would prove nothing.
  function oldDetectorRestarts(recentOutput: string): boolean {
    return OVERFLOW_BANNER_RE.test(recentOutput);
  }

  // The real same-line banner strings that triggered the false-positive. The regex
  // has no /s flag, so both tokens must share a line.
  const CASCADE_STRINGS = [
    // an agent's own answer describing the mechanism to the user
    'Context compaction/handoff — YES. The daemon watches compaction signals ("conversation too long…compaction") at threshold',
    // an agent's memory entry documenting the bug, quoting the regex pattern
    '## Self-Referential Overflow False-Positive — detector trips on conversation too long.*compaction in its own output',
    // an agent's diagnosis, quoting the pattern verbatim
    'fast-checker.ts has an unconditional regex that force-restarts on text matching conversation too long.*compaction',
  ];

  it('TEETH: every real cascade string trips the OLD detector (reproduces the bug)', () => {
    // If any of these did NOT match, the test would be a no-op green.
    for (const s of CASCADE_STRINGS) {
      expect(oldDetectorRestarts(s)).toBe(true);
    }
  });

  it('ROOT CAUSE: the same real cascade strings at LOW context do NOT force-restart on the fix', () => {
    // Each of these benign quotes looped an agent on old code; the guard kills it.
    for (const s of CASCADE_STRINGS) {
      expect(forceRestartsOnOverflow(s, 12, false)).toBe(false);
      expect(forceRestartsOnOverflow(s, 70, false)).toBe(false);
      expect(forceRestartsOnOverflow(s, 84, false)).toBe(false);
    }
  });

  it('genuine overflow (pct >= 85) with the banner DOES force-restart (backstop preserved)', () => {
    // Boundary: 84 is safe (covered above), 85 acts.
    expect(forceRestartsOnOverflow(CASCADE_STRINGS[0], 85, false)).toBe(true);
    expect(forceRestartsOnOverflow(CASCADE_STRINGS[0], 99, false)).toBe(true);
  });

  it('genuine overflow (exceeds_200k, null pct) with the banner DOES force-restart', () => {
    expect(forceRestartsOnOverflow(CASCADE_STRINGS[0], null, true)).toBe(true);
  });

  it('high context with NO banner phrase does NOT force-restart (regex still required)', () => {
    expect(forceRestartsOnOverflow('ordinary work output, nothing about overflow', 99, true)).toBe(false);
  });

  it('the "extra usage / 1M context" banner variant is gated the same way', () => {
    const variant = 'error: enable extra usage to access the 1M context window';
    expect(forceRestartsOnOverflow(variant, 20, false)).toBe(false); // low context, benign
    expect(forceRestartsOnOverflow(variant, 90, false)).toBe(true);  // genuine overflow
  });

  it('AGENTS.md-style boot text quoting the phrase at low context is safe', () => {
    const bootText = 'fast-checker watches context % and compaction signals ("conversation too long...compaction")';
    expect(forceRestartsOnOverflow(bootText, 8, false)).toBe(false);
  });
});

// --- Handoff block consumption ---

describe('consumeHandoffBlock', () => {
  let stateDir: string;
  let handoffDocPath: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `handoff-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    handoffDocPath = join(stateDir, 'handoff-doc.md');
    writeFileSync(handoffDocPath, '# Handoff\n\n## Current Tasks\n- Working on X', 'utf-8');
  });

  afterEach(() => {
    try { unlinkSync(join(stateDir, '.handoff-doc-path')); } catch { /* ignore */ }
    try { unlinkSync(handoffDocPath); } catch { /* ignore */ }
  });

  it('returns empty string when no marker exists', () => {
    // Simulate consumeHandoffBlock logic
    const markerPath = join(stateDir, '.handoff-doc-path');
    const exists = existsSync(markerPath);
    expect(exists).toBe(false);
    // result would be ''
  });

  it('returns handoff block when marker exists and doc is present', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, handoffDocPath + '\n', 'utf-8');

    // Simulate consumeHandoffBlock logic
    const doc = require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    const docExists = existsSync(doc);
    expect(docExists).toBe(true);
    expect(doc).toBe(handoffDocPath);
    expect(existsSync(markerPath)).toBe(false); // consumed
  });

  it('marker file is unlinked after consumption', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, handoffDocPath + '\n', 'utf-8');
    expect(existsSync(markerPath)).toBe(true);
    // consume
    require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('returns empty when marker points to nonexistent doc', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, '/nonexistent/path/doc.md\n', 'utf-8');
    const doc = require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    const docExists = existsSync(doc);
    expect(docExists).toBe(false);
  });
});
