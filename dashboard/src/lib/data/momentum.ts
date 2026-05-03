// cortextOS Dashboard - Momentum data fetcher (misty's coaching widgets)
// Reads ~/.cortextos/<instance>/analytics/misty-widgets.json, refreshed by bill's 15-min cron.
// If the blob is stale (>20 min) or missing, lazily regenerates by shelling out to bill's refresh script.

import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CTX_ROOT, CTX_FRAMEWORK_ROOT } from '@/lib/config';

const execFileAsync = promisify(execFile);

const STALE_AFTER_MS = 20 * 60 * 1000;
const REFRESH_SCRIPT = path.join(
  CTX_FRAMEWORK_ROOT,
  'orgs/actuary-mon/agents/bill/private/scripts/refresh-misty-widgets.sh',
);
const BLOB_PATH = path.join(CTX_ROOT, 'analytics', 'misty-widgets.json');

export interface MomentumData {
  updated_at: string;
  streak: {
    current_streak: number;
    longest_streak: number;
    last_engagement_date: string | null;
    days_with_engagement: number;
  };
  win_bank: {
    window_days: number;
    total_wins: number;
    by_agent: Record<string, number>;
    top_recent: Array<{ agent: string; title: string; pt: string }>;
  };
}

async function tryRefresh(): Promise<void> {
  try {
    await execFileAsync('bash', [REFRESH_SCRIPT], { timeout: 5000 });
  } catch {
    // Refresh script failed — caller will fall back to whatever blob exists.
  }
}

export async function getMomentum(): Promise<MomentumData | null> {
  let stat: { mtimeMs: number } | null = null;
  try {
    stat = await fs.stat(BLOB_PATH);
  } catch {
    stat = null;
  }

  const stale = !stat || Date.now() - stat.mtimeMs > STALE_AFTER_MS;
  if (stale) {
    await tryRefresh();
  }

  try {
    const raw = await fs.readFile(BLOB_PATH, 'utf-8');
    return JSON.parse(raw) as MomentumData;
  } catch {
    return null;
  }
}
