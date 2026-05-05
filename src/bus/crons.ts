/**
 * crons.ts — Cron definitions file I/O module (Subtask 1.2).
 *
 * All operations are synchronous and atomic (via atomicWriteSync).
 * Each agent has its own crons.json at:
 *   {CTX_ROOT}/{CRONS_DIRECTORY}/{agentName}/{CRONS_FILENAME}
 *
 * Disk format (envelope — matching CronStateFile shape from cron-state.ts):
 *   { "updated_at": "<ISO>", "crons": CronDefinition[] }
 *
 * Read always returns [] on missing file or parse failure (graceful degradation).
 * Corrupted JSON triggers a stderr warning so operators can investigate.
 *
 * Write always goes through atomicWriteSync (mkdir + tmp rename).
 */

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { CronDefinition, CronExecutionLogEntry } from '../types/index.js';
import { CRONS_DIRECTORY, CRONS_FILENAME, cronExecutionLogPathFor } from './crons-schema.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Disk envelope shape — keeps metadata separate from the cron array. */
interface CronsFile {
  updated_at: string;
  crons: CronDefinition[];
}

/**
 * Resolve the absolute path to an agent's crons.json.
 *
 * Uses CTX_ROOT env var when available (production), otherwise falls back to
 * a path relative to process.cwd() so tests can supply their own root via
 * process.env.CTX_ROOT pointing to a tempdir.
 */
function cronsFilePath(agentName: string): string {
  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  return join(ctxRoot, CRONS_DIRECTORY, agentName, CRONS_FILENAME);
}

/**
 * Per-agent lock directory for the read-modify-write helpers below.
 *
 * `acquireLock` (utils/lock.ts) creates a `.lock.d` mkdir inside this
 * dir, so the dir itself must exist.  We mkdir-recursive on first use
 * — same idempotent path that atomicWriteSync uses.
 *
 * Using the agent's directory (parent of crons.json) means different
 * agents don't block each other; only writers to the SAME agent's
 * crons.json serialize.
 */
