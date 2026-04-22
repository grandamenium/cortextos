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

// --- Tier 0 autoreset threshold selection ---

describe('Tier 0 autoreset tier selection', () => {
  // Mirrors FastChecker.checkContextStatus ordering: Tier 3 (deadline) is
  // evaluated before Tier 0, but Tier 0 is evaluated before Tier 1/2 so a
  // silent auto-reset takes priority over the graceful handoff prompt.
  function selectTier(
    pct: number,
    exceeds: boolean,
    opts: {
      autoreset?: number;       // 0 = disabled (absent or explicit 0)
      autoresetFiredAt?: number;
      handoffFiredAt?: number;
      warningFiredAt?: number;
      handoffDeadlineAt?: number;
      now?: number;
      restartPlanned?: boolean;
    } = {},
  ): 'tier0' | 'tier0_skipped_already_planned' | 'tier3' | 'handoff' | 'warning' | 'none' {
    const WARN = 70;
    const HANDOFF = 80;
    const now = opts.now ?? Date.now();
    const autoreset = typeof opts.autoreset === 'number' && opts.autoreset > 0 ? opts.autoreset : 0;

    const effectivePct = pct !== null ? pct : (exceeds ? 101 : null);
    if (effectivePct === null) return 'none';

    if (opts.handoffDeadlineAt && opts.handoffDeadlineAt > 0 && now > opts.handoffDeadlineAt) {
      return 'tier3';
    }

    if (autoreset > 0 && effectivePct >= autoreset && (opts.autoresetFiredAt ?? 0) === 0) {
      return opts.restartPlanned ? 'tier0_skipped_already_planned' : 'tier0';
    }

    if (effectivePct >= HANDOFF && (opts.handoffFiredAt ?? 0) === 0) return 'handoff';

    if (effectivePct >= WARN && now - (opts.warningFiredAt ?? 0) > 15 * 60_000) return 'warning';

    return 'none';
  }

  it('55% with autoreset=55 triggers tier0', () => {
    expect(selectTier(55, false, { autoreset: 55 })).toBe('tier0');
  });

  it('54% with autoreset=55 does nothing', () => {
    expect(selectTier(54, false, { autoreset: 55 })).toBe('none');
  });

  it('autoreset=0 (disabled) at 55% does nothing at tier0 and stays below warn', () => {
    expect(selectTier(55, false, { autoreset: 0 })).toBe('none');
  });

  it('autoreset=0 (disabled) at 72% falls through to warning', () => {
    expect(selectTier(72, false, { autoreset: 0 })).toBe('warning');
  });

  it('autoreset undefined (unset) at 55% does nothing (observe-only)', () => {
    expect(selectTier(55, false, {})).toBe('none');
  });

  it('tier0 already fired in this session does not re-fire', () => {
    expect(selectTier(90, false, { autoreset: 55, autoresetFiredAt: Date.now() - 1000 }))
      .toBe('handoff'); // falls through
  });

  it('tier0 fires before handoff even when both thresholds cross on same tick', () => {
    expect(selectTier(95, false, { autoreset: 55 })).toBe('tier0');
  });

  it('tier0 skipped when .restart-planned marker already present', () => {
    expect(selectTier(60, false, { autoreset: 55, restartPlanned: true }))
      .toBe('tier0_skipped_already_planned');
  });

  it('tier3 deadline fires before tier0 (hard rescue always wins)', () => {
    expect(selectTier(90, false, {
      autoreset: 55,
      handoffDeadlineAt: Date.now() - 1000,
    })).toBe('tier3');
  });

  it('exceeds_200k_tokens with null pct triggers tier0 (effectivePct = 101)', () => {
    expect(selectTier(null as unknown as number, true, { autoreset: 55 })).toBe('tier0');
  });

  it('negative or NaN autoreset is treated as disabled', () => {
    expect(selectTier(55, false, { autoreset: -10 })).toBe('none');
    expect(selectTier(55, false, { autoreset: Number.NaN })).toBe('none');
  });
});

// --- Tier 0 boot-window guard ---
//
// Tier 0 must NOT fire within 60s of session start. Otherwise a fresh boot
// that lands above the threshold (bloated CLAUDE.md, pre-loaded handoff doc)
// will enter a restart loop: each new session crosses the threshold within
// the first tick and immediately triggers another restart.

describe('Tier 0 boot-window guard', () => {
  function shouldFire(sessionStartedAtMs: number, now: number): boolean {
    const sessionAge = sessionStartedAtMs > 0 ? now - sessionStartedAtMs : Infinity;
    if (sessionAge >= 0 && sessionAge < 60_000) return false; // boot window
    return true;
  }

  it('skips when session just booted (age 0s)', () => {
    const now = Date.now();
    expect(shouldFire(now, now)).toBe(false);
  });

  it('skips when session is 59s old', () => {
    const now = Date.now();
    expect(shouldFire(now - 59_000, now)).toBe(false);
  });

  it('fires once session is 60s old', () => {
    const now = Date.now();
    expect(shouldFire(now - 60_000, now)).toBe(true);
  });

  it('fires when session is many minutes old', () => {
    const now = Date.now();
    expect(shouldFire(now - 10 * 60_000, now)).toBe(true);
  });

  it('fires when we never saw a session_id (sessionStartedAt never set)', () => {
    // Legacy agents without session_id in context_status.json fall back
    // to Infinity age → always past the boot window.
    expect(shouldFire(0, Date.now())).toBe(true);
  });
});

// --- .restart-planned staleness, clock-skew safe ---

describe('.restart-planned staleness check', () => {
  function markerIsFresh(markerMtimeMs: number, now: number): boolean {
    const markerAge = now - markerMtimeMs;
    return markerAge >= 0 && markerAge < 2 * 60_000;
  }

  it('fresh marker (30s old) blocks Tier 0', () => {
    const now = Date.now();
    expect(markerIsFresh(now - 30_000, now)).toBe(true);
  });

  it('stale marker (3min old) does not block Tier 0', () => {
    const now = Date.now();
    expect(markerIsFresh(now - 3 * 60_000, now)).toBe(false);
  });

  it('marker exactly 2min old does not block Tier 0 (boundary)', () => {
    const now = Date.now();
    expect(markerIsFresh(now - 120_000, now)).toBe(false);
  });

  it('clock skew: marker mtime in the future is treated as stale', () => {
    // Negative markerAge = system clock jumped backward. Do not trust the
    // marker — treat as leaked and proceed with Tier 0.
    const now = Date.now();
    expect(markerIsFresh(now + 5 * 60_000, now)).toBe(false);
  });
});
