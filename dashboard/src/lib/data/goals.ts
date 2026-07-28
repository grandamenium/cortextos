// cortextOS Dashboard - Goals data fetcher
// Reads/writes goals.json directly from filesystem (not SQLite).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getGoalsPath } from '@/lib/config';
import type { GoalsFile, GoalsData } from '@/lib/types';

const DEFAULT_GOALS: GoalsFile = {
  bottleneck: '',
  goals: [],
};

/**
 * Read goals.json for an org. Returns default structure if file missing.
 */
export function getGoals(org: string): GoalsData {
  const filePath = getGoalsPath(org);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_GOALS, goals: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    let goals: import('@/lib/types').Goal[] = [];
    if (Array.isArray(data.goals)) {
      goals = data.goals.map((g: unknown, i: number) => {
        if (typeof g === 'string') {
          // Legacy format: goals are plain strings
          return { id: `goal-${i}`, title: g, progress: 0, order: i };
        }
        // Dashboard format: goals are objects with id, title, progress
        const obj = g as Record<string, unknown>;
        return {
          id: (obj.id as string) ?? `goal-${i}`,
          title: (obj.title as string) ?? 'Untitled',
          progress: (obj.progress as number) ?? 0,
          order: (obj.order as number) ?? i,
        };
      });
    }

    return {
      bottleneck: data.bottleneck ?? '',
      goals,
      daily_focus: data.daily_focus ?? undefined,
      daily_focus_set_at: data.daily_focus_set_at ?? undefined,
    };
  } catch {
    return { ...DEFAULT_GOALS, goals: [] };
  }
}

// The fields getGoals() reconstructs, and therefore the only ones writeGoals()
// is entitled to overwrite. Everything else in the file belongs to another
// writer (the CLI, the agents) and is passed through untouched.
const MODELLED_KEYS = [
  'bottleneck',
  'goals',
  'daily_focus',
  'daily_focus_set_at',
] as const;

/**
 * Atomic write of goals.json for an org (write to tmp, then rename).
 *
 * Merges onto the current file rather than replacing it: getGoals() returns
 * only the modelled fields, so serializing that object over the whole file
 * would silently drop every key the dashboard does not model — north_star and
 * updated_at among them.
 */
export function writeGoals(org: string, data: GoalsData): void {
  const filePath = getGoalsPath(org);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let merged: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      merged = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed file — fall back to writing just the modelled fields.
  }

  const incoming = data as unknown as Record<string, unknown>;
  for (const key of MODELLED_KEYS) {
    // An absent modelled field is a deliberate clear, not "leave it alone" —
    // so it must be removed rather than inherited back from the old file.
    if (incoming[key] === undefined) {
      delete merged[key];
    } else {
      merged[key] = incoming[key];
    }
  }

  const tmp = path.join(os.tmpdir(), `goals-${org}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Read goal history by scanning events for bottleneck/goal changes.
 * Returns recent events related to goal modifications.
 */
export function getGoalHistory(
  org: string
): Array<{ timestamp: string; change: string }> {
  try {
    const { getRecentEvents } = require('./events');
    const events = getRecentEvents(50, org) as Array<{
      type: string;
      message?: string;
      timestamp: string;
    }>;
    return events
      .filter(
        (e) =>
          e.type === 'action' &&
          e.message &&
          (e.message.includes('goal') || e.message.includes('bottleneck'))
      )
      .map((e) => ({
        timestamp: e.timestamp,
        change: e.message ?? '',
      }));
  } catch {
    return [];
  }
}
