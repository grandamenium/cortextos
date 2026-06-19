// wedge-watchdog-data.mjs — data layer for the wedge-watchdog cron-probe.
// Gathers live fleet state from disk + ps and exposes pure helpers (recordHbObservation,
// deriveIntervalFromHbObs, resolveInterval, applyTrust, median) that the data-layer test
// exercises. Keeps wedge-watchdog.mjs focused on control flow.

import { readFileSync, existsSync, readdirSync, statSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

export const COOLDOWN_MS = 30 * 60 * 1000;          // 1 action/agent/30min
export const MIN_HB_ADVANCES = 3;                   // N: trusted interval needs >=3 observed hb-advance gaps
export const HB_OBS_MAX = 13;                       // keep last 13 distinct hb values = 12 advance-gaps
export const BOOTSTRAP_PRIOR_MS = 5 * 60 * 1000;    // surfacing-only prior while untrusted (NON-load-bearing: bootstrap never auto-acts)
const INTERVAL_WINDOW = 12;                         // trailing advance-gaps used for the median
const SHADOW_LOG = 'state/wedge-watchdog-shadow.log';
const STATE_FILE = 'state/wedge-watchdog-state.json';
const MODE_FILE = 'state/wedge-watchdog.mode';      // mutable RUNTIME flag: off|shadow|armed
const VALID_MODES = new Set(['off', 'shadow', 'armed']);

/**
 * Read the mode at RUNTIME from a mutable state file (PD condition c): the arm-flip is ONE
 * logged file-write (echo armed > <root>/state/wedge-watchdog.mode), reversible, no launchctl
 * reload. Absent/invalid => 'off' (fail-safe). Env CTX_WEDGE_WATCHDOG overrides for tests only.
 */
export function readMode(root) {
  const env = (process.env.CTX_WEDGE_WATCHDOG || '').toLowerCase();
  if (VALID_MODES.has(env)) return env;
  try {
    const m = readFileSync(join(root, MODE_FILE), 'utf-8').trim().toLowerCase();
    return VALID_MODES.has(m) ? m : 'off';
  } catch { return 'off'; }
}

const LIVENESS_FILE = 'state/wedge-watchdog-last-fire';  // ISO ts; SA's cron-tick-freshness backstop reads this

/** Record this tick's fire (PD condition a, who-watches-the-watcher). The launchd job has no
 * agent context, so the reliable agent-independent record is a liveness TIMESTAMP file that
 * SA's backstop checks for freshness; also best-effort logs a bus event for fleet visibility.
 * Never throws. */
export function recordFire(root, intervalSec) {
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, LIVENESS_FILE), `${new Date().toISOString()} interval=${intervalSec}s\n`, 'utf-8');
  } catch { /* best-effort */ }
  try {
    execFileSync('cortextos', ['bus', 'log-event', 'action', 'wedge_watchdog_tick', 'info'], { timeout: 15000 });
  } catch { /* best-effort fleet-visibility */ }
}

export function ctxRoot() {
  return join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default');
}

export function listAgentNames(root) {
  const dir = join(root, 'state');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(dir, d.name, 'heartbeat.json')))
    .map(d => d.name);
}

// --- pure interval logic (runner-test target) -------------------------------

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Append the current last_heartbeat to the per-agent observed-advance ring — ONLY when it
 * ADVANCED to a new value (a real advance). The Gate-A threshold must derive from the cadence
 * last_heartbeat ACTUALLY advances (what Gate-A measures), NOT the heartbeat-CRON schedule:
 * a multi-cron agent advances hb on ANY of its crons, far faster than its nominal heartbeat-cron
 * interval. (2026-06-19 FN-class: heartbeat-cron-gaps gave improver 240min when its true advance
 * cadence was ~4min -> a 480min threshold would have false-negatived a genuinely-wedged improver.)
 * @returns {number[]} the new ring (last HB_OBS_MAX distinct hb values)
 */
export function recordHbObservation(hbObs, currentHbMs) {
  const arr = Array.isArray(hbObs) ? hbObs.slice() : [];
  if (currentHbMs > 0 && arr[arr.length - 1] !== currentHbMs) arr.push(currentHbMs);
  return arr.slice(-HB_OBS_MAX);
}

/**
 * Derive the interval from observed hb-ADVANCE gaps (diffs between consecutive distinct
 * last_heartbeat values). The live OPEN gap (the current frozen period) is NEVER a completed
 * advance, so a stalled agent cannot inflate it — and crons stopping during a wedge cannot
 * inflate it either (we measure hb advances, not cron fires). Cold-start (< MIN_HB_ADVANCES
 * advance-gaps) returns null => UNTRUSTED (the runner surfaces, never auto-acts).
 * @returns {{ms:number|null, source:string, nGaps:number}}
 */
