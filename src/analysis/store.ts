// JSONL fact store for token-audit.
//
// Layout (under <ctxRoot>):
//   analytics/token-audit/turns/<YYYY-MM-DD>.jsonl       — per-turn facts, append-only
//   analytics/token-audit/sessions/<YYYY-MM-DD>.jsonl    — denormalized session rollups (rewritten per run)
//   analytics/token-audit/anomalies/<YYYY-MM-DD>.jsonl   — anomaly records
//   analytics/token-audit/idle-burn/<YYYY-MM-DD>.jsonl   — daily idle-burn snapshots
//   analytics/token-audit/runs/<YYYY-MM-DD>.jsonl        — audit_runs log
//   analytics/token-audit/seen-turns.index.json          — dedup index of turn_ids
//
// Plan called for SQLite; the root package has zero runtime deps (CLAUDE.md
// explicitly forbids adding any without good reason), so we use the same
// JSONL convention as the existing analytics/events/ path. Queries are
// in-memory scans over the daily files — fine at the scale of one user's
// fleet (hundreds of turns/day).

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';
import type { TurnFact, SessionFact, Anomaly, IdleBurnRow, AuditRun } from './types.js';

export interface StorePaths {
  root: string;
  turnsDir: string;
  sessionsDir: string;
  anomaliesDir: string;
  idleBurnDir: string;
  runsDir: string;
  seenIndexPath: string;
}

export function resolveStorePaths(analyticsDir: string): StorePaths {
  const root = join(analyticsDir, 'token-audit');
  return {
    root,
    turnsDir: join(root, 'turns'),
    sessionsDir: join(root, 'sessions'),
    anomaliesDir: join(root, 'anomalies'),
    idleBurnDir: join(root, 'idle-burn'),
    runsDir: join(root, 'runs'),
    seenIndexPath: join(root, 'seen-turns.index.json'),
  };
}

function ensureDirs(s: StorePaths): void {
  for (const d of [s.turnsDir, s.sessionsDir, s.anomaliesDir, s.idleBurnDir, s.runsDir]) {
    mkdirSync(d, { recursive: true });
  }
}

function dayOf(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

// --- seen-turns dedup index -------------------------------------------------

export function loadSeenTurns(s: StorePaths): Set<string> {
  if (!existsSync(s.seenIndexPath)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(s.seenIndexPath, 'utf-8'));
    if (Array.isArray(raw)) return new Set(raw);
    return new Set();
  } catch {
    return new Set();
  }
}

export function persistSeenTurns(s: StorePaths, seen: Set<string>): void {
  ensureDirs(s);
  // Cap the index at the most-recent 200k turn_ids to bound size.
  const arr = Array.from(seen);
  const capped = arr.length > 200_000 ? arr.slice(arr.length - 200_000) : arr;
  atomicWriteSync(s.seenIndexPath, JSON.stringify(capped));
}

// --- turn append ------------------------------------------------------------

