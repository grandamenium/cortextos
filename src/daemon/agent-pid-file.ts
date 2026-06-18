// SYS-DAEMON-RESILIENCE-01 Fix 2: per-agent PTY pid-file persistence + orphan
// reconcile classification.
//
// WHY: on a daemon CRASH-exit (uncaughtException -> process.exit(1)) there is no
// graceful stopAll(); a SIGHUP-handling agent PTY (real `claude`) orphan-survives
// (reparented to PID 1) while the new daemon rebuilds its in-memory registry
// EMPTY. With no persisted PID the new daemon cannot detect those orphans, so it
// never re-wires their crons and `inject` cannot reach them. We persist the PTY
// PID to `ctxRoot/state/<name>/pty.pid` at spawn and clear it on clean stop, so a
// fresh daemon's reconcileOrphans() can find + reap survivors before re-spawning.
//
// INSTANCE-SCOPING BY CONSTRUCTION: pid-files live under THIS instance's ctxRoot,
// so reconcile reads only its own — a foreign cortextOS instance's PTYs are
// structurally invisible. The instanceId is also recorded in the file as a
// belt-and-suspenders check before any signal is sent.

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';

export interface AgentPidRecord {
  instanceId: string;
  agent: string;
  pid: number;
  spawnedAt: string;
}

export function agentStateDir(ctxRoot: string, agent: string): string {
  return join(ctxRoot, 'state', agent);
}

export function agentPidFilePath(ctxRoot: string, agent: string): string {
  return join(agentStateDir(ctxRoot, agent), 'pty.pid');
}

/** Write the pid-file atomically (tmp + rename). Called synchronously the instant
 *  the PTY PID is available, so any subsequent crash leaves an accurate record. */
export function writeAgentPidFile(
  ctxRoot: string,
  instanceId: string,
  agent: string,
  pid: number,
  spawnedAt: string,
): void {
  const dir = agentStateDir(ctxRoot, agent);
  ensureDir(dir);
  const rec: AgentPidRecord = { instanceId, agent, pid, spawnedAt };
  const path = agentPidFilePath(ctxRoot, agent);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), 'utf-8');
  renameSync(tmp, path);
}

/** Remove the pid-file. Called ONLY on a clean stop — a crash/halt deliberately
 *  leaves it so reconcile can liveness-check + reap the survivor. */
export function clearAgentPidFile(ctxRoot: string, agent: string): void {
  const path = agentPidFilePath(ctxRoot, agent);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best effort — a leftover pid-file is reconciled (and unlinked) next boot */
  }
}

export function readAgentPidFile(path: string): AgentPidRecord | null {
  try {
    const rec = JSON.parse(readFileSync(path, 'utf-8')) as AgentPidRecord;
    if (rec && typeof rec.pid === 'number' && typeof rec.agent === 'string' && typeof rec.instanceId === 'string') {
      return rec;
    }
    return null;
  } catch {
    return null;
  }
}

