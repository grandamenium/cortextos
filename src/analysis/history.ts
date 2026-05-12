// Timeseries rollup for `token-audit history`.
//
// Groups TurnFact[] into day/week/month buckets for a single agent or
// fleet-wide. Returns one row per bucket, sorted ascending.

import type { TurnFact } from './types.js';

export type Bucket = 'day' | 'week' | 'month';

export interface HistoryRow {
  bucket: string;   // YYYY-MM-DD (day) / YYYY-Www (week) / YYYY-MM (month)
  usd_total: number;
  usd_input: number;
  usd_output: number;
  usd_cache_read: number;
  usd_cache_write: number;
  turn_count: number;
}

function bucketKey(iso: string, b: Bucket): string {
  const d = new Date(iso);
  if (b === 'day') return iso.slice(0, 10);
  if (b === 'month') return iso.slice(0, 7);
  // ISO week (best-effort, no library): Thursday of the same week / 7-day groups since 1970.
  const utcDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const weekIndex = Math.floor(utcDay / 86_400_000 / 7);
  return `wk-${weekIndex}`;
}

export function history(turns: TurnFact[], opts: { agent?: string; bucket: Bucket }): HistoryRow[] {
  const filtered = opts.agent ? turns.filter((t) => t.agent === opts.agent) : turns;
  const byBucket = new Map<string, HistoryRow>();
  for (const t of filtered) {
    const key = bucketKey(t.ts, opts.bucket);
    let row = byBucket.get(key);
    if (!row) {
      row = { bucket: key, usd_total: 0, usd_input: 0, usd_output: 0, usd_cache_read: 0, usd_cache_write: 0, turn_count: 0 };
      byBucket.set(key, row);
    }
    row.usd_total += t.usd_total;
    row.usd_input += t.usd_input;
    row.usd_output += t.usd_output;
    row.usd_cache_read += t.usd_cache_read;
    row.usd_cache_write += t.usd_cache_write;
    row.turn_count += 1;
  }
  return Array.from(byBucket.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}
