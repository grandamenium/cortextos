/**
 * recovery-watchdog.ts — the single agent-recovery authority for the daemon.
 *
 * ONE timer (a periodic fleet sweep), ONE circuit-breaker registry, ONE
 * `recover()` chokepoint. New recovery reasons register as `RecoveryTrigger`
 * extension points feeding the SAME chokepoint — never their own timer or
 * restart path — so single-authority is architectural, not convention.
 *
 * Two triggers ship here:
 *   - FrozenContentTrigger — NET-NEW content-freshness detection for MAPPED,
 *     pid-alive agents. It does NOT consume computeDormancy/`d.dormant`: the
 *     fast-checker writes its own ~50min idle beat in the daemon, keeping
 *     `last_heartbeat` fresh even when the agent brain is wedged, so timestamp
 *     dormancy is blind to a mapped wedge (see C1). Frozen content is also the
 *     STANDING state of a healthy idle agent (C2), so this trigger deliberately
 *     over-flags and the liveness discriminator in `recover()` is the ONLY thing
 *     preventing mass false-restart.
 *   - AbsentAgentTrigger — reuses computeDormancy Face B (enabled agents absent
 *     from the mapped set) to START never-spawned / dropped-from-map agents.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * COVERAGE BOUNDARY — READ THIS. A hung-but-ALIVE claude REPL (a wedged claude
 * brain whose OS process still sleeps normally, state 'S'/'I') is OUT OF SCOPE.
 * The fail-safe discriminator cannot distinguish it from a healthy idle REPL and
 * will VETO (UNCERTAIN), which is correct — guessing there would mass-restart
 * healthy idle agents. That single case is backstopped by human operators and
 * the next sweep. A dedicated claude-REPL-wedge signal (e.g. a PTY stuck-banner
 * probe) is possible future work and is NOT implemented here. The watchdog also
 * announces this boundary in a startup log line so the gap is loud, never
 * silent.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * All numeric constants below are review-tunable proposals, NOT final.
 */

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Heartbeat } from '../types/index.js';
import { BOOT_GRACE_MS } from '../utils/dormancy.js';
import { normalizeHeartbeatContent, contentDiffers } from '../utils/heartbeat-content.js';

type LogFn = (msg: string) => void;

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/** Fleet sweep cadence. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/**
 * A MAPPED agent whose normalized heartbeat content has not changed for at
 * least this long (and is past boot grace) is a frozen-content candidate. The
 * discriminator then decides whether it is actually wedged.
 */
export const RECOVERY_FREEZE_MS = 30 * 60 * 1000; // 30 min

/**
 * Cross-watchdog cooldown: skip an agent whose `.restart-planned` marker was
 * touched within this window (a context/hard/self restart is already in flight —
 * do not fight fast-checker.forceContextRestart or a manual restart).
 */
export const RESTART_COOLDOWN_MS = 15 * 60 * 1000; // 15 min

/** Circuit-breaker sliding window. Mirrors fast-checker's 15-min window. */
export const CIRCUIT_WINDOW_MS = 15 * 60 * 1000; // 15 min

/**
 * Max recoveries allowed inside CIRCUIT_WINDOW_MS before the breaker trips. With
 * MAX=2 the 1st and 2nd recoveries proceed and the 3rd trips (2 ok / 3rd trips).
 *
 * NOTE (flagged): the plan headline says "3/15min, mirror fast-checker", but the
 * plan's own test spec says "2 ok / 3rd trips" and fast-checker actually allows
 * 3 (the 4th trips). These disagree. This follows the explicit test spec; the
 * value is a single named constant so it is trivial to retune.
 */
export const CIRCUIT_MAX_RESTARTS = 2;

/** How long the breaker stays tripped once it fires. */
export const CIRCUIT_PAUSE_MS = 30 * 60 * 1000; // 30 min

const CIRCUIT_FILENAME = '.recovery-circuit.json';
const RESTART_PLANNED_FILENAME = '.restart-planned';

/** Exact loud startup line (ruling 2a). Also mirrored in the module docstring. */
export const COVERAGE_BOUNDARY_LINE =
  '[recovery-watchdog] started. COVERAGE BOUNDARY: a hung-but-alive claude REPL ' +
  '(a wedged claude brain whose OS process still sleeps normally) is OUT OF SCOPE — ' +
  'the fail-safe discriminator cannot distinguish it from a healthy idle REPL and will ' +
  'VETO. That case is backstopped by human operators and the next sweep.';

// ---------------------------------------------------------------------------
// Liveness discriminator (VETO-first, fail-SAFE) — pure classifiers
// ---------------------------------------------------------------------------

