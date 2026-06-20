// Data-layer tests — run: node --test scripts/self-healing/wedge-watchdog-data.test.mjs
// Locks the 2026-06-19 arm-blocking interval fix: the Gate-A interval derives from observed
// last_heartbeat-ADVANCE gaps (what Gate-A measures), NOT the heartbeat-CRON schedule; and the
// bootstrap trust-gate downgrades any restart -> SURFACE while untrusted (< N advances), so a
// just-restarted/born-wedged agent can never be auto-restarted on an unmeasured cadence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  median, recordHbObservation, deriveIntervalFromHbObs, resolveInterval, applyTrust,
  MIN_HB_ADVANCES, BOOTSTRAP_PRIOR_MS,
} from './wedge-watchdog-data.mjs';

const MIN = 60_000;
const T0 = 1_000_000_000_000;

test('median basic', () => {
  assert.equal(median([4, 1, 7]), 4);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test('recordHbObservation: appends only on a NEW distinct hb value (a real advance), trims', () => {
  let obs = [];
  obs = recordHbObservation(obs, T0);            // first
  obs = recordHbObservation(obs, T0);            // duplicate (no advance) -> ignored
  obs = recordHbObservation(obs, T0 + 4 * MIN);  // advance
  obs = recordHbObservation(obs, 0);             // invalid -> ignored
  assert.deepEqual(obs, [T0, T0 + 4 * MIN]);
});

// --- cadence PAIR: the interval reflects ACTUAL hb-advance cadence, not the cron schedule ---

test('cadence (i) multi-cron EFFECTIVE-SHORT: advances every ~5min -> derives ~5min (NOT a 240min cron interval) [no-FN]', () => {
  // improver-class: hb advances on its frequent crons every ~5min even though its heartbeat-CRON
  // fires every 240min. Deriving from advances gives ~5min -> threshold ~10min -> a real wedge
  // at 160min PASSES Gate-A (caught), instead of being silently spared for 480min.
  let obs = [];
  for (let i = 0; i < 5; i++) obs = recordHbObservation(obs, T0 + i * 5 * MIN);
  const d = deriveIntervalFromHbObs(obs);
  assert.equal(d.source, 'hb-advance-median');
  assert.equal(d.ms, 5 * MIN, 'must be the measured ~5min advance cadence, NOT the 240min heartbeat-cron');
});

test('cadence (ii) GENUINELY-SLOW: advances every ~240min -> derives ~240min -> correctly slow [no-FP]', () => {
  let obs = [];
  for (let i = 0; i < 5; i++) obs = recordHbObservation(obs, T0 + i * 240 * MIN);
  assert.equal(deriveIntervalFromHbObs(obs).ms, 240 * MIN);
});

test('open frozen gap cannot inflate the interval (only completed advances counted)', () => {
  // 4 healthy 5-min advances, then the agent FREEZES (no further advance). "now" is hours later,
  // but recordHbObservation never sees a new value, so the median stays ~5min, not inflated.
  let obs = [];
  for (let i = 0; i < 5; i++) obs = recordHbObservation(obs, T0 + i * 5 * MIN);
  assert.equal(deriveIntervalFromHbObs(obs).ms, 5 * MIN);
});

// --- trust + bootstrap ------------------------------------------------------

test('resolveInterval: trusted only after >= MIN_HB_ADVANCES advance-gaps', () => {
  const mk = (n) => { let o = []; for (let i = 0; i <= n; i++) o = recordHbObservation(o, T0 + i * 5 * MIN); return o; };
  assert.equal(resolveInterval(mk(0)).trusted, false);   // 0 gaps
  assert.equal(resolveInterval(mk(MIN_HB_ADVANCES - 1)).trusted, false); // N-1 gaps
  const ok = resolveInterval(mk(MIN_HB_ADVANCES));        // N gaps
  assert.equal(ok.trusted, true);
  assert.equal(ok.intervalMs, 5 * MIN);
  // untrusted falls back to the SHORT prior (non-load-bearing for actions; kept short for prompt surfacing)
  assert.equal(resolveInterval([]).intervalMs, BOOTSTRAP_PRIOR_MS);
  assert.equal(resolveInterval([]).trusted, false);
});

test('bootstrap (a): applyTrust downgrades a would-be RESTART -> SURFACE while UNTRUSTED [restart-loop / quiet-healthy FP guard]', () => {
  const restart = { action: 'restart', reason: 'wedge', trace: {} };
  const downgraded = applyTrust(restart, /*trusted*/ false);
  assert.equal(downgraded.action, 'surface', 'an untrusted/just-restarted agent must NEVER auto-restart');
  // hold + none pass through unchanged even when untrusted
  assert.equal(applyTrust({ action: 'hold', reason: 'x' }, false).action, 'hold');
  assert.equal(applyTrust({ action: 'none', reason: 'x' }, false).action, 'none');
});

test('bootstrap (c): once TRUSTED, a real RESTART passes through (normal eval resumes)', () => {
  const restart = { action: 'restart', reason: 'wedge', trace: {} };
  assert.equal(applyTrust(restart, /*trusted*/ true).action, 'restart');
});

// Note: bootstrap (b) [untrusted + genuinely-wedged -> SURFACE then persist-past-cooldown ->
// ESCALATE, not silent-hold-forever] is the runner's stateful surface-persistence path
// (surfaceSince + COOLDOWN_MS reuse); verified live in the shadow dry-run + described in the
// re-review bundle. applyTrust above proves the SURFACE downgrade (the (b) entry condition).
