import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { Heartbeat } from '../types/index.js';

// ---------------------------------------------------------------------------
// Local shape mirror of SpawnFailureHistory (defined in
// src/daemon/spawn-failure-tracker.ts as of c99a5f9 / 2026-05-15). Mirrored
// here rather than imported so utils/ doesn't take a dep on daemon/ — that
// import direction would create a cycle once doctor-cron and heartbeat-watcher
// (plan #2, #4) reuse these helpers.
//
// If the on-disk schema gains fields (e.g. exitCode), keep this mirror in
// sync OR lift the canonical shape into src/types/index.ts and replace this
// with an import. Silent skew is the only risk: we only read events[].agent
// and events[].ts here, so additive changes to other fields are safe.
// ---------------------------------------------------------------------------
interface SpawnFailureHistoryReadOnly {
  events?: Array<{ ts: string; agent: string; err?: string }>;
}

// Restart-log kinds written by the daemon and the bus system module.
// Keep in lock-step with the writers at:
//   src/daemon/agent-process.ts:722 (CRASH / HALTED / SPAWN-FAIL / SPAWN-FAIL-HALTED)
//   src/bus/system.ts:69, 103       (SELF-RESTART / HARD-RESTART)
export type RestartKind =
  | 'CRASH'
  | 'HALTED'
  | 'SPAWN-FAIL'
  | 'SPAWN-FAIL-HALTED'
  | 'SELF-RESTART'
  | 'HARD-RESTART';

const RESTART_KINDS: ReadonlySet<RestartKind> = new Set([
  'CRASH',
  'HALTED',
  'SPAWN-FAIL',
  'SPAWN-FAIL-HALTED',
  'SELF-RESTART',
  'HARD-RESTART',
]);

export interface HeartbeatStatusFields {
  lastHeartbeatAgeSeconds?: number;
  lastHeartbeatTask?: string;
}

export function readHeartbeatStatus(
  ctxRoot: string,
  agentName: string,
  now: number = Date.now(),
): HeartbeatStatusFields {
  try {
    const hbPath = join(ctxRoot, 'state', agentName, 'heartbeat.json');
    if (!existsSync(hbPath)) return {};
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    // Legacy `timestamp` fallback already handled by bus/heartbeat.ts; preserve it here.
    const ts = hb.last_heartbeat || (hb as Heartbeat & { timestamp?: string }).timestamp;
    if (!ts) return {};
    const tsMs = new Date(ts).getTime();
    if (!Number.isFinite(tsMs)) return {};
    const age = Math.max(0, Math.floor((now - tsMs) / 1000));
    return {
      lastHeartbeatAgeSeconds: age,
      lastHeartbeatTask: hb.current_task || undefined,
    };
  } catch {
    return {};
  }
}

export function readLastInboxMessageAge(
  ctxRoot: string,
  agentName: string,
  now: number = Date.now(),
): number | undefined {
  try {
    const inboxDir = join(ctxRoot, 'inbox', agentName);
    if (!existsSync(inboxDir)) return undefined;
    const entries = readdirSync(inboxDir, { withFileTypes: true });
    let newest: number = -1;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const st = statSync(join(inboxDir, entry.name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* skip unreadable file */ }
    }
    if (newest < 0) return undefined;
    return Math.max(0, Math.floor((now - newest) / 1000));
  } catch {
    return undefined;
  }
}

export interface CrashBudgetFields {
  // All three are always populated — the helper never returns partial budget
  // info. The corresponding fields on AgentStatus stay optional because the
  // daemon-down fallback path doesn't construct AgentStatus through here.
  crashCountToday: number;
  maxCrashesPerDay: number;
  crashesRemaining: number;
}

/**
 * Parse the on-disk `<logs>/<agent>/.crash_count_today` file. Format is
 * `YYYY-MM-DD:N`. When the stored date doesn't match today, today's count
 * is logically 0 (the daemon will reset on next crash).
 *
 * If the file is unreadable, falls back to `fallbackCrashCount` so the
 * in-memory counter still surfaces.
 */
export function readCrashBudget(
  ctxRoot: string,
  agentName: string,
  maxCrashesPerDay: number,
  fallbackCrashCount: number,
  today: string = new Date().toISOString().slice(0, 10),
): CrashBudgetFields {
  let crashCountToday = fallbackCrashCount;
  try {
    const crashFile = join(ctxRoot, 'logs', agentName, '.crash_count_today');
    if (existsSync(crashFile)) {
      const content = readFileSync(crashFile, 'utf-8').trim();
      const [storedDate, count] = content.split(':');
      const parsed = parseInt(count, 10);
      if (storedDate === today && Number.isFinite(parsed) && parsed >= 0) {
        crashCountToday = parsed;
      } else if (storedDate !== today) {
        crashCountToday = 0;
      }
    }
  } catch {
    // fall through with fallback
  }
  return {
    crashCountToday,
    maxCrashesPerDay,
    crashesRemaining: Math.max(0, maxCrashesPerDay - crashCountToday),
  };
}

export interface LastRestartFields {
  lastRestartReason?: string;
  lastRestartKind?: RestartKind;
}

/**
 * Read the last non-empty line of `logs/<agent>/restarts.log`. Each line is
 * `[<ts>] <KIND>: <details>`. The kind must be one of the known restart
 * kinds — anything else parses as `lastRestartReason` text without a kind.
 */
export function readLastRestart(ctxRoot: string, agentName: string): LastRestartFields {
  try {
    const path = join(ctxRoot, 'logs', agentName, 'restarts.log');
    if (!existsSync(path)) return {};
    const lines = readFileSync(path, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines.pop();
    if (!last) return {};
    // Match `[<ts>] <KIND>: <details>` — kind must be all-caps + hyphens.
    const m = /^\[[^\]]+\]\s+([A-Z][A-Z-]*):\s*(.*)$/.exec(last);
    if (!m) return { lastRestartReason: last };
    const kind = m[1] as RestartKind;
    const details = m[2];
    if (RESTART_KINDS.has(kind)) {
      return {
        lastRestartKind: kind,
        lastRestartReason: details || undefined,
      };
    }
    return { lastRestartReason: last };
  } catch {
    return {};
  }
}

/**
 * Find the most recent spawn-failure event for `agentName` in the
 * fleet-wide history file. Returns null when no such event exists; returns
 * undefined when the file can't be read (so callers can distinguish
 * "definitively none" from "couldn't tell").
 */
export function readLastSpawnFailureAge(
  ctxRoot: string,
  agentName: string,
  now: number = Date.now(),
): number | null | undefined {
  try {
    const path = join(ctxRoot, 'state', '.spawn-failure-history.json');
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SpawnFailureHistoryReadOnly;
    const events = parsed.events ?? [];
    let newest: number = -1;
    for (const e of events) {
      if (e.agent !== agentName) continue;
      const ms = new Date(e.ts).getTime();
      if (Number.isFinite(ms) && ms > newest) newest = ms;
    }
    if (newest < 0) return null;
    return Math.max(0, Math.floor((now - newest) / 1000));
  } catch {
    return undefined;
  }
}
