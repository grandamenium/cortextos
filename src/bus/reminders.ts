/**
 * Persistent reminder queue (pending-reminders.json).
 *
 * Solves the cron-loss-on-hard-restart problem (#69).
 * Claude Code CronCreate records are in-memory only — they evaporate on hard-restart.
 * This module provides a file-backed queue in state/{agent}/pending-reminders.json
 * that survives any restart type and is injected into the agent boot prompt.
 *
 * Lifecycle:
 *   1. Agent calls `cortextos bus create-reminder <fire-at> <prompt>`
 *   2. Daemon boot prompt includes any overdue pending reminders
 *   3. Agent processes the reminder, calls `cortextos bus ack-reminder <id>`
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import type { BusPaths } from '../types/index.js';

export interface Reminder {
  id: string;
  created_at: string;
  fire_at: string;      // ISO 8601 UTC — when the reminder should fire
  prompt: string;       // The text to inject into the boot prompt when overdue
  status: 'pending' | 'acked';
  acked_at?: string;
}

function remindersPath(paths: BusPaths): string {
  return join(paths.stateDir, 'pending-reminders.json');
}

function remindersLockDir(paths: BusPaths): string {
  return join(paths.stateDir, '.locks', 'pending-reminders');
}

function parseRemindersFile(filePath: string): Reminder[] | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as Reminder[] : null;
  } catch {
    return null;
  }
}

function readReminders(paths: BusPaths): Reminder[] {
  const filePath = remindersPath(paths);
  return parseRemindersFile(filePath) ?? parseRemindersFile(filePath + '.bak') ?? [];
}

function writeReminders(paths: BusPaths, reminders: Reminder[]): void {
  ensureDir(paths.stateDir);
  atomicWriteSync(remindersPath(paths), JSON.stringify(reminders, null, 2), /* keepBak= */ true);
}

/**
 * Create a new persistent reminder.
 * fire_at: ISO 8601 UTC string (e.g. "2026-04-05T08:00:00Z")
 * prompt: text to inject into agent boot prompt when overdue
 */
export function createReminder(paths: BusPaths, fireAt: string, prompt: string): Reminder {
  // Validate fire_at is a parseable date
  const ts = Date.parse(fireAt);
  if (isNaN(ts)) {
    throw new Error(`Invalid fire_at date: "${fireAt}". Use ISO 8601 format, e.g. 2026-04-05T08:00:00Z`);
  }

  const id = `${Date.now()}-reminder-${randomBytes(3).toString('hex')}`;
  const reminder: Reminder = {
    id,
    created_at: new Date().toISOString(),
    fire_at: new Date(ts).toISOString(),
    prompt,
    status: 'pending',
  };

  const lockDir = remindersLockDir(paths);
  ensureDir(lockDir);
  withFileLockSync(lockDir, () => {
    const reminders = readReminders(paths);
    reminders.push(reminder);
    writeReminders(paths, reminders);
  });
  return reminder;
}

/**
 * List reminders. By default returns only pending ones.
 */
export function listReminders(paths: BusPaths, opts: { all?: boolean } = {}): Reminder[] {
  const reminders = readReminders(paths);
  if (opts.all) return reminders;
  return reminders.filter(r => r.status === 'pending');
}

/**
 * Return pending reminders whose fire_at is in the past (overdue).
 * Used by agent-process.ts to inject into the boot prompt.
 */
export function getOverdueReminders(paths: BusPaths): Reminder[] {
  const now = Date.now();
  return readReminders(paths).filter(
    r => r.status === 'pending' && Date.parse(r.fire_at) <= now,
  );
}

/**
 * Acknowledge a reminder by ID — marks it as handled.
 */
export function ackReminder(paths: BusPaths, id: string): void {
  const lockDir = remindersLockDir(paths);
  ensureDir(lockDir);
  withFileLockSync(lockDir, () => {
    const reminders = readReminders(paths);
    const idx = reminders.findIndex(r => r.id === id);
    if (idx === -1) {
      throw new Error(`Reminder ${id} not found`);
    }
    reminders[idx] = {
      ...reminders[idx],
      status: 'acked',
      acked_at: new Date().toISOString(),
    };
    writeReminders(paths, reminders);
  });
}

/**
 * Delete acked reminders older than retainDays (default 7).
 * Call periodically to prevent unbounded file growth.
 */
export function pruneReminders(paths: BusPaths, retainDays: number = 7): number {
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const lockDir = remindersLockDir(paths);
  ensureDir(lockDir);
  return withFileLockSync(lockDir, () => {
    const reminders = readReminders(paths);
    const kept = reminders.filter(r => {
      if (r.status !== 'acked') return true;
      const ackedAt = r.acked_at ? Date.parse(r.acked_at) : 0;
      return ackedAt > cutoff;
    });
    const pruned = reminders.length - kept.length;
    if (pruned > 0) writeReminders(paths, kept);
    return pruned;
  });
}
