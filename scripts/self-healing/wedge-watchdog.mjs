#!/usr/bin/env node
// wedge-watchdog.mjs — standalone cron-probe runner for SYS-WEDGE-AUTORESTART.
//
// Gathers live fleet state and calls the REVIEWED pure fn evaluateWedge (wedge-watchdog-lib.mjs)
// for each agent. The SAME code runs in shadow and armed mode; the mode flag gates ONLY the
// restart call, so the shadow FP-count validates the exact logic that will act.
//
//   CTX_WEDGE_WATCHDOG = off (default) | shadow | armed
//     off    — do nothing (parallels CTX_STALE_WATCHDOG default-off)
//     shadow — evaluate + log "WOULD restart / HOLD" with full per-fire trace; NEVER acts
//     armed  — additionally execute the restart on a 'restart' verdict (cooldown-gated)
//
// Invoked by the wedge-watchdog cron (off-boundary minute). Records its own fire so the
// cron-tick-freshness liveness backstop covers it (who-watches-the-watcher).
//
// Interval-derivation (load-bearing): heartbeatIntervalMs = median of CLOSED historical
// heartbeat-fire gaps from the agent's cron-execution.log, EXCLUDING the live open gap
// (a stalled agent's open gap would inflate the threshold and suppress the wedge). Config
// interval is only a cold-start fallback. (See wedge-watchdog.test.mjs for the enforcement.)

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { evaluateWedge } from './wedge-watchdog-lib.mjs';
import {
  ctxRoot, listAgentNames, lastHeartbeatMs, lastCronFireMs, recordHbObservation, resolveInterval, applyTrust,
  tickSurfaceState, restartDisposition, pidChangedReset, escalationGate, escalationMessage,
  lastActivity, ptyInfo, appendShadowLog, loadState, saveState, readMode, recordFire, COOLDOWN_MS,
} from './wedge-watchdog-data.mjs';

const FIRE_INTERVAL_SEC = 300; // matches the launchd StartInterval (for the liveness record)
// PD/SA: log a GATE-A-SPARED-DIVERGENCE when an agent is frozen past this FLAT reference
// (≈ SA's flat fleet-heartbeat-watch threshold) BUT Gate-A spares it because frozen < 2× its
// OWN empirical cadence — i.e. the interval-awareness suppressing a flat-backstop FP. Makes
// that (previously invisible) positive evidence provable from the trace. Log-additive only.
const FLAT_DIVERGENCE_REF_MS = 150 * 60 * 1000;

// SEC-WEDGE-ARGV (PD/FE 2026-06-19): the agent name reaches `cortextos` argv on the armed
// restart/escalate paths. Reject any name that is not a plain identifier so a '-'-prefixed
// name can never be parsed as a flag (argument injection). Primary guard; the '--' sentinel
// in the execFile args is the verified secondary.
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

