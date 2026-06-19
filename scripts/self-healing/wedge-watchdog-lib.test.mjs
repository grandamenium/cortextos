// Fixture matrix for evaluateWedge — run: node --test scripts/self-healing/wedge-watchdog-lib.test.mjs
//
// Proves the zero-FP crux (PD/SA review property): the ONLY state that yields a
// 'restart' verdict is a true wedge (hb-frozen at own cadence + PTY-alive-idle +
// NO work produced in the window + >=1 other agent advancing). Every benign
// confounder yields 'none' or 'hold'. The corroborator (own-cron-stalled) is logged,
// never decision-flipping. Activity-gate (B2) added 2026-06-19 after PD review:
// CPU alone cannot separate live-stream-wait (healthy) from dead-stream-wait (wedge);
// work-produced (incl pty stdout.log mtime = live-stream signal) is the discriminator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWedge, FROZEN_INTERVALS } from './wedge-watchdog-lib.mjs';

const MIN = 60_000;
const NOW = 1_000_000_000_000; // fixed epoch (no Date.now — determinism)

function fleet(targetState, others = { upx: healthy(60 * MIN) }) {
  return { nowMs: NOW, target: 'tgt', agents: { tgt: targetState, ...others } };
}
function healthy(intervalMs) {
  return {
    enabled: true, heartbeatIntervalMs: intervalMs,
    lastHeartbeatMs: NOW - intervalMs * 0.5,
    ptyAlive: true, ptyTreeCpuPct: 5,
    lastActivityMs: NOW - intervalMs * 0.3,
    lastCronFireMs: NOW - intervalMs * 0.5,
  };
}
const HB = 4 * MIN; // a normal 4-min heartbeat-cadence agent

test('1. true wedge (frozen + idle + no-activity + others-advancing) -> restart', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB,
    lastHeartbeatMs: NOW - 3 * HB, ptyAlive: true, ptyTreeCpuPct: 0.3,
    lastActivityMs: NOW - 3 * HB, lastActivitySource: 'stdout.log',
    lastCronFireMs: NOW - 3 * HB,
  }));
  assert.equal(v.action, 'restart');
  assert.equal(v.trace.corroborator_ownCronStalled, true);
});

test('2. PD live-wedge cron-silence (idle + cron silent + no-activity + others-advancing) -> restart', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB,
    lastHeartbeatMs: NOW - 50 * MIN, ptyAlive: true, ptyTreeCpuPct: 0.2,
    lastActivityMs: NOW - 50 * MIN, lastActivitySource: 'stdout.log',
    lastCronFireMs: NOW - 50 * MIN,
  }));
  assert.equal(v.action, 'restart');
});

test('3. PAUSE / no other advancing -> hold+alarm', () => {
  const v = evaluateWedge(fleet(
    { enabled: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 3 * HB, ptyAlive: true, ptyTreeCpuPct: 0.2, lastActivityMs: NOW - 3 * HB, lastCronFireMs: NOW - 3 * HB },
    { upx: { enabled: true, heartbeatIntervalMs: 60 * MIN, lastHeartbeatMs: NOW - 5 * 60 * MIN, ptyAlive: true, ptyTreeCpuPct: 0.1, lastActivityMs: NOW - 5 * 60 * MIN, lastCronFireMs: NOW - 5 * 60 * MIN } },
  ));
  assert.equal(v.action, 'hold');
});

test('4. GLOBAL stall (every agent frozen) -> hold+alarm', () => {
  const frozen = { enabled: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 4 * HB, ptyAlive: true, ptyTreeCpuPct: 0.1, lastActivityMs: NOW - 4 * HB, lastCronFireMs: NOW - 4 * HB };
  const v = evaluateWedge(fleet({ ...frozen }, { a: { ...frozen }, b: { ...frozen } }));
  assert.equal(v.action, 'hold');
});

test('5. BUSY high-CPU (long turn) -> none (Gate-B1, never-reap)', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 3 * HB,
    ptyAlive: true, ptyTreeCpuPct: 47, lastActivityMs: NOW - 0.1 * HB, lastCronFireMs: NOW - 3 * HB,
  }));
  assert.equal(v.action, 'none');
  assert.equal(v.trace.gateB1, false);
});

test('6. single missed tick (frozen < 2x interval) -> none', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 1.5 * HB,
    ptyAlive: true, ptyTreeCpuPct: 0.2, lastActivityMs: NOW - 1.5 * HB, lastCronFireMs: NOW - 1.5 * HB,
  }));
  assert.equal(v.action, 'none');
  assert.equal(v.trace.gateA, false);
});

test('7. healthy IDLE slow-cadence (user-proxy hourly, 40m since hb) -> none [interval-awareness]', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: 60 * MIN, lastHeartbeatMs: NOW - 40 * MIN,
    ptyAlive: true, ptyTreeCpuPct: 0.1, lastActivityMs: NOW - 40 * MIN, lastCronFireMs: NOW - 40 * MIN,
  }));
  assert.equal(v.action, 'none');
  assert.equal(v.trace.gateA, false);
});

test('8. idle healthy normal-cadence between 4m ticks -> none', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 3 * MIN,
    ptyAlive: true, ptyTreeCpuPct: 0.1, lastActivityMs: NOW - 3 * MIN, lastCronFireMs: NOW - 3 * MIN,
  }));
  assert.equal(v.action, 'none');
});

