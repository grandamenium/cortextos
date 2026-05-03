/**
 * Daemon-side mirror of the agent's live CronList output (cron-list.json).
 *
 * The agent dumps its current CronList tool result here on every heartbeat
 * via `cortextos bus update-cron-list` (stdin JSON). The daemon polls this
 * file and compares against config.json's `crons[]` to detect crons that
 * have silently dropped out of the active session — typically because of
 * the 7-day CronCreate auto-expiry, an unobserved restart, or compaction.
 *
 * On mismatch, the daemon injects a forced-recreate nudge so the agent
 * recreates the cron via CronCreate before the gap-detector's 2x-interval
 * threshold has had time to elapse (which on a weekly cron is 14 days of
 * silent failure — unacceptable).
 *
 * Storage: state/<agent>/cron-list.json (same dir as cron-state.json).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export interface CronListEntry {
  /** The cron's logical name as it appears in config.json. */
  name: string;
  /** The verbatim prompt the cron fires (matched against config.json on agent dump). */
  prompt: string;
}

interface CronListFile {
  updated_at: string;
  crons: CronListEntry[];
}

function cronListPath(stateDir: string): string {
  return join(stateDir, 'cron-list.json');
}

/**
 * Atomically write the agent's current CronList contents.
 * Called by `cortextos bus update-cron-list` (stdin JSON).
 */
export function writeCronList(stateDir: string, crons: CronListEntry[]): void {
  ensureDir(stateDir);
  const payload: CronListFile = {
    updated_at: new Date().toISOString(),
    crons,
  };
  atomicWriteSync(cronListPath(stateDir), JSON.stringify(payload, null, 2) + '\n');
}

/**
 * Read the agent's last-dumped CronList. Returns null when the file is
 * missing, malformed, or older than `maxAgeMs` (stale dumps may not reflect
 * the current session — caller skips mismatch detection in that case).
 */
export function readCronList(
  stateDir: string,
  maxAgeMs: number,
): CronListFile | null {
  const filePath = cronListPath(stateDir);
  if (!existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as CronListFile).crons) ||
    typeof (parsed as CronListFile).updated_at !== 'string'
  ) {
    return null;
  }
  const file = parsed as CronListFile;
  const updatedAtMs = Date.parse(file.updated_at);
  if (isNaN(updatedAtMs)) return null;
  if (Date.now() - updatedAtMs > maxAgeMs) return null;
  return file;
}

/**
 * Compute which configured crons are missing from the agent's last
 * CronList dump. Match by name first, fall back to prompt equality so
 * a renamed-but-still-running cron isn't falsely flagged.
 *
 * Pure function — no I/O — so the daemon polling loop and unit tests
 * share the same implementation.
 */
export function findMissingCrons(
  configCrons: Array<{ name: string; prompt: string; type?: string }>,
  liveCrons: CronListEntry[],
): Array<{ name: string; prompt: string }> {
  const liveByName = new Set(liveCrons.map(c => c.name));
  const livePrompts = new Set(liveCrons.map(c => c.prompt));
  const missing: Array<{ name: string; prompt: string }> = [];
  for (const cfg of configCrons) {
    if (cfg.type === 'once' || cfg.type === 'disabled') continue;
    if (!cfg.prompt) continue;
    if (liveByName.has(cfg.name)) continue;
    if (livePrompts.has(cfg.prompt)) continue;
    missing.push({ name: cfg.name, prompt: cfg.prompt });
  }
  return missing;
}
