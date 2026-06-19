// Data-layer tests — run: node --test scripts/self-healing/wedge-watchdog-data.test.mjs
// Enforces the load-bearing interval-derivation contract (SA note (a)): the empirical
// interval uses CLOSED historical gaps only and is NOT inflated by a live stall; cold-start
// (too few closed gaps) returns null so the runner SKIPS rather than use an ambiguous config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIntervalMs, median, MIN_CLOSED_GAPS } from './wedge-watchdog-data.mjs';

const MIN = 60_000;
const T0 = 1_000_000_000_000;

test('median basic', () => {
  assert.equal(median([4, 1, 7]), 4);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test('synthetic STALLED history: open gap is NOT a closed gap -> interval == healthy median, NOT inflated', () => {
  // Six healthy 4-min fires, then the agent WEDGES and stops firing. The "now" is 50 min
  // after the last fire, but deriveIntervalMs only sees the FIRE timestamps — the open gap
  // (now - lastFire) is never one of the closed inter-fire gaps, so it cannot inflate.
  const fires = [];
  for (let i = 0; i < 6; i++) fires.push(T0 + i * 4 * MIN);
  // (a wedge means no further fires; nothing else is appended)
  const r = deriveIntervalMs(fires);
  assert.equal(r.source, 'empirical-closed-median');
  assert.equal(r.ms, 4 * MIN, 'must be the healthy 4-min median, NOT inflated by the 50-min stall');
});

test('cold-start (too few closed gaps) -> null => runner skips (no ambiguous config)', () => {
  assert.equal(deriveIntervalMs([]).ms, null);
  assert.equal(deriveIntervalMs([T0]).ms, null);                       // 0 gaps
  assert.equal(deriveIntervalMs([T0, T0 + 4 * MIN]).ms, null);         // 1 gap
  assert.equal(deriveIntervalMs([T0, T0 + 4 * MIN, T0 + 8 * MIN]).ms, null); // 2 gaps < MIN_CLOSED_GAPS
  // exactly MIN_CLOSED_GAPS closed gaps -> derives
  const ok = deriveIntervalMs([T0, T0 + 4 * MIN, T0 + 8 * MIN, T0 + 12 * MIN]);
  assert.equal(ok.nGaps, MIN_CLOSED_GAPS);
  assert.equal(ok.ms, 4 * MIN);
});

test('uses trailing window + is robust to a single outlier gap (median not mean)', () => {
  // five 4-min gaps + one 40-min outlier (e.g. a one-off slow turn) -> median stays ~4min
  const fires = [T0, T0 + 4 * MIN, T0 + 8 * MIN, T0 + 12 * MIN, T0 + 52 * MIN, T0 + 56 * MIN, T0 + 60 * MIN];
  const r = deriveIntervalMs(fires);
  assert.equal(r.ms, 4 * MIN, 'median resists the one inflated gap a mean would have skewed');
});

test('hourly agent -> ~60min interval (interval-awareness source, unit-agnostic)', () => {
  const fires = [];
  for (let i = 0; i < 5; i++) fires.push(T0 + i * 60 * MIN);
  assert.equal(deriveIntervalMs(fires).ms, 60 * MIN);
});
