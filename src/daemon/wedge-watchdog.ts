/**
 * wedge-watchdog.ts — Daemon-side wedge-watchdog (SYS-WEDGE-AUTORESTART).
 *
 * Detects "wedged" agents: cron fired, heartbeat frozen, but PTY is alive
 * at ~0% CPU. This is distinct from the StaleAgentWatchdog (which handles
 * the simpler "heartbeat stale for 15+ min" case without requiring a cron
 * fire or PTY CPU check).
 *
 * TRIPLE-GATE:
 *   Gate-1: A cron fired for this agent within CRON_FIRE_LOOKBACK_MS
 *           (evidence the daemon sent work the agent hasn't processed)
 *   Gate-2: Heartbeat frozen >= HB_FREEZE_MIN_INTERVALS loop-intervals
 *           (agent's own timer isn't ticking)
 *   Gate-3: PTY process alive but CPU < CPU_IDLE_THRESHOLD_PCT
 *           (process exists but is doing nothing — not a network hang)
 *
 * MODES:
 *   SHADOW (default): logs "WOULD have restarted" without acting.
 *     Accumulate shadow-log false-positive count, then PD decides to arm.
 *   ARMED (CTX_WEDGE_WATCHDOG_ARMED=1): actually restarts the agent.
 *
 * RAILS:
 *   - Credit-refutation HOLD: if < 1 OTHER agent is fresh, all-stale
 *     indicates a quota outage, not a wedge. Hold + alarm.
 *   - PD carve-out: platform-director is always blocked in the current
 *     build — PD needs a manual arm-flip once shadow FP-count is zero.
 *   - Cooldown: 30 min between restarts per agent. On a 2nd wedge within
 *     the cooldown window, log ESCALATE instead.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { AgentManager } from './agent-manager.js';
import { readAllHeartbeats, isHeartbeatStale } from '../bus/heartbeat.js';
import { cronExecutionLogPathFor } from '../bus/crons-schema.js';
import { agentPidFilePath } from './agent-pid-file.js';
import type { AgentPidRecord } from './agent-pid-file.js';
import { parseDurationMs } from '../bus/cron-state.js';
import { ensureDir } from '../utils/atomic.js';
import type { BusPaths, CronExecutionLogEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the watchdog checks each running agent. */
const WEDGE_CHECK_INTERVAL_MS = 2 * 60 * 1000;

/** Lookback window for Gate-1: a cron fire within this window triggers the gate. */
const CRON_FIRE_LOOKBACK_MS = 35 * 60 * 1000;

/** Gate-2: heartbeat must be frozen for at least this many loop-intervals. */
const HB_FREEZE_MIN_INTERVALS = 2;

/** Gate-3: PTY CPU usage below this threshold is considered "idle / wedged". */
const CPU_IDLE_THRESHOLD_PCT = 5;

/** Minimum time between restarts per agent in ARMED mode. 2nd wedge → escalate. */
const WEDGE_COOLDOWN_MS = 30 * 60 * 1000;

/** Minimum age of a fresh heartbeat for the credit-refutation check. */
const FRESH_HB_THRESHOLD_MS = 15 * 60 * 1000;

/** Shadow-log spam throttle: at most one log per agent per this window. */
const SHADOW_LOG_THROTTLE_MS = 10 * 60 * 1000;

/** The orchestrator agent has a PD carve-out: always blocked until manually armed. */
const PD_ORCHESTRATOR_NAME = 'platform-director';

// ---------------------------------------------------------------------------
// Arm-flag helper (exported so daemon/index.ts can log it)
// ---------------------------------------------------------------------------

