// wedge-watchdog-lib.mjs — pure detection logic for SYS-WEDGE-AUTORESTART.
//
// `evaluateWedge(state)` returns a verdict { agent, action, reason, trace } for ONE
// target agent. It is PURE (no I/O): the runner gathers fleet state (heartbeats,
// cron-execution.log fire times, ps PTY CPU, per-agent heartbeat-cron interval) and
// passes it in. The SAME function decides in shadow and armed mode — the mode flag
// gates only whether the runner ACTS on an action==='restart' verdict, so the shadow
// FP-count validates the exact logic that will act.
//
// Signature (corrected 2026-06-19 after SO-1 ground-truth — see proposals/SYS-WEDGE-AUTORESTART.md):
//   CORE (regime-independent, all required for a restart verdict):
//     Gate A  hb-frozen, PER-AGENT-INTERVAL-AWARE: now - last_heartbeat >= N x THAT
//             agent's own heartbeat-cron interval. (A global fixed window would falsely
//             fire on a healthy slow-cadence agent — the 2026-06-18 advance-delta FP.)
//     Gate B  never-reap-a-producing-agent — TWO sub-gates, BOTH required:
//             B1  PTY alive AND process-TREE CPU ~0% — CPU rolled up across pty.pid AND
//                 ALL descendants, so a child build/rebase/install burning CPU while the
//                 pty leader idles is caught (the leader-only CPU missed it). AND
//             B2  no work produced in the frozen window — now - lastActivityMs >= the
//                 Gate-A threshold. lastActivityMs = newest of {pty stdout.log mtime,
//                 commit mtime, task-update, bus-message-sent, state-dir write}.
//             B2 is the LOAD-BEARING never-reap discriminator (the OUTCOME). CPU alone
//             CANNOT separate a healthy agent waiting on a LIVE Anthropic stream from a
//             wedge waiting on a DEAD stream (a wedge IS a stream-stall — identical ~0%
//             CPU), nor child-process work (rebase/build) invisible to ps-on-pty.pid.
//             The pty stdout.log mtime in lastActivityMs is the direct live-vs-dead-stream
//             signal: a live stream writes tokens continuously (mtime advances); a dead
//             stream goes static. (Refinement-3: corroborate with work-produced, not CPU.)
//     Gate C  daemon-alive-via-OTHERS: >=1 OTHER agent both hb-fresh AND cron-advancing
//             at ITS own cadence => daemon alive + firing for others + credit present.
//             Else HOLD+alarm (global pause / credit / daemon-down — the could-be-real case).
//   CORROBORATOR (logged, NOT a gate — regime-dependent on the onFire-timeout daemon fix):
//     own cron-execution.log STALLED >= N x own interval (the stuck-firing-flag symptom).
//
// Orchestrator carve-out is SUBSUMED by Gate C: every agent (incl the orchestrator)
// requires >=1 other advancing agent before a restart, so the orchestrator is never
// restarted into an unverified global wall.
//
// Cooldown / crash-budget / shadow-vs-armed are the RUNNER's job (stateful across
// ticks); this function is a single-tick pure verdict.

export const FROZEN_INTERVALS = 2;   // Gate A: hb-frozen >= N x agent's own hb interval
export const CPU_IDLE_PCT = 2.0;     // Gate B: PTY "~0% CPU" ceiling
export const STALL_INTERVALS = 2;    // corroborator + Gate-C cron-advancing window (x interval)

/**
 * @param {object} state
 * @param {number} state.nowMs
 * @param {string} state.target                       agent under evaluation
 * @param {Object<string, AgentState>} state.agents   keyed by agent name
 * @typedef {object} AgentState
 * @property {boolean} enabled
 * @property {boolean} [hermes]
 * @property {boolean} [isOrchestrator]
 * @property {number}  heartbeatIntervalMs             THIS agent's own hb-cron interval
 * @property {number}  lastHeartbeatMs                 epoch ms of last_heartbeat
 * @property {boolean} ptyAlive
 * @property {number}  ptyTreeCpuPct                   CPU % rolled up across pty.pid + ALL descendants (catches child-process work)
 * @property {number}  lastActivityMs                  epoch ms, newest of {stdout.log mtime, commit, task-update, bus-message, state-dir write}
 * @property {string}  [lastActivitySource]            which source was newest (for the shadow trace)
 * @property {number}  lastCronFireMs                  epoch ms of last cron-execution.log fire
 * @returns {{agent:string, action:'restart'|'hold'|'none', reason:string, trace:object}}
 */