export function deriveIntervalFromHbObs(hbObs) {
  const arr = Array.isArray(hbObs) ? hbObs : [];
  const gaps = [];
  for (let i = 1; i < arr.length; i++) gaps.push(arr[i] - arr[i - 1]);
  if (gaps.length >= MIN_HB_ADVANCES) {
    const recent = gaps.slice(-INTERVAL_WINDOW);
    return { ms: median(recent), source: 'hb-advance-median', nGaps: recent.length };
  }
  return { ms: null, source: 'insufficient-hb-advances (untrusted)', nGaps: gaps.length };
}

/**
 * Resolve the Gate-A interval + whether it is TRUSTED. Trusted = >= MIN_HB_ADVANCES observed
 * hb-advances (you cannot accumulate N advances without being alive, so this subsumes
 * proven-alive). Untrusted (bootstrap / just-restarted) falls back to the SHORT prior, which is
 * non-load-bearing for ACTIONS (the trust-gate downgrades any restart to a surface while
 * untrusted) but kept SHORT so a born-wedged agent SURFACES promptly.
 * @returns {{intervalMs:number, trusted:boolean, nGaps:number}}
 */
export function resolveInterval(hbObs, priorMs = BOOTSTRAP_PRIOR_MS) {
  const d = deriveIntervalFromHbObs(hbObs);
  return d.ms != null
    ? { intervalMs: d.ms, trusted: true, nGaps: d.nGaps }
    : { intervalMs: priorMs, trusted: false, nGaps: d.nGaps };
}

/**
 * Trust-gate: while the interval is UNTRUSTED (bootstrap / just-restarted, < N hb-advances), a
 * 'restart' verdict cannot be acted on — it is downgraded to a 'surface' so it ALERTS (prompt,
 * not silent) but NEVER auto-restarts on an untrusted interval. This is the restart-loop guard
 * BY CONSTRUCTION: a freshly-restarted agent has ~0 advances -> untrusted -> surface-only until
 * it re-accumulates N + proves alive. 'hold' and 'none' pass through unchanged. evaluateWedge
 * (the reviewed decision fn) is untouched — this is a thin RUNNER-level wrapper.
 */
export function applyTrust(verdict, trusted) {
  if (!trusted && verdict && verdict.action === 'restart') {
    return { ...verdict, action: 'surface', reason: `bootstrap: untrusted interval (< ${MIN_HB_ADVANCES} hb-advances) — SURFACE, do not auto-act. ${verdict.reason}` };
  }
  return verdict;
}

// --- runner-stateful decision helpers (PURE — deterministically tested with injected state+time;
//     the ps/disk I/O stays in the runner. These are the safety-critical guards.) ---------------

/**
 * Per-agent surface state-machine for one tick. `isSurfacing` = this tick's verdict is 'surface'
 * (untrusted would-be-restart). Returns the next {surfaceSince, surfaceEscalated} + this tick's
 * {surfacingForMs, escalateNow}. Behaviors (all the safety-critical surface guards in one pure fn):
 *  - NOT surfacing (recovered) -> CLEAR surfaceSince + surfaceEscalated (no stale state; a later
 *    genuine wedge re-surfaces cleanly, not pre-escalated);
 *  - first surface -> set surfaceSince = now (surfacingForMs = 0, no escalate yet);
 *  - persists past COOLDOWN_MS -> escalateNow = true ONCE; the surfaceEscalated latch prevents
 *    re-escalation (reuses COOLDOWN_MS — the SAME window/timer as the re-wedge escalation).
 */
export function tickSurfaceState(prev, isSurfacing, nowMs) {
  if (!isSurfacing) return { surfaceSince: undefined, surfaceEscalated: false, surfacingForMs: 0, escalateNow: false };
  const surfaceSince = prev.surfaceSince || nowMs;
  const surfacingForMs = nowMs - surfaceSince;
  const escalateNow = surfacingForMs >= COOLDOWN_MS && !prev.surfaceEscalated;
  return { surfaceSince, surfaceEscalated: prev.surfaceEscalated || escalateNow, surfacingForMs, escalateNow };
}

/**
 * Disposition for a TRUSTED 'restart' verdict given the cooldown window + mode:
 *  - re-wedge WITHIN cooldown -> ESCALATE, do NOT loop-restart (the persistent-wedge guard);
 *  - past cooldown + ARMED -> act (real restart);
 *  - past cooldown + SHADOW -> would-restart (shadow must NEVER act, even on a restart disposition).
 */
