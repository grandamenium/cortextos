// Runner-stateful control tests — run: node --test scripts/self-healing/wedge-watchdog-control.test.mjs
// Deterministically tests the SAFETY-CRITICAL runner state machine (injected state + time, I/O
// separated) — PD+SA arm-blocker: a live-verified-but-untested structural guard silently regresses
// on a refactor (the quota-watchdog untested-structural-guard masking-class). Covers: surface ->
// persist -> escalate-ONCE -> clear-on-recovery; re-wedge -> escalate-not-loop; mode-gating (shadow
// NEVER acts); PID-change -> reset hbObs (any-source born-wedged guard).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tickSurfaceState, restartDisposition, pidChangedReset, COOLDOWN_MS,
} from './wedge-watchdog-data.mjs';

const T = 1_000_000_000_000;

// --- surface state machine: set -> persist -> escalate ONCE -> clear-on-recovery -------------

test('surface (b): first surface sets surfaceSince, does NOT escalate yet', () => {
  const s = tickSurfaceState({}, true, T);
  assert.equal(s.surfaceSince, T);
  assert.equal(s.surfacingForMs, 0);
  assert.equal(s.escalateNow, false);
});

test('surface (b): persists PAST cooldown -> escalateNow = true ONCE (latches surfaceEscalated)', () => {
  const prev = { surfaceSince: T - (COOLDOWN_MS + 1), surfaceEscalated: false };
  const s = tickSurfaceState(prev, true, T);
  assert.equal(s.escalateNow, true, 'a born-wedged surface that persists must ESCALATE (not silently held)');
  assert.equal(s.surfaceEscalated, true, 'latch set so it does not re-escalate');
});

test('surface (b): already-escalated -> NO re-escalation (idempotent)', () => {
  const prev = { surfaceSince: T - (COOLDOWN_MS * 3), surfaceEscalated: true };
  const s = tickSurfaceState(prev, true, T);
  assert.equal(s.escalateNow, false, 'must escalate exactly once, not every tick after');
});

test('surface (b): not-yet-past-cooldown -> no escalate', () => {
  const prev = { surfaceSince: T - (COOLDOWN_MS - 60_000), surfaceEscalated: false };
  assert.equal(tickSurfaceState(prev, true, T).escalateNow, false);
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