/** Scan ctxRoot/state/<name>/pty.pid for every agent of THIS instance. */
export function listAgentPidFiles(ctxRoot: string): Array<{ path: string; record: AgentPidRecord }> {
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return [];
  const out: Array<{ path: string; record: AgentPidRecord }> = [];
  let names: string[];
  try {
    names = readdirSync(stateDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
  for (const name of names) {
    const path = agentPidFilePath(ctxRoot, name);
    if (!existsSync(path)) continue;
    const record = readAgentPidFile(path);
    if (record) out.push({ path, record });
  }
  return out;
}

/**
 * Parse a `ps -o etime=` elapsed-time string (LOCALE-INDEPENDENT) to milliseconds.
 * Format: `[[dd-]hh:]mm:ss` — e.g. "05", "01:23", "12:34:56", "3-01:23:45".
 * Returns null if unparseable.
 */
export function parseEtimeMs(etime: string): number | null {
  const s = etime.trim();
  if (!s) return null;
  let days = 0;
  let rest = s;
  const dash = rest.indexOf('-');
  if (dash !== -1) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let h = 0, m = 0, sec = 0;
  if (parts.length === 3) [h, m, sec] = parts;
  else if (parts.length === 2) [m, sec] = parts;
  else if (parts.length === 1) [sec] = parts;
  else return null;
  if (!Number.isFinite(days)) return null;
  return ((days * 86400) + (h * 3600) + (m * 60) + sec) * 1000;
}

/** What the OS reports for a live PID — used to corroborate identity before reap. */
export interface LiveProcessInfo {
  /** Full command/argv string (`ps -o command=`) — comm/agent-pattern match. */
  command: string;
  /** Process actual start time, epoch ms (`ps -o lstart=` parsed). */
  startedAtMs: number;
}

/**
 * Probes injected into the pure classifier so it stays deterministically
 * unit-testable (no real processes / signals). Implementations live in
 * AgentManager.reconcileOrphans (kill(pid,0) + `ps` corroboration).
 */
export interface OrphanProbe {
  /** Does *a* process exist at this PID? (process.kill(pid, 0)) */
  isAlive(pid: number): boolean;
  /** OS-reported identity of the live PID, or null if dead/unreadable. */
  getLiveProcess(pid: number): LiveProcessInfo | null;
}

export type OrphanVerdict = 'reap' | 'stale-unlink' | 'foreign-skip';

/** Default command pattern that identifies an agent PTY process. */
export const AGENT_PROC_PATTERN = /\bclaude\b/i;
/** Start-time corroboration tolerance: absorbs `ps` second-granularity + the
 *  spawn→pid-file-write latency, while a recycled PID (taken over after our
 *  agent died, i.e. much later) falls far outside it. */
export const START_TIME_TOLERANCE_MS = 15_000;

export interface ClassifyOpts { agentPattern?: RegExp; toleranceMs?: number; }

/**
 * Pure reconcile decision. NEVER sends a signal — returns a verdict the caller
 * acts on. The PID-REUSE GUARD is 3-part and central: a pid-file existing +
 * kill-0 alive is NOT sufficient to reap. The OS may have recycled the dead
 * agent's PID onto (a) an unrelated process, or (b) ANOTHER agent/claude process
 * (another agent, another instance, an operator session) — for which a
 * command-pattern match ALONE would WRONGLY confirm. So we reap ONLY when ALL of:
 *   1. kill-0 — a process exists at the PID, AND
 *   2. command matches the agent-PTY pattern (not an unrelated process), AND
 *   3. the live process's actual start-time ≈ the pid-file's recorded spawnedAt
 *      (within tolerance) — proving it is THE SAME process we spawned, not a
 *      later process that recycled the PID.
 *
 *  - foreign-skip : pid-file's instanceId is not ours (impossible given path-
 *                   scoping — belt-and-suspenders; never touch it).
 *  - stale-unlink : daemon PID, OR dead, OR not-agent-command, OR start-time
 *                   mismatch (recycled PID). Remove the stale file — NEVER kill.
 *  - reap         : all 3 hold = confirmed OUR live orphaned agent PTY -> SIGTERM + unlink.
 */
export function classifyOrphan(
  record: AgentPidRecord,
  ownInstanceId: string,
  daemonPids: number[],
  probe: OrphanProbe,
  opts: ClassifyOpts = {},
): OrphanVerdict {
  if (record.instanceId !== ownInstanceId) return 'foreign-skip';
  if (daemonPids.includes(record.pid)) return 'stale-unlink';
  if (!probe.isAlive(record.pid)) return 'stale-unlink';

  const info = probe.getLiveProcess(record.pid);
  if (!info) return 'stale-unlink';

  // (2) command corroboration — rules out a recycled PID -> unrelated process.
  const pattern = opts.agentPattern ?? AGENT_PROC_PATTERN;
  if (!pattern.test(info.command)) return 'stale-unlink';

  // (3) start-time corroboration — rules out a recycled PID -> ANOTHER agent.
  const recordedMs = Date.parse(record.spawnedAt);
  if (!Number.isFinite(recordedMs)) return 'stale-unlink';
  const tol = opts.toleranceMs ?? START_TIME_TOLERANCE_MS;
  if (Math.abs(info.startedAtMs - recordedMs) > tol) return 'stale-unlink';

  return 'reap';
}