async function main() {
  const root = ctxRoot();
  const nowMs = Date.now();
  const MODE = readMode(root);                 // RUNTIME, from the mutable mode file (PD condition c)

  // Record our own fire every tick (who-watches-the-watcher), even when off.
  recordFire(root, FIRE_INTERVAL_SEC);

  // Single persisted state object: lastMode + per-agent { hbObs, lastActionAt, surfaceSince }.
  const state = loadState(root);
  if (!state.agents) state.agents = {};
  // Audit any mode transition (the arm-flip is a file-write; the runner logs when it takes effect).
  if (state.lastMode !== MODE) {
    appendShadowLog(root, { ts: new Date(nowMs).toISOString(), event: 'MODE-TRANSITION', from: state.lastMode || 'unset', to: MODE });
    state.lastMode = MODE;
  }

  if (MODE === 'off') { saveState(root, state); console.log('[wedge-watchdog] mode=off — no-op'); return; }
  const names = listAgentNames(root);

  // Two PTY-tree CPU samples ~1s apart (PD note: max-of-window so a quiet mid-build
  // instant cannot fool B1). ptyInfo reads a shared ps snapshot per sample.
  const sampleA = ptyInfo(root, names);
  await sleep(1000);
  const sampleB = ptyInfo(root, names);
  await sleep(1000);
  const sampleC = ptyInfo(root, names);

  const agents = {};
  const trust = {};
  for (const name of names) {
    const a = sampleA[name] || {};
    const treeCpu = Math.max(
      sampleA[name]?.treeCpuPct ?? 0, sampleB[name]?.treeCpuPct ?? 0, sampleC[name]?.treeCpuPct ?? 0,
    );
    const act = lastActivity(root, name);
    const curHb = lastHeartbeatMs(root, name);
    // Accumulate observed hb-ADVANCES (persisted across ticks) -> resolve the Gate-A interval
    // + whether it is TRUSTED (>= N observed advances). Interval = measured hb-advance cadence,
    // NOT the heartbeat-cron schedule (the 2026-06-19 FN-class fix). No cold-start skip — an
    // untrusted agent is still evaluated, but the trust-gate downgrades any restart to a surface.
    const st = state.agents[name] || (state.agents[name] = {});
    // ANY-source restart (watchdog/daemon/self) detected by PID change -> reset hbObs -> untrusted
    // -> surface-only until N fresh advances (born-wedged guard, consistent across restart sources).
    const curPid = (sampleA[name] || {}).pid || 0;
    const reset = pidChangedReset(st.pid, curPid, st.hbObs);
    if (reset.restarted) st.hbObs = reset.hbObs;
    st.pid = curPid;
    st.hbObs = recordHbObservation(st.hbObs, curHb);
    const { intervalMs, trusted, nGaps } = resolveInterval(st.hbObs);
    trust[name] = { trusted, nGaps };
    agents[name] = {
      enabled: a.enabled !== false,
      hermes: !!a.hermes,
      isOrchestrator: name === 'platform-director', // informational only (carve-out subsumed by Gate C)
      heartbeatIntervalMs: intervalMs,
      lastHeartbeatMs: curHb,
      ptyAlive: !!a.ptyAlive,
      ptyTreeCpuPct: treeCpu,
      lastActivityMs: act.ms,
      lastActivitySource: act.source,
      lastCronFireMs: lastCronFireMs(root, name),
    };
  }

  const acted = [];
  for (const name of Object.keys(agents)) {
    // Trust-gate: while the interval is UNTRUSTED (< N hb-advances), any 'restart' is downgraded
    // to 'surface' (the bootstrap / restart-loop guard, by construction). evaluateWedge untouched.
    const verdict = applyTrust(evaluateWedge({ nowMs, target: name, agents }), trust[name].trusted);
    const stA = state.agents[name] || (state.agents[name] = {});
    // Surface state-machine (pure): sets/persists/escalates-once while surfacing, CLEARS on recovery.
    const surf = tickSurfaceState(stA, verdict.action === 'surface', nowMs);
    stA.surfaceSince = surf.surfaceSince; stA.surfaceEscalated = surf.surfaceEscalated;
    if (verdict.action !== 'hold') stA.holdAlerted = false;   // reset the HOLD-alert latch off-episode

    if (verdict.action === 'surface') {
      // Untrusted would-be-restart: SURFACE (logged), never auto-act. Persists past the born-wedged
      // window -> escalate ONCE. escalate() owns the shadow/armed gate (escalationGate) + logs the
      // WOULD-ESCALATE/ESCALATE line, so no per-site mode check here.
      appendShadowLog(root, {
        ts: new Date(nowMs).toISOString(), mode: MODE, agent: name, action: 'surface',
        disposition: 'SURFACE (untrusted interval / bootstrap — NOT auto-acting)',
        reason: verdict.reason, trusted: false, nGaps: trust[name].nGaps, surfacingForMs: surf.surfacingForMs, trace: verdict.trace,
      });
      if (surf.escalateNow) escalate(root, MODE, name, 'born-wedged', surf.surfacingForMs, verdict);
      continue;
    }

    if (verdict.action === 'none') {
      // PD trace-contract: POSITIVE never-reap evidence. Log every Gate-A candidate
      // (hb-frozen >= 2x its own interval) that was then SPARED by B1/B2 — a real FE/BA
      // long-turn reads here as "CANDIDATE-SPARED sparedBy=B2-activity ...". Not-frozen
      // agents (gateA false) are uninteresting — skip (no per-tick spam of all 11).
      const t = verdict.trace || {};
      if (t.gateA === true) {
        const sparedBy = t.gateB1 === false ? 'B1-tree-cpu'
          : (t.gateB2 === false ? 'B2-activity' : 'unknown');
        appendShadowLog(root, {
          ts: new Date(nowMs).toISOString(), mode: MODE, agent: name,
          action: 'none', disposition: 'CANDIDATE-SPARED', sparedBy, reason: verdict.reason,
          trusted: trust[name].trusted, nGaps: trust[name].nGaps,
          ptyTreeCpuPct: t.ptyTreeCpuPct, lastActivityAgoMs: t.lastActivityAgoMs,
          lastActivitySource: t.lastActivitySource, frozenForMs: t.frozenForMs, thresholdA: t.thresholdA,
        });
      } else if (t.gateA === false && t.frozenForMs >= FLAT_DIVERGENCE_REF_MS) {
        // Interval-awareness suppressing a flat-backstop FP: frozen past the flat ref but
        // < 2x this agent's OWN cadence. Visible positive evidence (improver/user-proxy class).
        const a = agents[name];
        appendShadowLog(root, {
          ts: new Date(nowMs).toISOString(), mode: MODE, agent: name,
          action: 'none', disposition: 'GATE-A-SPARED-DIVERGENCE', reason: verdict.reason,
          trusted: trust[name].trusted, nGaps: trust[name].nGaps,
          frozenForMs: t.frozenForMs, thresholdA: t.thresholdA, heartbeatIntervalMs: t.heartbeatIntervalMs,
          flatRefMs: FLAT_DIVERGENCE_REF_MS,
          lastActivityAgoMs: a ? Math.max(0, nowMs - a.lastActivityMs) : null, lastActivitySource: a ? a.lastActivitySource : null,
        });
      }
      continue;
    }
    if (!SAFE_NAME.test(name)) {
      appendShadowLog(root, { ts: new Date(nowMs).toISOString(), mode: MODE, agent: name, action: verdict.action, disposition: 'REFUSED-unsafe-agent-name (SEC-WEDGE-ARGV)' });
      continue;
    }

    const line = {
      ts: new Date(nowMs).toISOString(), mode: MODE, agent: name,
      action: verdict.action, reason: verdict.reason, trace: verdict.trace,
      trusted: trust[name].trusted, nGaps: trust[name].nGaps,
    };

    if (verdict.action === 'restart') {
      // Disposition via the pure helper: re-wedge-within-cooldown -> ESCALATE-not-loop;
      // past-cooldown + armed -> act; past-cooldown + shadow -> would-restart (shadow NEVER acts).
      const rd = restartDisposition(stA.lastActionAt, nowMs, MODE);
      line.cooldownActive = rd.cooling;
      if (rd.escalate) {
        // re-wedge within cooldown -> escalate, do NOT loop-restart. escalate() owns the shadow/armed
        // gate (escalationGate) + logs WOULD-ESCALATE in shadow — no per-site mode check.
        line.disposition = 'RE-WEDGE (escalation routed via escalate)';
        appendShadowLog(root, line);
        escalate(root, MODE, name, 're-wedge', rd.sinceLast, verdict);
        continue;
      }
      if (rd.act) {
        line.disposition = 'ARMED-RESTART';
        appendShadowLog(root, line);
        if (doRestart(name)) {
          stA.lastActionAt = nowMs; stA.lastAction = 'restart'; stA.hbObs = []; // restarted -> untrusted
          acted.push(name);
        }
        continue;
      }
      // shadow, not cooling -> would-restart (record the action time so a re-wedge escalates next).
      line.disposition = 'WOULD-RESTART (shadow)';
      appendShadowLog(root, line);
      stA.lastActionAt = nowMs; stA.lastAction = 'would-restart';
      continue;
    }

    // hold (Gate-C refutation: no other agent advancing = possible global pause / credit / daemon-down).
    // NEVER restarts. Fail-toward-surfacing: PUSH-ALERT PD once per HOLD episode (through the same
    // escalationGate — shadow logs WOULD-ESCALATE, armed pings). holdAlerted latch dedups; cleared
    // (with surface state) on any non-hold tick.
    line.disposition = 'HOLD (Gate-C refutation — no other agent advancing)';
    appendShadowLog(root, line);
    if (!stA.holdAlerted) { escalate(root, MODE, name, 'hold', 0, verdict); stA.holdAlerted = true; }
  }
  saveState(root, state);
  console.log(`[wedge-watchdog] mode=${MODE} evaluated=${names.length} acted=${acted.length}${acted.length ? ' [' + acted.join(',') + ']' : ''}`);
}