export function wedgeWatchdogArmed(): boolean {
  return process.env.CTX_WEDGE_WATCHDOG_ARMED === '1';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GateDetails {
  cronFiredAt?: string;
  hbAgeMs?: number;
  loopIntervalMs?: number;
  ptyCpuPct?: number;
  ptyPid?: number;
}

interface TripleGateResult {
  gate1_cronFired: boolean;
  gate2_hbFrozen: boolean;
  gate3_ptyCpuIdle: boolean;
  allPassed: boolean;
  details: GateDetails;
}

// ---------------------------------------------------------------------------
// WedgeWatchdog
// ---------------------------------------------------------------------------

export class WedgeWatchdog {
  private agentManager: AgentManager;
  private ctxRoot: string;
  private checkIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private restartingSet: Set<string> = new Set();
  /** Epoch-ms of last successful restart per agent (ARMED mode). */
  private lastRestartAt: Map<string, number> = new Map();
  /** Epoch-ms of last log emission per key (shadow throttle + credit-hold throttle). */
  private lastLogAt: Map<string, number> = new Map();

  constructor(
    agentManager: AgentManager,
    ctxRoot: string,
    options?: { checkIntervalMs?: number },
  ) {
    this.agentManager = agentManager;
    this.ctxRoot = ctxRoot;
    this.checkIntervalMs = options?.checkIntervalMs ?? WEDGE_CHECK_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    const mode = wedgeWatchdogArmed() ? 'ARMED' : 'SHADOW (default-off)';
    console.log(
      `[wedge-watchdog] Started (${mode}, check every ${this.checkIntervalMs / 60000}m, ` +
      `cron-lookback ${CRON_FIRE_LOOKBACK_MS / 60000}m, cooldown ${WEDGE_COOLDOWN_MS / 60000}m)`,
    );
    this.timer = setInterval(() => {
      this.checkAll().catch((err: Error) => {
        console.error(`[wedge-watchdog] Check error: ${err.message}`);
      });
    }, this.checkIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[wedge-watchdog] Stopped');
    }
  }

  async checkAll(): Promise<void> {
    const statuses = this.agentManager.getAllStatuses();
    const paths = { ctxRoot: this.ctxRoot } as BusPaths;
    const heartbeats = readAllHeartbeats(paths);
    const hbMap = new Map(heartbeats.map(hb => [hb.agent, hb]));

    // Credit-refutation: total fresh agents across the fleet
    const freshCount = heartbeats.filter(hb => !isHeartbeatStale(hb, FRESH_HB_THRESHOLD_MS)).length;

    for (const status of statuses) {
      const { name } = status;

      if (status.status !== 'running') continue;
      if (this.restartingSet.has(name)) continue;

      const hb = hbMap.get(name);
      if (!hb) continue;

      const gate = this.evaluateTripleGate(name, hb);
      if (!gate.allPassed) continue;

      const now = Date.now();

      // --- Rail: cooldown / escalate ---
      const lastRestart = this.lastRestartAt.get(name) ?? 0;
      if (now - lastRestart < WEDGE_COOLDOWN_MS) {
        // Second wedge within cooldown window — escalate, don't restart again
        this.emitShadow(name, gate, 'COOLDOWN_ESCALATE');
        continue;
      }

      // --- Rail: credit-refutation ---
      // If this agent is fresh, subtract it from the fresh count to get "other fresh".
      // If all agents are stale, we can't distinguish a wedge from a quota outage.
      const thisAgentFresh = !isHeartbeatStale(hb, FRESH_HB_THRESHOLD_MS);
      const otherFresh = freshCount - (thisAgentFresh ? 1 : 0);
      if (otherFresh < 1) {
        const throttleKey = `credit-${name}`;
        const lastLog = this.lastLogAt.get(throttleKey) ?? 0;
        if (now - lastLog > 30 * 60 * 1000) {
          console.log(
            `[wedge-watchdog] ${name} triple-gate matched — ` +
            `CREDIT_REFUTATION HOLD: no other fresh agent (possible quota outage). ` +
            `hb_age=${Math.round((gate.details.hbAgeMs ?? 0) / 60000)}m ` +
            `cpu=${gate.details.ptyCpuPct?.toFixed(1) ?? '?'}%`,
          );
          this.appendWedgeLog(name, 'CREDIT_HOLD', gate);
          this.lastLogAt.set(throttleKey, now);
        }
        continue;
      }

      // --- Rail: PD orchestrator carve-out ---
      if (name === PD_ORCHESTRATOR_NAME) {
        this.emitShadow(name, gate, 'PD_CARVEOUT');
        continue;
      }

      // --- All rails passed ---
      if (!wedgeWatchdogArmed()) {
        this.emitShadow(name, gate, 'PERMITTED_HELD');
      } else {
        await this.doRestart(name, gate);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Triple-gate evaluation
  // ---------------------------------------------------------------------------

  private evaluateTripleGate(
    agentName: string,
    hb: { last_heartbeat: string; loop_interval: string },
  ): TripleGateResult {
    const details: GateDetails = {};
    const gate1 = this.checkCronFired(agentName, details);
    const gate2 = this.checkHbFrozen(hb, details);
    const gate3 = this.checkPtyCpuIdle(agentName, details);
    return {
      gate1_cronFired: gate1,
      gate2_hbFrozen: gate2,
      gate3_ptyCpuIdle: gate3,
      allPassed: gate1 && gate2 && gate3,
      details,
    };
  }

  /** Gate-1: a cron fired for this agent within CRON_FIRE_LOOKBACK_MS. */
  private checkCronFired(agentName: string, details: GateDetails): boolean {
    const logPath = join(this.ctxRoot, cronExecutionLogPathFor(agentName));
    if (!existsSync(logPath)) return false;
    try {
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      const cutoffMs = Date.now() - CRON_FIRE_LOOKBACK_MS;
      // Lines are oldest→newest; scan newest-first for efficiency
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry: CronExecutionLogEntry;
        try {
          entry = JSON.parse(line) as CronExecutionLogEntry;
        } catch {
          continue;
        }
        if (entry.status !== 'fired') continue;
        const ts = new Date(entry.ts).getTime();
        if (ts < cutoffMs) break; // older than cutoff; all preceding entries are too
        details.cronFiredAt = entry.ts;
        return true;
      }
    } catch { /* unreadable — treat as not fired */ }
    return false;
  }

  /** Gate-2: heartbeat frozen for >= HB_FREEZE_MIN_INTERVALS loop-intervals. */
  private checkHbFrozen(
    hb: { last_heartbeat: string; loop_interval: string },
    details: GateDetails,
  ): boolean {
    const loopIntervalMs = parseDurationMs(hb.loop_interval);
    if (isNaN(loopIntervalMs) || loopIntervalMs <= 0) return false;
    const hbAgeMs = Date.now() - new Date(hb.last_heartbeat).getTime();
    details.hbAgeMs = hbAgeMs;
    details.loopIntervalMs = loopIntervalMs;
    return hbAgeMs >= HB_FREEZE_MIN_INTERVALS * loopIntervalMs;
  }

  /** Gate-3: PTY process exists (per pty.pid) but CPU < CPU_IDLE_THRESHOLD_PCT. */
  private checkPtyCpuIdle(agentName: string, details: GateDetails): boolean {
    const pidPath = agentPidFilePath(this.ctxRoot, agentName);
    if (!existsSync(pidPath)) return false;
    let pid: number;
    try {
      const rec = JSON.parse(readFileSync(pidPath, 'utf-8')) as AgentPidRecord;
      pid = rec.pid;
      if (!pid || pid <= 0) return false;
    } catch {
      return false;
    }
    details.ptyPid = pid;

    // Verify the process is alive (kill -0 throws if not)
    try {
      process.kill(pid, 0);
    } catch {
      return false; // process gone
    }

    // Measure CPU with ps
    try {
      const cpuStr = execFileSync('ps', ['-o', '%cpu=', '-p', String(pid)], {
        timeout: 3000,
        encoding: 'utf-8',
      }).trim();
      const cpuPct = parseFloat(cpuStr);
      if (isNaN(cpuPct)) return false;
      details.ptyCpuPct = cpuPct;
      return cpuPct < CPU_IDLE_THRESHOLD_PCT;
    } catch {
      return false; // ps failed or process disappeared
    }
  }

  // ---------------------------------------------------------------------------
  // Action helpers
  // ---------------------------------------------------------------------------

  private emitShadow(agentName: string, gate: TripleGateResult, reason: string): void {
    const now = Date.now();
    const lastLog = this.lastLogAt.get(agentName) ?? 0;
    if (now - lastLog < SHADOW_LOG_THROTTLE_MS) return;
    const hbAgeMin = Math.round((gate.details.hbAgeMs ?? 0) / 60000);
    console.log(
      `[wedge-watchdog] SHADOW: WOULD have restarted ${agentName} — ` +
      `triple-gate matched, rail=${reason}. ` +
      `cron_at=${gate.details.cronFiredAt ?? 'n/a'} ` +
      `hb_age=${hbAgeMin}m ` +
      `cpu=${gate.details.ptyCpuPct?.toFixed(1) ?? 'n/a'}% ` +
      `pid=${gate.details.ptyPid ?? 'n/a'}`,
    );
    this.appendWedgeLog(agentName, `SHADOW_${reason}`, gate);
    this.lastLogAt.set(agentName, now);
  }

  private async doRestart(agentName: string, gate: TripleGateResult): Promise<void> {
    const hbAgeMin = Math.round((gate.details.hbAgeMs ?? 0) / 60000);
    console.log(
      `[wedge-watchdog] ARMED: restarting ${agentName} (wedge detected). ` +
      `hb_frozen=${hbAgeMin}m cpu=${gate.details.ptyCpuPct?.toFixed(1) ?? 'n/a'}% ` +
      `pid=${gate.details.ptyPid ?? 'n/a'}`,
    );
    this.appendWedgeLog(agentName, 'ARMED_RESTART', gate);
    this.restartingSet.add(agentName);
    this.lastRestartAt.set(agentName, Date.now());
    try {
      await this.agentManager.restartAgent(agentName);
      console.log(`[wedge-watchdog] ${agentName} restart complete`);
    } catch (err) {
      console.error(`[wedge-watchdog] ${agentName} restart failed: ${(err as Error).message}`);
    } finally {
      this.restartingSet.delete(agentName);
    }
  }

  /** Append a JSONL entry to the agent's wedge-watchdog.log for audit + FP tracking. */
  private appendWedgeLog(agentName: string, kind: string, gate: TripleGateResult): void {
    try {
      const logDir = join(this.ctxRoot, 'logs', agentName);
      ensureDir(logDir);
      const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const entry = {
        ts, kind,
        gate1: gate.gate1_cronFired,
        gate2: gate.gate2_hbFrozen,
        gate3: gate.gate3_ptyCpuIdle,
        ...gate.details,
      };
      appendFileSync(join(logDir, 'wedge-watchdog.log'), JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* never break the check loop */ }
  }
}