export function restartDisposition(lastActionAt, nowMs, mode) {
  const sinceLast = nowMs - (lastActionAt || 0);
  const cooling = sinceLast < COOLDOWN_MS;
  if (cooling) return { sinceLast, cooling, disposition: 'escalate', act: false, escalate: true };
  if (mode === 'armed') return { sinceLast, cooling, disposition: 'armed-restart', act: true, escalate: false };
  return { sinceLast, cooling, disposition: 'would-restart', act: false, escalate: false };
}

/**
 * A restart from ANY source (watchdog / daemon / self) is detected by a PID change -> reset hbObs
 * -> untrusted -> surface-only until N fresh advances. Makes the born-wedged guard CONSISTENT
 * across restart sources (not just watchdog-initiated). Pure.
 */
export function pidChangedReset(prevPid, curPid, hbObs) {
  if (prevPid && curPid && prevPid !== curPid) return { hbObs: [], restarted: true };
  return { hbObs: hbObs || [], restarted: false };
}

// --- per-agent state readers ------------------------------------------------

// ANY cron fire (not just heartbeat) — for the corroborator + Gate-C: a wedge stops ALL the
// agent's crons (firing-flag bug), so any-cron silence is the wedge signature; cron-advancing
// for OTHER agents proves the daemon is alive + firing for them.
function anyCronFireTimes(root, name) {
  const p = join(root, '.cortextOS', 'state', 'agents', name, 'cron-execution.log');
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line.includes('"status":"fired"')) continue;
    const m = line.match(/"ts":"([^"]+)"/);
    if (m) { const ms = Date.parse(m[1]); if (!Number.isNaN(ms)) out.push(ms); }
  }
  return out;
}

export function lastHeartbeatMs(root, name) {
  try {
    const hb = JSON.parse(readFileSync(join(root, 'state', name, 'heartbeat.json'), 'utf-8'));
    const ms = Date.parse(hb.last_heartbeat);
    return Number.isNaN(ms) ? 0 : ms;
  } catch { return 0; }
}

export function lastCronFireMs(root, name) {
  const t = anyCronFireTimes(root, name);
  return t.length ? Math.max(...t) : 0;
}

/** newest of {pty stdout.log mtime (live-stream/output), state-dir newest file mtime}. */
export function lastActivity(root, name) {
  let best = 0, source = 'none';
  const consider = (ms, src) => { if (ms > best) { best = ms; source = src; } };
  try {
    const log = join(root, 'logs', name, 'stdout.log');
    if (existsSync(log)) consider(statSync(log).mtimeMs, 'stdout.log');
  } catch { /* skip */ }
  try {
    const sd = join(root, 'state', name);
    for (const f of readdirSync(sd)) {
      try { consider(statSync(join(sd, f)).mtimeMs, `state/${f}`); } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return { ms: best, source };
}

/**
 * One ps snapshot -> per-agent { ptyAlive, treeCpuPct } (CPU rolled up over pty.pid +
 * ALL descendants). Reads each agent's pty.pid JSON for its leader pid.
 */
export function ptyInfo(root, names) {
  // pid -> {ppid, cpu}
  const procs = new Map();
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu='], { encoding: 'utf-8', timeout: 10000 });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)$/);
      if (m) procs.set(+m[1], { ppid: +m[2], cpu: parseFloat(m[3]) });
    }
  } catch { /* ps failed — everyone reads not-alive, safe (Gate-B none) */ }
  // children index
  const children = new Map();
  for (const [pid, { ppid }] of procs) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const treeCpu = (pid) => {
    let sum = 0; const stack = [pid];
    const seen = new Set();
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p)) continue; seen.add(p);
      const rec = procs.get(p);
      if (rec) { sum += rec.cpu; for (const c of (children.get(p) || [])) stack.push(c); }
    }
    return sum;
  };
  const res = {};
  for (const name of names) {
    let pid = 0, enabled = true, hermes = false;
    try {
      const pf = JSON.parse(readFileSync(join(root, 'state', name, 'pty.pid'), 'utf-8'));
      pid = pf.pid || 0;
    } catch { /* no pid file */ }
    res[name] = {
      pid,                                       // for PID-change restart detection (any-source born-wedged guard)
      ptyAlive: pid > 0 && procs.has(pid),
      treeCpuPct: pid > 0 && procs.has(pid) ? treeCpu(pid) : 0,
      enabled, hermes,
    };
  }
  return res;
}

// --- logging / state --------------------------------------------------------

export function appendShadowLog(root, line) {
  try {
    const p = join(root, SHADOW_LOG);
    mkdirSync(join(root, 'state'), { recursive: true });
    appendFileSync(p, JSON.stringify(line) + '\n', 'utf-8');
  } catch { /* observational — never throw */ }
}

export function loadState(root) {
  try { return JSON.parse(readFileSync(join(root, STATE_FILE), 'utf-8')); }
  catch { return { agents: {} }; }
}

export function saveState(root, state) {
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}