/** Only WEDGED is ever restarted. Any uncertainty or error resolves to VETO. */
export type LivenessVerdict = 'WEDGED' | 'ALIVE_IDLE' | 'UNCERTAIN';

/** Raw signals surfaced by CodexAppServerPTY.probeLiveness() + a pid-liveness probe. */
export interface CodexLivenessSignals {
  socketAlive: boolean;
  pid: number | null;
  pidAlive: boolean;
  turnInFlight: boolean;
}

/** Raw signals surfaced by AgentPTY.probeLiveness() (claude/hermes/opencode). */
export interface ProcStateSignals {
  pid: number | null;
  pidAlive: boolean;
  procState: string | null; // `ps -o stat=` output, or null when unavailable
}

/**
 * codex-app-server discriminator. WEDGED only on a positive dead signal (socket
 * down, or the app-server child pid gone). An idle server (socket up, pid alive,
 * no turn in flight) is ALIVE_IDLE and MUST be vetoed — this is the exact
 * motivating case (multiple alive-idle Codex servers flagged at once). A turn in
 * flight means it is actively working ⇒ UNCERTAIN ⇒ veto.
 */
export function classifyCodexLiveness(s: CodexLivenessSignals): LivenessVerdict {
  if (s.socketAlive === false) return 'WEDGED';
  if (s.pid == null || s.pidAlive === false) return 'WEDGED';
  if (s.socketAlive && s.pidAlive && s.turnInFlight === false) return 'ALIVE_IDLE';
  return 'UNCERTAIN';
}

/**
 * Coarse `ps -o stat=` discriminator for claude/hermes/opencode. A sleeping REPL
 * and a wedged-but-alive REPL are OS-indistinguishable, so every live-process
 * state fails SAFE to UNCERTAIN. Only an unambiguous dead state is WEDGED:
 *   - pid confirmed gone (ESRCH) ⇒ WEDGED
 *   - Z (zombie) / X (dead) ⇒ WEDGED
 *   - S/I/R/D/T (any live state) ⇒ UNCERTAIN (veto)
 *   - no pid, or ps missing / unparseable ⇒ UNCERTAIN (veto)
 */
export function classifyProcStateLiveness(s: ProcStateSignals): LivenessVerdict {
  if (s.pid == null) return 'UNCERTAIN';
  if (s.pidAlive === false) return 'WEDGED'; // confirmed gone
  const st = (s.procState ?? '').trim();
  if (st === '') return 'UNCERTAIN'; // ps missing / parse-fail
  const head = st[0].toUpperCase();
  if (head === 'Z' || head === 'X') return 'WEDGED';
  if (head === 'S' || head === 'I' || head === 'R' || head === 'D' || head === 'T') return 'UNCERTAIN';
  return 'UNCERTAIN'; // unknown code — fail safe
}

// ---------------------------------------------------------------------------
// Manager surface + trigger extension point
// ---------------------------------------------------------------------------

/** One MAPPED agent's snapshot for the frozen-content trigger. */
export interface MappedAgentSnapshot {
  name: string;
  org?: string;
  enabled: boolean;
  /** Agent process uptime in ms; null when not running / no session. */
  uptimeMs: number | null;
  heartbeat: Partial<Heartbeat> | null;
}

/**
 * The narrow slice of AgentManager the watchdog depends on. Kept as an interface
 * so the watchdog has no import back-edge to agent-manager and is unit-testable
 * with a fake manager.
 */
export interface RecoveryManager {
  /** Snapshot of every mapped agent for content-freshness detection. */
  getMappedContentSnapshot(nowMs: number): MappedAgentSnapshot[];
  /** Face-B dormant agents (enabled but absent from the map) to start. */
  getAbsentDormantAgents(nowMs: number): Array<{ name: string; org?: string }>;
  /** Secondary-liveness verdict for a mapped agent. */
  probeAgentLiveness(name: string): LivenessVerdict;
  /** Force-fresh restart: writes .force-fresh + .restart-planned, then restarts. */
  forceFreshRestart(name: string, reason: string): Promise<void>;
  /** Start an enabled-but-absent agent fresh. */
  startAbsent(name: string): Promise<void>;
  /** state/<agent> dir — used for the circuit file and the .restart-planned probe. */
  stateDirFor(name: string): string;
}

export interface RecoveryContext {
  nowMs: number;
}

export type RecoveryAction = 'force-fresh-restart' | 'start-absent';

export interface RecoveryCandidate {
  agent: string;
  org?: string;
  action: RecoveryAction;
  reason: string;
}

/** Extension point: a recovery reason. Registers into the ONE recover() chokepoint. */
export interface RecoveryTrigger {
  readonly name: string;
  evaluate(ctx: RecoveryContext): RecoveryCandidate[];
}