export function evaluateWedge(state) {
  const { nowMs, target, agents } = state;
  const t = agents[target];
  const mk = (action, reason, extra = {}) => ({
    agent: target, action, reason, trace: { target, ...extra },
  });

  if (!t) return mk('none', 'unknown-agent');
  if (!t.enabled || t.hermes) return mk('none', 'not-watched (disabled or hermes)');

  // --- Gate A: hb-frozen, interval-aware -----------------------------------
  const frozenForMs = nowMs - t.lastHeartbeatMs;
  const thresholdA = FROZEN_INTERVALS * t.heartbeatIntervalMs;
  const gateA = frozenForMs >= thresholdA;
  const aTrace = {
    gateA, frozenForMs, thresholdA, heartbeatIntervalMs: t.heartbeatIntervalMs,
  };
  if (!gateA) {
    return mk('none',
      `hb-advancing at own cadence (frozen ${Math.round(frozenForMs / 1000)}s < ${Math.round(thresholdA / 1000)}s = ${FROZEN_INTERVALS}x interval)`,
      aTrace);
  }

  // --- Gate B: never-reap-producing — B1 (CPU idle) AND B2 (no work in window) ---
  if (!t.ptyAlive) {
    return mk('none', 'pty-not-alive (crashed/stopped — not the wedge class)', { ...aTrace, gateB: false, ptyAlive: false });
  }
  const gateB1 = t.ptyTreeCpuPct < CPU_IDLE_PCT;
  if (!gateB1) {
    return mk('none', `process-tree busy (tree-CPU ${t.ptyTreeCpuPct}% >= ${CPU_IDLE_PCT}% — producing incl child build/rebase, never-reap)`,
      { ...aTrace, gateB1: false, ptyTreeCpuPct: t.ptyTreeCpuPct });
  }
  // B2 — load-bearing never-reap: no work produced anywhere in the frozen window.
  // lastActivitySource is carried into the trace so the shadow log shows WHICH source
  // was newest (PD shadow-watch: surfaces the silent-long-subprocess residual if it appears).
  const activityAgoMs = nowMs - t.lastActivityMs;
  const gateB2 = activityAgoMs >= thresholdA;
  const bTrace = {
    ...aTrace, gateB1: true, gateB2, ptyTreeCpuPct: t.ptyTreeCpuPct, cpuIdlePct: CPU_IDLE_PCT,
    lastActivityAgoMs: activityAgoMs, lastActivitySource: t.lastActivitySource ?? null,
  };
  if (!gateB2) {
    return mk('none',
      `work produced in window (last activity ${Math.round(activityAgoMs / 1000)}s ago via ${t.lastActivitySource ?? 'fs/bus'} < ${Math.round(thresholdA / 1000)}s threshold — producing, never-reap)`,
      bTrace);
  }

  // --- Gate C: daemon-alive via OTHER advancing agents (refutation) ---------
  const others = Object.entries(agents)
    .filter(([name, a]) => name !== target && a.enabled && !a.hermes);
  const advancing = others.filter(([, a]) => {
    const hbFresh = (nowMs - a.lastHeartbeatMs) < FROZEN_INTERVALS * a.heartbeatIntervalMs;
    const cronAdvancing = (nowMs - a.lastCronFireMs) < STALL_INTERVALS * a.heartbeatIntervalMs;
    return hbFresh && cronAdvancing;
  });
  const gateC = advancing.length >= 1;
  const cTrace = {
    ...bTrace, gateC, otherAdvancingCount: advancing.length,
    otherAdvancing: advancing.map(([n]) => n),
  };
  if (!gateC) {
    return mk('hold',
      'no other agent advancing — possible global pause / credit / daemon-down — HOLD + alarm',
      cTrace);
  }

  // --- All core gates pass => wedge. Corroborator is informational. ---------
  const stalledForMs = nowMs - t.lastCronFireMs;
  const corroborated = stalledForMs >= STALL_INTERVALS * t.heartbeatIntervalMs;
  return mk('restart',
    'wedge: hb-frozen(own-cadence) + pty-alive-idle + daemon-alive-via-others',
    {
      ...cTrace,
      corroborator_ownCronStalled: corroborated,
      ownCronStalledForMs: stalledForMs,
      isOrchestrator: !!t.isOrchestrator,
      orchestratorCarveout: 'subsumed by Gate C (>=1 other advancing required for all agents)',
    });
}