function lockDirFor(agentName: string): string {
  const dir = dirname(cronsFilePath(agentName));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to parse a raw crons.json string and return the crons array, or null on failure.
 */
function parseCronsRaw(raw: string, agentName: string, label: string): CronDefinition[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'crons' in parsed &&
      Array.isArray((parsed as CronsFile).crons)
    ) {
      return (parsed as CronsFile).crons;
    }
    process.stderr.write(
      `[crons] WARNING: ${label} for agent "${agentName}" has unexpected shape.\n`
    );
    return null;
  } catch (err) {
    process.stderr.write(
      `[crons] WARNING: failed to parse ${label} for agent "${agentName}". ` +
        `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

/**
 * Result of {@link readCronsWithStatus}.
 *
 * `corrupt` distinguishes two empty-`crons` cases that callers must treat
 * differently:
 *
 *   - `corrupt: false` — the file does not exist OR it parsed cleanly to an
 *     empty array.  This is the legitimate "no crons registered" state and
 *     callers should honor it (e.g. clear in-memory schedule).
 *
 *   - `corrupt: true` — the primary file is unparseable AND the `.bak`
 *     fallback also failed (or is missing).  The empty `crons` array here
 *     is a degraded sentinel, not a real schedule.  Callers that maintain
 *     a last-good in-memory snapshot (e.g. cron-scheduler) should retain
 *     it instead of zeroing out.
 *
 * NEVER use `crons.length === 0` alone as a corruption signal — a freshly
 * removed last-cron also produces `[]`.
 */
export interface CronsReadResult {
  crons: CronDefinition[];
  corrupt: boolean;
}

/**
 * Read all cron definitions for an agent from disk, with a corruption flag.
 *
 * On parse failure the function automatically falls back to the `.bak` file
 * written by the most recent `writeCrons()` call.  This provides single-step
 * automatic recovery from transient corruption without requiring operator
 * intervention.
 *
 * Use this in preference to {@link readCrons} when the caller needs to
 * distinguish "legitimately empty" from "catastrophic corruption" (see
 * {@link CronsReadResult}).
 */
export function readCronsWithStatus(agentName: string): CronsReadResult {
  const filePath = cronsFilePath(agentName);
  if (!existsSync(filePath)) {
    return { crons: [], corrupt: false };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const crons = parseCronsRaw(raw, agentName, 'crons.json');
    if (crons !== null) {
      return { crons, corrupt: false };
    }
  } catch (err) {
    process.stderr.write(
      `[crons] WARNING: failed to read crons.json for agent "${agentName}" — ` +
        `${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  // Primary file failed — try the .bak file created by writeCrons().
  const bakPath = filePath + '.bak';
  if (existsSync(bakPath)) {
    process.stderr.write(
      `[crons] WARNING: falling back to crons.json.bak for agent "${agentName}"\n`
    );
    try {
      const bakRaw = readFileSync(bakPath, 'utf-8');
      const bakCrons = parseCronsRaw(bakRaw, agentName, 'crons.json.bak');
      if (bakCrons !== null) {
        return { crons: bakCrons, corrupt: false };
      }
    } catch (err) {
      process.stderr.write(
        `[crons] WARNING: failed to read crons.json.bak for agent "${agentName}" — ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  // Primary failed AND .bak failed-or-missing — catastrophic.
  return { crons: [], corrupt: true };
}

/**
 * Read all cron definitions for an agent from disk.
 *
 * On parse failure the function automatically falls back to the `.bak` file
 * written by the most recent `writeCrons()` call.  This provides single-step
 * automatic recovery from transient corruption without requiring operator
 * intervention.
 *
 * @returns Array of CronDefinition objects.  Returns [] when both the primary
 *          file and the backup are absent or unparseable — never throws.
 *          NOTE: this loses the corrupt-vs-legitimately-empty distinction —
 *          use {@link readCronsWithStatus} when that matters.
 */
export function readCrons(agentName: string): CronDefinition[] {
  return readCronsWithStatus(agentName).crons;
}

/**
 * Write (replace) all cron definitions for an agent atomically.
 *
 * Always updates the envelope's `updated_at` to the current UTC time.
 * Passes `keepBak = true` to `atomicWriteSync` so the previous crons.json is
 * preserved as `crons.json.bak` before the new file is written.  This enables
 * automatic recovery in `readCrons()` on parse failure.
 */
export function writeCrons(agentName: string, crons: CronDefinition[]): void {
  const filePath = cronsFilePath(agentName);
  const envelope: CronsFile = {
    updated_at: new Date().toISOString(),
    crons,
  };
  atomicWriteSync(filePath, JSON.stringify(envelope, null, 2), /* keepBak= */ true);
}

/**
 * Add a new cron definition for an agent.
 *
 * @throws {Error} if a cron with the same name already exists for the agent.
 */
export function addCron(agentName: string, cron: CronDefinition): void {
  withFileLockSync(lockDirFor(agentName), () => {
    const existing = readCrons(agentName);
    const collision = existing.find(c => c.name === cron.name);
    if (collision !== undefined) {
      throw new Error(`cron "${cron.name}" already exists for agent "${agentName}"`);
    }
    writeCrons(agentName, [...existing, cron]);
  });
}

/**
 * Remove a cron by name for an agent.
 *
 * @returns `true` if the cron was found and removed; `false` if it did not exist.
 *          Never throws (idempotent).
 */
export function removeCron(agentName: string, name: string): boolean {
  return withFileLockSync(lockDirFor(agentName), () => {
    const existing = readCrons(agentName);
    const idx = existing.findIndex(c => c.name === name);
    if (idx === -1) {
      return false;
    }
    const updated = [...existing.slice(0, idx), ...existing.slice(idx + 1)];
    writeCrons(agentName, updated);
    return true;
  });
}

/**
 * Patch an existing cron definition with new field values.
 *
 * Merges `patch` into the matching cron object using `Object.assign` semantics
 * (shallow merge).  The `name` field in `patch` is ignored — the cron is
 * looked up by the `name` parameter and the stored name is never changed.
 *
 * @returns `true` if the cron was found and updated; `false` if it did not exist.
 */
export function updateCron(
  agentName: string,
  name: string,
  patch: Partial<CronDefinition>
): boolean {
  return withFileLockSync(lockDirFor(agentName), () => {
    const existing = readCrons(agentName);
    const idx = existing.findIndex(c => c.name === name);
    if (idx === -1) {
      return false;
    }
    const updated = existing.map((c, i) =>
      i === idx ? { ...c, ...patch, name: c.name } : c
    );
    writeCrons(agentName, updated);
    return true;
  });
}

/**
 * Look up a single cron by name for an agent.
 *
 * @returns The CronDefinition if found, `undefined` otherwise.
 */
export function getCronByName(
  agentName: string,
  name: string
): CronDefinition | undefined {
  return readCrons(agentName).find(c => c.name === name);
}

// ---------------------------------------------------------------------------
// Execution log reader — Subtask 1.5
// ---------------------------------------------------------------------------

/**
 * Status filter for execution log queries.
 * - 'all'     — no status filtering (default)
 * - 'success' — only 'fired' entries
 * - 'failure' — only 'failed' entries
 */
export type ExecutionLogStatusFilter = 'all' | 'success' | 'failure';

/**
 * Paginated result returned by getExecutionLog when offset is provided.
 */
export interface ExecutionLogPage {
  /** Entries for this page (most-recent last order preserved). */
  entries: CronExecutionLogEntry[];
  /** Total number of entries matching the cronName + statusFilter. */
  total: number;
  /** True when there are more entries before this page (i.e. offset + entries.length < total). */
  hasMore: boolean;
}

/**
 * Read the cron execution log for an agent.
 *
 * @param agentName    - Agent whose log file to read.
 * @param cronName     - Optional: if provided, return only entries for this cron.
 * @param limit        - Maximum number of entries to return (most-recent last).
 *                       Defaults to 50.  Pass 0 for all entries.
 * @param offset       - Number of matching entries to skip from the most-recent end
 *                       before taking `limit`.  Used for pagination.
 *                       Defaults to 0 (start from most-recent).
 * @param statusFilter - Optional status filter: 'success' (fired only), 'failure' (failed only),
 *                       or 'all' (default, no filtering).
 * @returns Array of log entries.  Returns [] if the log file doesn't exist.
 *          Malformed JSONL lines are silently skipped.
 */
export function getExecutionLog(
  agentName: string,
  cronName?: string,
  limit = 50,
  offset = 0,
  statusFilter: ExecutionLogStatusFilter = 'all',
): CronExecutionLogEntry[] {
  return getExecutionLogPage(agentName, cronName, limit, offset, statusFilter).entries;
}

/**
 * Read the cron execution log for an agent, returning full pagination metadata.
 *
 * Identical to getExecutionLog but returns an ExecutionLogPage with total + hasMore.
 *
 * @param agentName    - Agent whose log file to read.
 * @param cronName     - Optional: if provided, return only entries for this cron.
 * @param limit        - Max entries per page.  Defaults to 100.  0 = all.
 * @param offset       - Entries to skip from the most-recent end.  Defaults to 0.
 * @param statusFilter - 'all' | 'success' | 'failure'.  Defaults to 'all'.
 * @returns ExecutionLogPage with entries, total, and hasMore.
 */
export function getExecutionLogPage(
  agentName: string,
  cronName?: string,
  limit = 100,
  offset = 0,
  statusFilter: ExecutionLogStatusFilter = 'all',
): ExecutionLogPage {
  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  const filePath = join(ctxRoot, cronExecutionLogPathFor(agentName));

  if (!existsSync(filePath)) {
    return { entries: [], total: 0, hasMore: false };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { entries: [], total: 0, hasMore: false };
  }

  const allEntries: CronExecutionLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      allEntries.push(JSON.parse(trimmed) as CronExecutionLogEntry);
    } catch {
      // Skip malformed lines
    }
  }

  // Filter by cron name
  let filtered = cronName !== undefined
    ? allEntries.filter(e => e.cron === cronName)
    : allEntries;

  // Apply status filter
  if (statusFilter === 'success') {
    filtered = filtered.filter(e => e.status === 'fired');
  } else if (statusFilter === 'failure') {
    filtered = filtered.filter(e => e.status === 'failed');
  }

  const total = filtered.length;

  // Entries are stored oldest-first; we want most-recent at the front for pagination.
  // offset=0 means "most recent N entries", offset=N means "next N older entries".
  // Slice from the end: the window is [total - offset - limit, total - offset)
  if (limit <= 0) {
    // Return all, respecting offset only
    const safeOffset = Math.min(offset, total);
    const entries = filtered.slice(0, total - safeOffset);
    return { entries, total, hasMore: false };
  }

  const safeOffset = Math.max(0, Math.min(offset, total));
  const end = total - safeOffset;
  const start = Math.max(0, end - limit);
  const entries = filtered.slice(start, end);
  const hasMore = start > 0;

  return { entries, total, hasMore };
}
