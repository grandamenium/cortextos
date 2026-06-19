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
  ctxRoot, listAgentNames, heartbeatIntervalMs, lastHeartbeatMs, lastCronFireMs,
  lastActivity, ptyInfo, appendShadowLog, loadState, saveState, readMode, recordFire, COOLDOWN_MS,
} from './wedge-watchdog-data.mjs';

const FIRE_INTERVAL_SEC = 300; // matches the launchd StartInterval (for the liveness record)

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

  // Audit any mode transition (the arm-flip is a file-write; the runner logs when it takes effect).
  const state0 = loadState(root);
  if (state0.lastMode !== MODE) {
    appendShadowLog(root, { ts: new Date(nowMs).toISOString(), event: 'MODE-TRANSITION', from: state0.lastMode || 'unset', to: MODE });
    state0.lastMode = MODE; saveState(root, state0);
  }

  if (MODE === 'off') { console.log('[wedge-watchdog] mode=off — no-op'); return; }
  const names = listAgentNames(root);

  // Two PTY-tree CPU samples ~1s apart (PD note: max-of-window so a quiet mid-build
  // instant cannot fool B1). ptyInfo reads a shared ps snapshot per sample.
  const sampleA = ptyInfo(root, names);
  await sleep(1000);
  const sampleB = ptyInfo(root, names);
  await sleep(1000);
  const sampleC = ptyInfo(root, names);

  const agents = {};
  const skipped = [];
  for (const name of names) {
    const intervalMs = heartbeatIntervalMs(root, name);
    if (intervalMs == null) { skipped.push(name); continue; } // cold-start: too few closed gaps
    const a = sampleA[name] || {};
    const treeCpu = Math.max(
      sampleA[name]?.treeCpuPct ?? 0, sampleB[name]?.treeCpuPct ?? 0, sampleC[name]?.treeCpuPct ?? 0,
    );
    const act = lastActivity(root, name);
    agents[name] = {
      enabled: a.enabled !== false,
      hermes: !!a.hermes,
      isOrchestrator: name === 'platform-director', // informational only (carve-out subsumed by Gate C)
      heartbeatIntervalMs: intervalMs,
      lastHeartbeatMs: lastHeartbeatMs(root, name),
      ptyAlive: !!a.ptyAlive,
      ptyTreeCpuPct: treeCpu,
      lastActivityMs: act.ms,
      lastActivitySource: act.source,
      lastCronFireMs: lastCronFireMs(root, name),
    };
  }
  if (skipped.length) console.log(`[wedge-watchdog] cold-start skip (insufficient interval history): ${skipped.join(',')}`);

  const state = loadState(root);
  const acted = [];
  for (const name of Object.keys(agents)) {
    const verdict = evaluateWedge({ nowMs, target: name, agents });
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
          ptyTreeCpuPct: t.ptyTreeCpuPct, lastActivityAgoMs: t.lastActivityAgoMs,
          lastActivitySource: t.lastActivitySource, frozenForMs: t.frozenForMs, thresholdA: t.thresholdA,
        });
      }
      continue;
    }
    if (!SAFE_NAME.test(name)) {
      appendShadowLog(root, { ts: new Date(nowMs).toISOString(), mode: MODE, agent: name, action: verdict.action, disposition: 'REFUSED-unsafe-agent-name (SEC-WEDGE-ARGV)' });
      continue;
    }

    // Cooldown / escalate-not-loop bookkeeping (per-agent).
    const st = state.agents[name] || {};
    const sinceLast = nowMs - (st.lastActionAt || 0);
    const cooling = sinceLast < COOLDOWN_MS;
    const reWedge = cooling && verdict.action === 'restart';

    const line = {
      ts: new Date(nowMs).toISOString(), mode: MODE, agent: name,
      action: verdict.action, reason: verdict.reason, trace: verdict.trace,
      cooldownActive: cooling, reWedgeWithinCooldown: reWedge,
    };

    if (verdict.action === 'restart' && reWedge) {
      // 2nd wedge within the window => escalate, do NOT loop-restart.
      line.disposition = 'ESCALATE (re-wedge within cooldown — not a transient stall)';
      appendShadowLog(root, line);
      escalate(name, verdict, sinceLast);
      continue;
    }

    if (verdict.action === 'restart' && MODE === 'armed' && !cooling) {
      line.disposition = 'ARMED-RESTART';
      appendShadowLog(root, line);
      if (doRestart(name)) {
        state.agents[name] = { lastActionAt: nowMs, lastAction: 'restart' };
        acted.push(name);
      }
    } else {
      // shadow (or armed-but-cooling, or hold): observe only.
      line.disposition = MODE === 'shadow'
        ? (verdict.action === 'restart' ? 'WOULD-RESTART (shadow)' : 'WOULD-HOLD+ALARM (shadow)')
        : (cooling ? 'SUPPRESSED-cooldown' : 'HOLD+ALARM');
      appendShadowLog(root, line);
      if (verdict.action === 'restart' && MODE !== 'armed') {
        state.agents[name] = { lastActionAt: nowMs, lastAction: 'would-restart' };
      }
    }
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

function escalate(name, verdict, sinceLastMs) {
  if (!SAFE_NAME.test(name)) return;     // defense-in-depth
  try {
    execFileSync('cortextos', ['bus', 'send-message', 'platform-director', 'high',
      `[wedge-watchdog] ${name} RE-WEDGED ${Math.round(sinceLastMs / 60000)}m after last action — NOT auto-looping (not a transient stall). Manual investigation needed. Trace: ${JSON.stringify(verdict.trace).slice(0, 400)}`,
    ], { timeout: 15000 });
  } catch { /* best-effort */ }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('[wedge-watchdog] fatal:', err); process.exit(0); }); // never crash the cron
