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

// Detect 1M-context vs 200k tier from environment + observed model id.
//
// IMPORTANT: this intentionally diverges from the literal code snippet in the
// BL-004 spec (which keys on a `[1m]` suffix on the model id). Per the
// `harness-internal model-variant IDs` micro-retro in
// `.claude/rules/code-quality.md`, the `[1m]` suffix is an INTERNAL marker
// resolved by the Claude Code CLI; it is NOT carried in the transcript's
// `message.model` field nor passable through user config. The canonical 1M
// flip is `CLAUDE_CODE_DISABLE_1M_CONTEXT` (true/false) on the spawned PTY's
// env, set per agent via the daemon. The spec snippet was written assuming
// the suffix appears in transcripts; it does not.
//
// Resolution policy (matches today's fleet defaults):
//   - Opus + flag absent/false  → 1M (boss / engineer / analyst / fullstack)
//   - Opus + flag true          → 200k (explicit opt-out)
//   - Sonnet / Haiku / unknown  → 200k
//
// If you deploy an Opus agent that should be on 200k, you MUST set
// CLAUDE_CODE_DISABLE_1M_CONTEXT=true in its `.env` file. The daemon's PTY
// spawn path sources `.env` into the spawned Claude Code process and into
// any subprocess invoked from heartbeat (including `cortextos bus
// context-update`). There is no transcript-side signal to disambiguate, so
// the env flag IS the authoritative input. The `cortextos add-agent`
// scaffolder writes `# CLAUDE_CODE_DISABLE_1M_CONTEXT=true` as a
// commented-out template line in generated `.env`s; flipping a live agent
// off Opus-1M means uncommenting it by hand and restarting the agent.
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

// Find the most recent assistant turn's usage by walking the transcript
// in reverse. This loads the whole file into memory; for the Phase 1
// heartbeat-poll cadence (~4h) and current ~500KB transcripts the cost is
// trivial (~1ms). If/when the Phase 2 PostToolUse hook fires per-tool-call
// and transcripts grow into the multi-MB range, swap to a streaming
// reverse reader (read tail blocks, split on newlines, parse last assistant turn).
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

// ---------------------------------------------------------------------------
// statusLine entry point — Phase 2 of BL-2026-05-08-004.
//
// Claude Code's `statusLine` hook receives a JSON blob on stdin after every
// assistant turn (debounced ~300ms) plus on each refreshInterval tick. The
// blob includes a `context_window` block with Claude-Code-authoritative
// `context_window_size` and `current_usage` fields. Computing severity from
// these is more reliable than re-deriving from the transcript JSONL because:
// - context_window_size is reported directly by Claude Code (no env-flag
//   heuristic needed; works even if CLAUDE_CODE_DISABLE_1M_CONTEXT is unset
//   on a 200k-deployment Opus agent).
// - current_usage is computed by the API, not by us re-walking the transcript.
//
// This function is the PRIMARY data source post-Phase 2; the transcript-tail
// path in computeContextUsage() above remains as a fallback for the
// `cortextos bus context-update` CLI when no statusLine input is available
// (e.g. heartbeat-driven poll without a recent assistant turn).
// ---------------------------------------------------------------------------

export interface StatusLineInput {
  context_window?: {
    used_percentage?: number | null;
    context_window_size?: number | null;
    exceeds_200k_tokens?: boolean;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id?: string;
  model?: string;
}

export interface StatusLineUsageOptions {
  agent: string;
  input: StatusLineInput;
  now?: Date;
  /**
   * Fallback context limit used only when `context_window.context_window_size`
   * is missing from the statusLine blob. Defaults to 200_000 (the safer of
   * the two — over-reports severity rather than under-reports).
   */
  fallbackLimit?: number;
}

export function usageFromStatusLine(opts: StatusLineUsageOptions): ContextUsage | null {
  const cw = opts.input.context_window;
  if (!cw) return null;

  const cu = cw.current_usage ?? {};
  const inputTok = toNonNegInt(cu.input_tokens);
  const cacheCreation = toNonNegInt(cu.cache_creation_input_tokens);
  const cacheRead = toNonNegInt(cu.cache_read_input_tokens);
  const loaded = inputTok + cacheCreation + cacheRead;

  const reportedLimit = Number(cw.context_window_size);
  const limit = Number.isFinite(reportedLimit) && reportedLimit > 0
    ? Math.floor(reportedLimit)
    : (opts.fallbackLimit ?? 200_000);

  // Prefer Claude-Code-reported used_percentage when present and finite;
  // fall back to our own (loaded / limit) computation. They should agree to
  // within rounding when both are derivable.
  const reportedPct = Number(cw.used_percentage);
  const pct = Number.isFinite(reportedPct)
    ? Math.round(reportedPct * 100) / 100
    : (limit > 0 ? Math.round((loaded / limit) * 10000) / 100 : 0);

  const table = thresholdsFor(limit);
  const severity = severityForPct(pct, table);
  const ts = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');

  return {
    agent: opts.agent,
    session_id: typeof opts.input.session_id === 'string' ? opts.input.session_id : '',
    // statusLine doesn't carry a transcript path; use a sentinel that callers
    // can grep for if forensic context is needed.
    transcript_path: 'statusline://current-session',
    model: typeof opts.input.model === 'string' ? opts.input.model : '',
    context_limit: limit,
    current_loaded_tokens: loaded,
    pct,
    severity,
    next_action_threshold_pct: nextActionThresholdPct(severity, table),
    updated_at: ts,
  };
}

export function writeContextUsage(stateDir: string, usage: ContextUsage): string {
  // ensureDir is idempotent (mkdir recursive) and atomicWriteSync also creates
  // the parent dir. The explicit ensureDir here is defensive — keeps the failure
  // mode obvious if stateDir resolution is broken upstream.
  ensureDir(stateDir);
  const path = join(stateDir, 'context-pct.json');
  atomicWriteSync(path, JSON.stringify(usage));
  return path;
}
