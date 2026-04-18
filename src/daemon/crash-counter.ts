import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';

/**
 * Persistent crash counter for an agent.
 *
 * Stored as a simple file: {ctxRoot}/logs/{agent}/.crash_count_today
 * Format: YYYY-MM-DD:{count}
 *
 * Both AgentProcess (self-detected crashes) and StaleAgentWatchdog (stale
 * restarts) use this to share a single crash budget per agent per day.
 */

export interface CrashCountResult {
  /** The crash count AFTER incrementing */
  count: number;
  /** Today's date string (YYYY-MM-DD) */
  date: string;
}

/**
 * Read the current crash count for today. Returns 0 if file is missing or
 * from a previous day.
 */
export function readCrashCount(ctxRoot: string, agentName: string): number {
  const crashFile = join(ctxRoot, 'logs', agentName, '.crash_count_today');
  const today = new Date().toISOString().split('T')[0];

  try {
    if (!existsSync(crashFile)) return 0;
    const content = readFileSync(crashFile, 'utf-8').trim();
    const [storedDate, countStr] = content.split(':');
    if (storedDate !== today) return 0;
    const count = parseInt(countStr, 10);
    return isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}

/**
 * Increment the crash count for today and persist it. Returns the new count.
 *
 * Thread-safe enough for our use case: single-process daemon with async but
 * not truly concurrent writes to the same agent's file.
 */
export function incrementCrashCount(ctxRoot: string, agentName: string): CrashCountResult {
  const today = new Date().toISOString().split('T')[0];
  const logDir = join(ctxRoot, 'logs', agentName);
  const crashFile = join(logDir, '.crash_count_today');

  let currentCount = 0;
  try {
    if (existsSync(crashFile)) {
      const content = readFileSync(crashFile, 'utf-8').trim();
      const [storedDate, countStr] = content.split(':');
      if (storedDate === today) {
        currentCount = parseInt(countStr, 10);
        if (isNaN(currentCount)) currentCount = 0;
      }
    }
  } catch {
    // Start from 0 on read errors
  }

  const newCount = currentCount + 1;

  try {
    ensureDir(logDir);
    writeFileSync(crashFile, `${today}:${newCount}`, 'utf-8');
  } catch {
    // Persist failure is non-fatal — in-memory count is still correct
  }

  return { count: newCount, date: today };
}
