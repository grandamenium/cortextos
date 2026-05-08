// Context-usage monitor — Phase 1 of BL-2026-05-08-004 (engineer context discipline).
//
// Reads a Claude Code session transcript JSONL, extracts the most recent
// assistant turn's `usage` fields, computes loaded context % against a
// model-aware limit, and produces a snapshot suitable for atomic write
// to ~/.cortextos/<inst>/state/<agent>/context-pct.json.
//
// Design notes:
// - Per code-quality.md "session-restart-immunity": we DO NOT key on
//   session_id. The lookup is by (encoded_cwd, most-recent-mtime). The
//   session_id appears in the output as a forensic tag only.
// - Loaded context = input_tokens + cache_creation_input_tokens +
//   cache_read_input_tokens. The bare `input_tokens` field is just the
//   uncached portion of the latest turn — using it alone under-counts
//   the true context size by ~99% on cached cycles.
// - 1M-context detection is environment-driven (CLAUDE_CODE_DISABLE_1M_CONTEXT)
//   because the transcript records the published model id without the
//   internal `[1m]` suffix.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export type ContextSeverity = 'green' | 'soft' | 'yellow' | 'orange' | 'red';

export interface ThresholdTable {
  soft: number;
  yellow: number;
  orange: number;
  red: number;
}

export const THRESHOLDS_1M: ThresholdTable = { soft: 25, yellow: 35, orange: 42, red: 50 };
export const THRESHOLDS_200K: ThresholdTable = { soft: 50, yellow: 65, orange: 75, red: 85 };

export interface ContextUsage {
  agent: string;
  session_id: string;
  transcript_path: string;
  model: string;
  context_limit: number;
  current_loaded_tokens: number;
  pct: number;
  severity: ContextSeverity;
  next_action_threshold_pct: number | null;
  updated_at: string;
}

export interface RawTurnUsage {
  input_tokens: number;
  cache_creation: number;
  cache_read: number;
  model: string;
  session_id: string;
}

export function thresholdsFor(limit: number): ThresholdTable {
  return limit >= 1_000_000 ? THRESHOLDS_1M : THRESHOLDS_200K;
}

export function severityForPct(pct: number, table: ThresholdTable): ContextSeverity {
  if (pct >= table.red) return 'red';
  if (pct >= table.orange) return 'orange';
  if (pct >= table.yellow) return 'yellow';
  if (pct >= table.soft) return 'soft';
  return 'green';
}

export function nextActionThresholdPct(severity: ContextSeverity, table: ThresholdTable): number | null {
  switch (severity) {
    case 'green': return table.soft;
    case 'soft': return table.yellow;
    case 'yellow': return table.orange;
    case 'orange': return table.red;
    case 'red': return null;
  }
}

export function encodeCwdToProjectDir(cwd: string): string {
  // Claude Code converts forward slashes to dashes, leaves leading dash intact.
  return cwd.replace(/\//g, '-');
}

export function resolveContextLimit(env: NodeJS.ProcessEnv, modelHint: string): number {
  const flag = (env.CLAUDE_CODE_DISABLE_1M_CONTEXT ?? '').toLowerCase();
  const disabled = flag === 'true' || flag === '1' || flag === 'yes';
  const isOpus = /opus/i.test(modelHint);
  if (!disabled && isOpus) return 1_000_000;
  return 200_000;
}

export function findCurrentTranscriptPath(projectsRoot: string, cwd: string): string | null {
  const dir = join(projectsRoot, encodeCwdToProjectDir(cwd));
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  let bestPath: string | null = null;
  let bestMtime = -Infinity;
  for (const e of entries) {
    const p = join(dir, e);
    try {
      const st = statSync(p);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestPath = p;
      }
    } catch { /* skip unreadable */ }
  }
  return bestPath;
}

export function readLatestUsage(transcriptPath: string): RawTurnUsage | null {
  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
  // Walk lines from end-to-start; usage lives on assistant-typed records.
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== 'assistant') continue;
    const u = obj?.message?.usage;
    if (!u) continue;
    return {
      input_tokens: toNonNegInt(u.input_tokens),
      cache_creation: toNonNegInt(u.cache_creation_input_tokens),
      cache_read: toNonNegInt(u.cache_read_input_tokens),
      model: typeof obj?.message?.model === 'string' ? obj.message.model : '',
      session_id: typeof obj?.sessionId === 'string' ? obj.sessionId : '',
    };
  }
  return null;
}

function toNonNegInt(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export interface ComputeOptions {
  agent: string;
  cwd: string;
  projectsRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export function computeContextUsage(opts: ComputeOptions): ContextUsage | null {
  const projectsRoot = opts.projectsRoot ?? join(homedir(), '.claude', 'projects');
  const env = opts.env ?? process.env;
  const transcriptPath = findCurrentTranscriptPath(projectsRoot, opts.cwd);
  if (!transcriptPath) return null;
  const raw = readLatestUsage(transcriptPath);
  if (!raw) return null;
  const limit = resolveContextLimit(env, raw.model);
  const loaded = raw.input_tokens + raw.cache_creation + raw.cache_read;
  const pct = limit > 0 ? Math.round((loaded / limit) * 10000) / 100 : 0;
  const table = thresholdsFor(limit);
  const severity = severityForPct(pct, table);
  const ts = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    agent: opts.agent,
    session_id: raw.session_id,
    transcript_path: transcriptPath,
    model: raw.model,
    context_limit: limit,
    current_loaded_tokens: loaded,
    pct,
    severity,
    next_action_threshold_pct: nextActionThresholdPct(severity, table),
    updated_at: ts,
  };
}

export function writeContextUsage(stateDir: string, usage: ContextUsage): string {
  ensureDir(stateDir);
  const path = join(stateDir, 'context-pct.json');
  atomicWriteSync(path, JSON.stringify(usage));
  return path;
}
