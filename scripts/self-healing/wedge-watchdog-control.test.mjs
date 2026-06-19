// Runner-stateful control tests — run: node --test scripts/self-healing/wedge-watchdog-control.test.mjs
// Deterministically tests the SAFETY-CRITICAL runner state machine (injected state + time, I/O
// separated) — PD+SA arm-blocker: a live-verified-but-untested structural guard silently regresses
// on a refactor (the quota-watchdog untested-structural-guard masking-class). Covers: surface ->
// persist -> escalate-ONCE -> clear-on-recovery; re-wedge -> escalate-not-loop; mode-gating (shadow
// NEVER acts); PID-change -> reset hbObs (any-source born-wedged guard).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tickSurfaceState, restartDisposition, pidChangedReset, COOLDOWN_MS, SURFACE_ESCALATE_MS,
  escalationGate, escalationMessage, holdAlertGate, MIN_FLEET_TRUSTED,
} from './wedge-watchdog-data.mjs';

const T = 1_000_000_000_000;

// --- surface state machine: set -> persist -> escalate ONCE -> clear-on-recovery -------------

test('surface (b): first surface sets surfaceSince, does NOT escalate yet', () => {
  const s = tickSurfaceState({}, true, T);
  assert.equal(s.surfaceSince, T);
  assert.equal(s.surfacingForMs, 0);
  assert.equal(s.escalateNow, false);
});

test('surface (b): persists PAST the born-wedged window -> escalateNow = true ONCE (latches surfaceEscalated)', () => {
  const prev = { surfaceSince: T - (SURFACE_ESCALATE_MS + 1), surfaceEscalated: false };
  const s = tickSurfaceState(prev, true, T);
  assert.equal(s.escalateNow, true, 'a genuinely-never-advancing surface that persists must ESCALATE (not silently held)');
  assert.equal(s.surfaceEscalated, true, 'latch set so it does not re-escalate');
});

test('surface (b): already-escalated -> NO re-escalation (idempotent)', () => {
  const prev = { surfaceSince: T - (SURFACE_ESCALATE_MS * 2), surfaceEscalated: true };
  const s = tickSurfaceState(prev, true, T);
  assert.equal(s.escalateNow, false, 'must escalate exactly once, not every tick after');
});

test('surface FALSE-ESCALATION GUARD (2026-06-19 finding): slowest healthy agent surfacing UNDER the born-wedged window -> NO escalate', () => {
  // The born-wedged window must EXCEED the fleet's slowest healthy single-advance gap (measured
  // 2026-06-19: FE/BA ~240min). A healthy slow agent surfaces between its ticks then CLEARS
  // surfaceSince on each advance, so it never reaches SURFACE_ESCALATE_MS.
  const FLEET_SLOWEST_GAP_MS = 240 * 60_000;
  assert.ok(SURFACE_ESCALATE_MS > COOLDOWN_MS, 'born-wedged window must exceed the re-wedge cooldown (different timescales)');
  assert.ok(SURFACE_ESCALATE_MS > FLEET_SLOWEST_GAP_MS, 'born-wedged window must exceed the slowest healthy single-advance gap');
  // hourly user-proxy mid-gap (35min) -> no escalate
  assert.equal(tickSurfaceState({ surfaceSince: T - (COOLDOWN_MS + 5 * 60_000), surfaceEscalated: false }, true, T).escalateNow, false);
  // 240min-cadence FE/BA about to tick (surfacing 240min, < 6h window) -> NO false-escalate
  assert.equal(tickSurfaceState({ surfaceSince: T - FLEET_SLOWEST_GAP_MS, surfaceEscalated: false }, true, T).escalateNow, false, 'a 4h-cadence agent mid-gap must NOT false-escalate');
});

test('surface (b) born-wedged: genuinely-never-advancing agent surfacing past the window -> ESCALATES (not silently held)', () => {
  // Zero advances ever (surfaceSince never cleared) past SURFACE_ESCALATE_MS = genuinely stuck.
  const prev = { surfaceSince: T - (SURFACE_ESCALATE_MS + 60_000), surfaceEscalated: false };
  assert.equal(tickSurfaceState(prev, true, T).escalateNow, true);
});

test('surface CLEARS on recovery: !surfacing -> surfaceSince+surfaceEscalated wiped; a LATER wedge re-surfaces clean (not pre-escalated)', () => {
  const recovered = tickSurfaceState({ surfaceSince: T - COOLDOWN_MS * 2, surfaceEscalated: true }, false, T);
  assert.equal(recovered.surfaceSince, undefined);
  assert.equal(recovered.surfaceEscalated, false);
  // a later genuine wedge starts a FRESH surface (not pre-escalated)
  const reSurfaced = tickSurfaceState(recovered, true, T + 60_000);
  assert.equal(reSurfaced.surfaceSince, T + 60_000);
  assert.equal(reSurfaced.escalateNow, false);
});

// --- restart disposition: re-wedge->escalate-not-loop, mode-gating ---------------------------