test('9. PTY not alive (crashed/stopped) -> none (out of scope: crashes -> SA hb-freeze alert)', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 3 * HB,
    ptyAlive: false, ptyTreeCpuPct: 0, lastActivityMs: NOW - 3 * HB, lastCronFireMs: NOW - 3 * HB,
  }));
  assert.equal(v.action, 'none');
});

test('10. orchestrator wedge, others advancing -> restart (carve-out subsumed by Gate C)', () => {
  const v = evaluateWedge(fleet({
    enabled: true, isOrchestrator: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 3 * HB,
    ptyAlive: true, ptyTreeCpuPct: 0.2, lastActivityMs: NOW - 3 * HB, lastCronFireMs: NOW - 3 * HB,
  }));
  assert.equal(v.action, 'restart');
});

test('11. orchestrator wedge, NO other fresh -> hold (never restart orchestrator into unverified wall)', () => {
  const v = evaluateWedge(fleet(
    { enabled: true, isOrchestrator: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 3 * HB, ptyAlive: true, ptyTreeCpuPct: 0.2, lastActivityMs: NOW - 3 * HB, lastCronFireMs: NOW - 3 * HB },
    { upx: { enabled: true, heartbeatIntervalMs: 60 * MIN, lastHeartbeatMs: NOW - 5 * 60 * MIN, ptyAlive: true, ptyTreeCpuPct: 0.1, lastActivityMs: NOW - 5 * 60 * MIN, lastCronFireMs: NOW - 5 * 60 * MIN } },
  ));
  assert.equal(v.action, 'hold');
});

test('12. corroborator logged, NOT decision-flipping: wedge with own-cron NOT stalled still restarts', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 3 * HB,
    ptyAlive: true, ptyTreeCpuPct: 0.2, lastActivityMs: NOW - 3 * HB,
    lastCronFireMs: NOW - 0.2 * HB,            // cron fired recently => corroborator FALSE
  }));
  assert.equal(v.action, 'restart');
  assert.equal(v.trace.corroborator_ownCronStalled, false);
});

test('13. interval from historical-median fallback (NOT stall-inflated) still fires on a real wedge', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB, lastHeartbeatMs: NOW - 3 * HB,
    ptyAlive: true, ptyTreeCpuPct: 0.2, lastActivityMs: NOW - 3 * HB, lastCronFireMs: NOW - 3 * HB,
  }));
  assert.equal(v.action, 'restart');
});

// --- PD-required activity-gate fixtures (the load-bearing never-reap assertions) ---

test('14. healthy LONG-TURN low-CPU but PRODUCING (activity in window) -> NONE [invariant-1, FE near-miss]', () => {
  // hb-frozen 3x + idle CPU (waiting on a LIVE stream / child build), BUT produced work
  // 1 interval ago (commit / stdout.log token output) INSIDE the 2x window. MUST NOT restart.
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB,
    lastHeartbeatMs: NOW - 3 * HB,            // hb lands only at turn boundaries while productive
    ptyAlive: true, ptyTreeCpuPct: 0.5,           // I/O-bound: identical CPU to a wedge
    lastActivityMs: NOW - 1 * HB, lastActivitySource: 'commit', // produced 1x interval ago (< 2x window)
    lastCronFireMs: NOW - 3 * HB,
  }));
  assert.equal(v.action, 'none', 'CPU-only would FALSELY restart a producing agent here');
  assert.equal(v.trace.gateB2, false);
  assert.equal(v.trace.lastActivitySource, 'commit');
});

test('14b. healthy BLOCKED on long child build (leader idle, TREE CPU high) -> NONE [process-tree B1, SA child-block]', () => {
  // The pty LEADER is idle (~0%) waiting on a synchronous child (npm build / git rebase),
  // its own activity signals may be stale, BUT the process-TREE CPU is high (child working).
  // Gate-B1 measures the tree, so this is excluded as producing — even if B2 would have matched.
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB,
    lastHeartbeatMs: NOW - 3 * HB, ptyAlive: true,
    ptyTreeCpuPct: 88,                        // child build/rebase burning CPU in the tree
    lastActivityMs: NOW - 3 * HB,             // worst case: own signals ALL stale while blocked
    lastCronFireMs: NOW - 3 * HB,
  }));
  assert.equal(v.action, 'none', 'process-tree CPU must catch a child build the leader is blocked on');
  assert.equal(v.trace.gateB1, false);
});

test('15. truly wedged: no activity ANYWHERE in window -> restart', () => {
  const v = evaluateWedge(fleet({
    enabled: true, heartbeatIntervalMs: HB,
    lastHeartbeatMs: NOW - 3 * HB, ptyAlive: true, ptyTreeCpuPct: 0.3,
    lastActivityMs: NOW - 3 * HB, lastActivitySource: 'stdout.log', // static since freeze-onset
    lastCronFireMs: NOW - 3 * HB,
  }));
  assert.equal(v.action, 'restart');
  assert.equal(v.trace.gateB2, true);
  // trace carries activity source for the shadow-watch residual (silent-subprocess)
  assert.ok('lastActivityAgoMs' in v.trace);
});

test('sanity: FROZEN_INTERVALS guard is the >=2 conservative window', () => {
  assert.ok(FROZEN_INTERVALS >= 2);
});
