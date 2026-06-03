import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { BackendId, Unavailability } from './base.js';

/**
 * Structured per-attempt observability record (spec §4.3).
 *
 * Field names match the spec's JSON example verbatim so the dashboard and
 * downstream tooling can parse a stable schema. One JSON line per attempt or
 * transition is appended to the dispatch JSONL.
 */
export interface HermesAttemptRecord {
  ts: string;
  taskId: string;
  backend: BackendId;
  phase: 'health' | 'execute';
  try?: number;
  ok?: boolean;
  available?: boolean;
  reason?: Unavailability;
  failure?: Unavailability;
  retryable?: boolean;
  requestedModel?: string | null;
  servedModel?: string | null;
  exitCode?: number;
  stderrExcerpt?: string;
  decision?: string;
  nextBackend?: BackendId | null;
}

/**
 * Sink for attempt records. The dispatch loop calls `record()` once per health
 * probe and once per execute attempt. `ts` is optional on the way in — the
 * logger stamps it from the injected clock if the caller omits it.
 */
export interface HermesLogger {
  record(rec: Omit<HermesAttemptRecord, 'ts'> & { ts?: string }): void;
}

/**
 * Create a JSONL logger that appends one line per record to `filePath`.
 *
 * - The containing directory is created (recursive) up front.
 * - `ts` is stamped from `now()` (default Date.now) as an ISO-8601 string when
 *   the caller does not supply one. `now` is injectable for deterministic tests.
 * - The fs write is best-effort: a write failure is swallowed so logging can
 *   NEVER throw into the dispatch loop (never-silent must not be defeated by a
 *   full disk). Only the fs append is wrapped — a programming error elsewhere
 *   still surfaces.
 */
export function createHermesLogger(
  filePath: string,
  now: () => number = Date.now,
): HermesLogger {
  // mkdir -p the dir once at construction. If even this fails (e.g. a read-only
  // parent), each record() write will no-op via its own try/catch.
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    /* best-effort — record() writes are independently guarded */
  }

  return {
    record(rec: Omit<HermesAttemptRecord, 'ts'> & { ts?: string }): void {
      const full: HermesAttemptRecord = {
        ts: rec.ts ?? new Date(now()).toISOString(),
        ...rec,
      };
      const line = JSON.stringify(full);
      try {
        appendFileSync(filePath, line + '\n', 'utf-8');
      } catch {
        /* logging must never throw into the dispatch loop — best-effort */
      }
    },
  };
}

/**
 * Default per-agent dispatch log path, following the repo convention from
 * src/utils/paths.ts:42 (`logDir = <ctxRoot>/logs/<agentName>`):
 *   <ctxRoot>/logs/<agentName>/hermes-dispatch.jsonl
 */
export function defaultLogPath(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, 'logs', agentName, 'hermes-dispatch.jsonl');
}