test('restart: re-wedge WITHIN cooldown -> ESCALATE, do NOT loop-restart', () => {
  const rd = restartDisposition(T - 60_000, T, 'armed');   // last action 1min ago, < cooldown
  assert.equal(rd.cooling, true);
  assert.equal(rd.disposition, 'escalate');
  assert.equal(rd.act, false, 'must NOT auto-restart an agent it just restarted (loop guard)');
  assert.equal(rd.escalate, true);
});

test('restart: past cooldown + ARMED -> act (real restart)', () => {
  const rd = restartDisposition(T - (COOLDOWN_MS + 1), T, 'armed');
  assert.equal(rd.cooling, false);
  assert.equal(rd.act, true);
  assert.equal(rd.disposition, 'armed-restart');
});

test('restart: past cooldown + SHADOW -> would-restart, NEVER acts (shadow safety)', () => {
  const rd = restartDisposition(T - (COOLDOWN_MS + 1), T, 'shadow');
  assert.equal(rd.act, false, 'shadow must NEVER act, even on a restart disposition');
  assert.equal(rd.disposition, 'would-restart');
});

test('restart: never-acted-before (lastActionAt 0) -> not cooling', () => {
  assert.equal(restartDisposition(0, T, 'armed').cooling, false);
});

// --- PID-change reset: any-source restart -> reset hbObs -> untrusted -> surface --------------

test('pidChangedReset: PID changed (restart from ANY source) -> hbObs reset to [] + restarted=true', () => {
  const r = pidChangedReset(111, 222, [T, T + 60_000, T + 120_000]);
  assert.deepEqual(r.hbObs, []);
  assert.equal(r.restarted, true);
});

test('pidChangedReset: PID unchanged -> hbObs preserved', () => {
  const obs = [T, T + 60_000];
  const r = pidChangedReset(111, 111, obs);
  assert.deepEqual(r.hbObs, obs);
  assert.equal(r.restarted, false);
});

test('pidChangedReset: no prior pid (first sighting) -> no reset (cannot infer a restart)', () => {
  assert.equal(pidChangedReset(0, 222, [T]).restarted, false);
  assert.equal(pidChangedReset(undefined, 222, [T]).restarted, false);
});

// --- shadow-purity escalation gate (structural — single chokepoint inside escalate()) ---------

test('escalationGate: shadow -> false (LOG would-escalate, NO PD ping); armed -> true (ping)', () => {
  assert.equal(escalationGate('shadow'), false, 'shadow must be side-effect-free — no PD ping');
  assert.equal(escalationGate('off'), false);
  assert.equal(escalationGate('armed'), true);
});

test('escalationMessage by-reason: born-wedged path emits BORN-WEDGED (NOT the false RE-WEDGED), correct since-semantics', () => {
  const born = escalationMessage('born-wedged', 'frontend-dev', 360 * 60_000);
  assert.match(born, /BORN-WEDGED/);
  assert.doesNotMatch(born, /RE-WEDGED/, 'a born-wedged agent may never have acted — must NOT say RE-WEDGED after last action');
  assert.match(born, /surfacing 360m/, 'detail is surfacing-duration, not since-last-action');

  const rewedge = escalationMessage('re-wedge', 'backend-architect', 5 * 60_000);
  assert.match(rewedge, /RE-WEDGED 5m after last action/);
  assert.doesNotMatch(rewedge, /BORN-WEDGED/);

  const hold = escalationMessage('hold', 'platform-director', 0);
  assert.match(hold, /Gate-C|global pause|credit/i, 'HOLD describes the possible global-pause/credit case');
});

// --- HOLD fleet-state gate: push on an ESTABLISHED fleet stop, suppress during fleet-bootstrap ----
// COVERAGE PARTITION (must stay documented both sides): the case this SUPPRESSES — a real pause
// COINCIDING with a restart (fleet never re-advances -> stays untrusted -> HOLD suppressed) — is NOT
// uncovered: it is caught by SA's fleet-heartbeat-watch backstop (all-agents-hb-stale + work-silent,
// trust-independent). wedge-HOLD = trusted-fleet-mid-run-stop; backstop = post-restart-no-recover.
// A future refactor of EITHER monitor must preserve this partition (the cross-monitor coupling is a
// masking-class risk if silently re-opened).

test('holdAlertGate (b) ESTABLISHED fleet (>=K trusted, all-stopped) -> PUSH (real global pause not silenced)', () => {
  assert.equal(holdAlertGate(MIN_FLEET_TRUSTED), true);
  assert.equal(holdAlertGate(MIN_FLEET_TRUSTED + 5), true);
});

test('holdAlertGate (a) fleet-BOOTSTRAP (<K trusted, post-restart re-accumulation) -> SUPPRESS (no false push) [covered by fleet-heartbeat-watch]', () => {
  assert.equal(holdAlertGate(0), false, 'just after a restart (trust cleared via pidChangedReset) -> no false global-pause push');
  assert.equal(holdAlertGate(MIN_FLEET_TRUSTED - 1), false);
});

test('holdAlertGate (c) K boundary is exactly MIN_FLEET_TRUSTED', () => {
  assert.equal(holdAlertGate(MIN_FLEET_TRUSTED - 1), false);
  assert.equal(holdAlertGate(MIN_FLEET_TRUSTED), true);
});