// ---------------------------------------------------------------------------
// Trigger: frozen mapped content (net-new)
// ---------------------------------------------------------------------------

interface FreezeState {
  content: string; // normalized content first seen at `since`
  since: number;   // nowMs when this content was first observed unchanged
}

/**
 * Flags a mapped agent whose normalized heartbeat content has been frozen for at
 * least RECOVERY_FREEZE_MS. Genuinely fresh content (per `contentDiffers`) resets
 * the freeze — that is the recovery-verification use of the content gate.
 */
export class FrozenContentTrigger implements RecoveryTrigger {
  readonly name = 'frozen-content';
  private states = new Map<string, FreezeState>();

  constructor(private mgr: RecoveryManager) {}

  evaluate(ctx: RecoveryContext): RecoveryCandidate[] {
    const now = ctx.nowMs;
    const out: RecoveryCandidate[] = [];
    const snapshot = this.mgr.getMappedContentSnapshot(now);
    const live = new Set<string>();

    for (const a of snapshot) {
      // Only enabled, running agents past boot grace are eligible. A fresh /
      // stopped / starting agent has no uptime past grace and is skipped — the
      // Face-A bounce guard, reused from dormancy's BOOT_GRACE_MS.
      if (!a.enabled) continue;
      if (a.uptimeMs == null || a.uptimeMs < BOOT_GRACE_MS) continue;
      live.add(a.name);

      const content = normalizeHeartbeatContent(a.heartbeat);
      const prev = this.states.get(a.name);

      if (!prev) {
        this.states.set(a.name, { content, since: now });
        continue;
      }
      if (contentDiffers(content, prev.content)) {
        // Genuinely fresh content ⇒ healthy / recovered. Reset the freeze.
        this.states.set(a.name, { content, since: now });
        continue;
      }
      // Content did not change (identical, or collapsed to WATCHDOG_IDLE).
      if (now - prev.since >= RECOVERY_FREEZE_MS) {
        out.push({
          agent: a.name,
          org: a.org,
          action: 'force-fresh-restart',
          reason: `frozen heartbeat content for ${Math.round((now - prev.since) / 60000)}m (mapped wedge candidate)`,
        });
      }
    }

    // Drop state for agents no longer mapped/eligible so it cannot go stale.
    for (const name of [...this.states.keys()]) {
      if (!live.has(name)) this.states.delete(name);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Trigger: absent enabled agent (reuses computeDormancy Face B)
// ---------------------------------------------------------------------------

export class AbsentAgentTrigger implements RecoveryTrigger {
  readonly name = 'absent-agent';

  constructor(private mgr: RecoveryManager) {}

  evaluate(ctx: RecoveryContext): RecoveryCandidate[] {
    return this.mgr.getAbsentDormantAgents(ctx.nowMs).map(({ name, org }) => ({
      agent: name,
      org,
      action: 'start-absent' as const,
      reason: 'silent dormancy: enabled agent absent from map (Face B)',
    }));
  }
}

// ---------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------

interface CircuitState {
  restarts: number[];
  brokenAt: number | null;
}

export class RecoveryWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private triggers: RecoveryTrigger[];

  constructor(
    private mgr: RecoveryManager,
    private log: LogFn = (m) => console.log(m),
  ) {
    this.triggers = [new FrozenContentTrigger(mgr), new AbsentAgentTrigger(mgr)];
  }

  /** Start the single fleet-sweep timer. Idempotent. Emits the loud boundary line. */
  start(): void {
    // Loud coverage boundary (ruling 2a) — announced every start so the
    // claude-REPL-wedge gap is never silent.
    this.log(COVERAGE_BOUNDARY_LINE);
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    // Never keep the daemon event loop alive on the watchdog alone.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One fleet sweep. Guarded so a slow sweep never overlaps itself. */
  async sweep(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = Date.now();
      const seen = new Set<string>();
      for (const trig of this.triggers) {
        let candidates: RecoveryCandidate[] = [];
        try {
          candidates = trig.evaluate({ nowMs: now });
        } catch (err) {
          this.log(`[recovery-watchdog] trigger ${trig.name} failed: ${err}`);
          continue;
        }
        for (const c of candidates) {
          try {
            await this.recover(c, now, seen);
          } catch (err) {
            this.log(`[recovery-watchdog] recover(${c.agent}) failed: ${err}`);
          }
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * The single recovery chokepoint. Order (each a hard gate):
   *   1. single-sweep dedup — one action per agent per sweep
   *   2. cross-watchdog cooldown — skip if .restart-planned is recent
   *   3. circuit breaker — CIRCUIT_MAX_RESTARTS per CIRCUIT_WINDOW_MS, pause
   *   4. discriminator VETO — force-fresh only proceeds on a WEDGED verdict
   *   5. action
   * `now` and `seen` are injected so this is deterministic in tests.
   */
  async recover(candidate: RecoveryCandidate, now: number, seen: Set<string>): Promise<void> {
    const { agent, action, reason } = candidate;

    // (1) single-sweep dedup
    if (seen.has(agent)) return;
    seen.add(agent);

    // (2) cross-watchdog cooldown
    if (this.recentRestartPlanned(agent, now)) {
      this.log(`[recovery-watchdog] ${agent}: skip — .restart-planned within cooldown`);
      return;
    }

    // (3) circuit breaker
    if (!this.circuitAllows(agent, now)) {
      this.log(`[recovery-watchdog] ${agent}: skip — circuit breaker tripped/paused`);
      return;
    }

    // (4) discriminator VETO (force-fresh only; an absent agent has no process to probe)
    if (action === 'force-fresh-restart') {
      const verdict = this.mgr.probeAgentLiveness(agent);
      if (verdict !== 'WEDGED') {
        this.log(`[recovery-watchdog] ${agent}: VETO — liveness verdict ${verdict} (not WEDGED)`);
        return;
      }
    }

    // (5) action
    this.recordCircuit(agent, now);
    if (action === 'force-fresh-restart') {
      this.log(`[recovery-watchdog] ${agent}: force-fresh restart — ${reason}`);
      await this.mgr.forceFreshRestart(agent, `RECOVERY-WATCHDOG: ${reason}`);
    } else {
      this.log(`[recovery-watchdog] ${agent}: start-absent — ${reason}`);
      await this.mgr.startAbsent(agent);
    }
  }

  // --- cross-watchdog cooldown ---

  private recentRestartPlanned(agent: string, now: number): boolean {
    const p = join(this.mgr.stateDirFor(agent), RESTART_PLANNED_FILENAME);
    try {
      if (!existsSync(p)) return false;
      return now - statSync(p).mtimeMs < RESTART_COOLDOWN_MS;
    } catch {
      return false; // unreadable — do not block recovery on it
    }
  }

  // --- circuit breaker (mirrors fast-checker ctxCircuitRestarts, persisted) ---

  private circuitFile(agent: string): string {
    return join(this.mgr.stateDirFor(agent), CIRCUIT_FILENAME);
  }

  private loadCircuit(agent: string): CircuitState {
    try {
      const raw = JSON.parse(readFileSync(this.circuitFile(agent), 'utf-8'));
      return {
        restarts: Array.isArray(raw.restarts) ? raw.restarts : [],
        brokenAt: typeof raw.brokenAt === 'number' ? raw.brokenAt : null,
      };
    } catch {
      return { restarts: [], brokenAt: null };
    }
  }

  private saveCircuit(agent: string, c: CircuitState): void {
    try {
      const dir = this.mgr.stateDirFor(agent);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.circuitFile(agent), JSON.stringify(c), 'utf-8');
    } catch {
      // Non-critical — an unpersisted breaker still works within a sweep.
    }
  }

  /**
   * True if a recovery is permitted now. Filters the window, honors an active
   * pause, and trips (returns false) when the window is already at capacity.
   * Does NOT record the restart — recordCircuit() does that only on a real action.
   */
  private circuitAllows(agent: string, now: number): boolean {
    const c = this.loadCircuit(agent);
    if (c.brokenAt != null) {
      if (now - c.brokenAt < CIRCUIT_PAUSE_MS) return false; // still paused
      c.brokenAt = null; // pause expired — reset
      c.restarts = [];
    }
    c.restarts = c.restarts.filter((t) => now - t < CIRCUIT_WINDOW_MS);
    if (c.restarts.length >= CIRCUIT_MAX_RESTARTS) {
      c.brokenAt = now;
      this.saveCircuit(agent, c);
      this.log(`[recovery-watchdog] ${agent}: circuit breaker TRIPPED (${c.restarts.length} in ${Math.round(CIRCUIT_WINDOW_MS / 60000)}min) — paused ${Math.round(CIRCUIT_PAUSE_MS / 60000)}min`);
      return false;
    }
    this.saveCircuit(agent, c); // persist the filtered window / cleared pause
    return true;
  }

  private recordCircuit(agent: string, now: number): void {
    const c = this.loadCircuit(agent);
    c.restarts = c.restarts.filter((t) => now - t < CIRCUIT_WINDOW_MS);
    c.restarts.push(now);
    this.saveCircuit(agent, c);
  }
}