export function appendTurns(s: StorePaths, turns: TurnFact[]): number {
  if (turns.length === 0) return 0;
  ensureDirs(s);
  const byDay = new Map<string, string[]>();
  for (const t of turns) {
    const day = dayOf(t.ts);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(JSON.stringify(t));
  }
  for (const [day, lines] of byDay) {
    appendFileSync(join(s.turnsDir, `${day}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  }
  return turns.length;
}

// --- read turns within a time window ---------------------------------------

export function readTurns(s: StorePaths, since: Date, until: Date): TurnFact[] {
  if (!existsSync(s.turnsDir)) return [];
  const sinceDay = dayOf(since.toISOString());
  const untilDay = dayOf(until.toISOString());
  const sinceMs = since.getTime();
  const untilMs = until.getTime();

  const out: TurnFact[] = [];
  const files = readdirSync(s.turnsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .filter((f) => {
      const day = f.replace('.jsonl', '');
      return day >= sinceDay && day <= untilDay;
    })
    .sort();

  for (const file of files) {
    const lines = readFileSync(join(s.turnsDir, file), 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as TurnFact;
        const tMs = new Date(t.ts).getTime();
        if (Number.isFinite(tMs) && tMs >= sinceMs && tMs <= untilMs) out.push(t);
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

// --- sessions: rewrite per day (denormalized rollup) -----------------------

export function writeSessions(s: StorePaths, day: string, sessions: SessionFact[]): void {
  ensureDirs(s);
  const lines = sessions.map((x) => JSON.stringify(x)).join('\n');
  const data = lines.length ? lines + '\n' : '';
  atomicWriteSync(join(s.sessionsDir, `${day}.jsonl`), data);
}

export function readSessions(s: StorePaths, since: Date, until: Date): SessionFact[] {
  if (!existsSync(s.sessionsDir)) return [];
  const sinceDay = dayOf(since.toISOString());
  const untilDay = dayOf(until.toISOString());
  const out: SessionFact[] = [];
  for (const file of readdirSync(s.sessionsDir).filter((f) => f.endsWith('.jsonl'))) {
    const day = file.replace('.jsonl', '');
    if (day < sinceDay || day > untilDay) continue;
    for (const line of readFileSync(join(s.sessionsDir, file), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SessionFact);
      } catch {
        // skip
      }
    }
  }
  return out;
}

// --- anomalies --------------------------------------------------------------

/**
 * Stable signature identifying "the same underlying anomaly" across re-detects.
 * Two anomalies with the same kind/agent/session_id/evidence_turn_ids set are
 * the same observation; only one row should persist. Without this, the hourly
 * `runAudit` cron would multiply rows for unchanged conditions every cycle.
 */
function anomalySig(a: Anomaly): string {
  const evidence = [...a.evidence_turn_ids].sort().join(',');
  return `${a.kind}::${a.agent}::${a.session_id ?? ''}::${evidence}`;
}

export function appendAnomalies(s: StorePaths, anomalies: Anomaly[]): void {
  if (anomalies.length === 0) return;
  ensureDirs(s);
  const byDay = new Map<string, Anomaly[]>();
  for (const a of anomalies) {
    const day = dayOf(a.detected_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(a);
  }
  for (const [day, dayAnomalies] of byDay) {
    const filePath = join(s.anomaliesDir, `${day}.jsonl`);
    const existingSigs = new Set<string>();
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try { existingSigs.add(anomalySig(JSON.parse(line) as Anomaly)); } catch { /* skip malformed */ }
      }
    }
    const fresh = dayAnomalies.filter((a) => !existingSigs.has(anomalySig(a)));
    if (fresh.length === 0) continue;
    appendFileSync(filePath, fresh.map((a) => JSON.stringify(a)).join('\n') + '\n', 'utf-8');
  }
}

export function readAnomalies(s: StorePaths, since: Date, until: Date): Anomaly[] {
  if (!existsSync(s.anomaliesDir)) return [];
  const sinceDay = dayOf(since.toISOString());
  const untilDay = dayOf(until.toISOString());
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const out: Anomaly[] = [];
  for (const file of readdirSync(s.anomaliesDir).filter((f) => f.endsWith('.jsonl'))) {
    const day = file.replace('.jsonl', '');
    if (day < sinceDay || day > untilDay) continue;
    for (const line of readFileSync(join(s.anomaliesDir, file), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const a = JSON.parse(line) as Anomaly;
        const aMs = new Date(a.detected_at).getTime();
        if (!Number.isFinite(aMs) || aMs < sinceMs || aMs > untilMs) continue;
        out.push(a);
      } catch {
        // skip
      }
    }
  }
  return out;
}

// --- idle-burn snapshots ----------------------------------------------------

/**
 * Idle-burn rows are keyed by (agent, snapshot_date): only the latest snapshot
 * for that key is meaningful. Append-only would multiply rows on every hourly
 * run; instead, rewrite the day file with this run's rows for any agent
 * present, preserving rows for agents not in `rows`.
 */
export function appendIdleBurn(s: StorePaths, rows: IdleBurnRow[]): void {
  if (rows.length === 0) return;
  ensureDirs(s);
  const byDay = new Map<string, IdleBurnRow[]>();
  for (const r of rows) {
    if (!byDay.has(r.snapshot_date)) byDay.set(r.snapshot_date, []);
    byDay.get(r.snapshot_date)!.push(r);
  }
  for (const [day, freshRows] of byDay) {
    const filePath = join(s.idleBurnDir, `${day}.jsonl`);
    const updatedAgents = new Set(freshRows.map((r) => r.agent));
    const merged: IdleBurnRow[] = [...freshRows];
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const existing = JSON.parse(line) as IdleBurnRow;
          if (!updatedAgents.has(existing.agent)) merged.push(existing);
        } catch { /* skip malformed */ }
      }
    }
    const data = merged.map((r) => JSON.stringify(r)).join('\n') + '\n';
    atomicWriteSync(filePath, data);
  }
}

/**
 * Day-granularity reader. Unlike `readAnomalies` (which filters intra-day on
 * `detected_at`), idle-burn rows are inherently per (agent, snapshot_date) —
 * `appendIdleBurn` rewrites the day file rather than appending — so a
 * timestamp-precise filter would be meaningless. Day-bounded is the right
 * granularity for this data shape.
 */
export function readIdleBurn(s: StorePaths, since: Date, until: Date): IdleBurnRow[] {
  if (!existsSync(s.idleBurnDir)) return [];
  const sinceDay = dayOf(since.toISOString());
  const untilDay = dayOf(until.toISOString());
  const out: IdleBurnRow[] = [];
  for (const file of readdirSync(s.idleBurnDir).filter((f) => f.endsWith('.jsonl'))) {
    const day = file.replace('.jsonl', '');
    if (day < sinceDay || day > untilDay) continue;
    for (const line of readFileSync(join(s.idleBurnDir, file), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as IdleBurnRow);
      } catch {
        // skip
      }
    }
  }
  return out;
}

// --- audit runs -------------------------------------------------------------

export function appendAuditRun(s: StorePaths, run: AuditRun): void {
  ensureDirs(s);
  const day = dayOf(run.started_at);
  appendFileSync(join(s.runsDir, `${day}.jsonl`), JSON.stringify(run) + '\n', 'utf-8');
}