function doRestart(name) {
  if (!SAFE_NAME.test(name)) {            // defense-in-depth (caller already guards)
    console.error(`[wedge-watchdog] REFUSING restart of unsafe agent name "${name}" (SEC-WEDGE-ARGV)`);
    return false;
  }
  try {
    // `bus soft-restart`; '--' stops a '-'-prefixed name being parsed as a flag (verified honored).
    execFileSync('cortextos', ['bus', 'soft-restart', '--', name, 'wedge-watchdog auto-restart (armed)'], { timeout: 30000 });
    console.log(`[wedge-watchdog] ARMED restart issued: ${name}`);
    return true;
  } catch (err) {
    console.error(`[wedge-watchdog] restart failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Single escalation path — the SHADOW-PURITY gate (escalationGate) is INSIDE here, so EVERY
// call-site (surface born-wedged, re-wedge, any future) is shadow-safe by construction: in shadow
// it LOGS a WOULD-ESCALATE line (no PD ping); only armed pings. Message parameterized by reasonType.
function escalate(root, mode, name, reasonType, detailMs, verdict) {
  if (!SAFE_NAME.test(name)) return false;   // defense-in-depth (SEC-WEDGE-ARGV)
  const body = escalationMessage(reasonType, name, detailMs);
  if (!escalationGate(mode)) {               // SHADOW-PURITY: log would-escalate, NEVER ping
    appendShadowLog(root, { ts: new Date().toISOString(), mode, agent: name, action: 'escalate', disposition: `WOULD-ESCALATE (${reasonType}, shadow — logged, no PD ping)`, reason: body });
    return false;
  }
  try {
    execFileSync('cortextos', ['bus', 'send-message', 'platform-director', 'high',
      `[wedge-watchdog] ${body} Trace: ${verdict ? JSON.stringify(verdict.trace).slice(0, 300) : ''}`], { timeout: 15000 });
  } catch { /* best-effort */ }
  return true;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('[wedge-watchdog] fatal:', err); process.exit(0); }); // never crash the cron
