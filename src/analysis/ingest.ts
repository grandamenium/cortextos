// Ingest raw token logs into TurnFact rows.
//
// Sources:
//   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl     — Claude Code session transcripts
//   <ctxRoot>/logs/<agent>/codex-tokens.jsonl         — Codex token-usage log
//
// Output: TurnFact[] (one per assistant turn), with per-turn attribution
// (tools_used, files_touched, bash_verbs, subagents_spawned) and the WHY
// chain stubbed to 'unknown' (Phase 2 fills it in via trigger-resolution).

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { costBreakdown } from './pricing.js';
import type { TurnFact, ToolUse, Runtime } from './types.js';
import { extractClaudeOpeners, type SessionOpener } from './trigger-resolution.js';

// Reimplementation of src/monitor/context-usage.ts:encodeCwdToProjectDir.
// Done locally to avoid editing that upstream file — the merge surface stays
// zero at the cost of ~3 lines.
function encodeCwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export interface AgentPathHint {
  /** Working directory the agent runs in (used to find the encoded Claude projects dir). */
  cwd: string;
  /** Logical agent name. */
  name: string;
}

export interface IngestOpts {
  since: Date;
  until: Date;
  ctxRoot: string;
  /**
   * Agents to scan for codex logs + claude projects. Each entry pairs the
   * agent name with the working directory used by `~/.claude/projects/` path
   * encoding. Pass the result of bus/agents.ts:listAllAgentDirs() or similar.
   */
  agents: AgentPathHint[];
  /** Where to source claude projects from — defaults to ~/.claude/projects. */
  claudeProjectsDir?: string;
  /** Audit run id stamped onto every emitted TurnFact. */
  auditRunId: string;
  /** Per-turn raw content max chars retained for attribution (default 4096). */
  contentMaxChars?: number;
}

interface ClaudeMessage {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  isSidechain?: boolean;
  timestamp?: string;
  type?: string;
  message?: ClaudeMessageBody;
}

interface ClaudeMessageBody {
  id?: string;
  model?: string;
  role?: string;
  content?: Array<Record<string, unknown>> | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface CodexTokenLine {
  timestamp?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  session_id?: string;
  turn_id?: string;
}

// --- Claude ingest ----------------------------------------------------------

function extractToolsAndFiles(content: ClaudeMessageBody['content']): {
  tools: ToolUse[];
  files: string[];
  bashVerbs: string[];
  subagents: string[];
} {
  const tools: ToolUse[] = [];
  const files: string[] = [];
  const bashVerbs: string[] = [];
  const subagents: string[] = [];

  if (!Array.isArray(content)) return { tools, files, bashVerbs, subagents };

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool_use') continue;
    const name = typeof block.name === 'string' ? block.name : 'unknown';
    const input = (block.input ?? {}) as Record<string, unknown>;
    const inputJson = JSON.stringify(input);
    const tu: ToolUse = { name, input_chars: inputJson.length };

    if (name === 'Read' || name === 'Edit' || name === 'Write') {
      const fp = typeof input.file_path === 'string' ? input.file_path : undefined;
      if (fp) {
        tu.file_path = fp;
        files.push(fp);
      }
    } else if (name === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command : undefined;
      if (cmd) {
        tu.command = cmd.slice(0, 200);
        const firstWord = cmd.trim().split(/\s+/)[0] ?? '';
        if (firstWord) bashVerbs.push(firstWord);
      }
    } else if (name === 'Agent') {
      const sa = typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
      if (sa) {
        tu.subagent_type = sa;
        subagents.push(sa);
      }
    } else if (name === 'Grep' || name === 'Glob') {
      const pat = typeof input.pattern === 'string' ? input.pattern : undefined;
      if (pat) tu.pattern = pat.slice(0, 200);
    }
    tools.push(tu);
  }

  return { tools, files, bashVerbs, subagents };
}

export function parseClaudeTranscript(
  filePath: string,
  agent: string,
  auditRunId: string,
  since: Date,
  until: Date,
): TurnFact[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const out: TurnFact[] = [];
  const sinceMs = since.getTime();
  const untilMs = until.getTime();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: ClaudeMessage;
    try {
      entry = JSON.parse(line) as ClaudeMessage;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg) continue;
    if (msg.role !== 'assistant') continue;

    const ts = entry.timestamp ?? new Date().toISOString();
    const tsMs = new Date(ts).getTime();
    if (!Number.isFinite(tsMs) || tsMs < sinceMs || tsMs > untilMs) continue;

    const model = msg.model ?? 'unknown';
    const usage = msg.usage ?? {};
    const input_tokens = usage.input_tokens ?? 0;
    const output_tokens = usage.output_tokens ?? 0;
    const cache_write = usage.cache_creation_input_tokens ?? 0;
    const cache_read = usage.cache_read_input_tokens ?? 0;
    if (input_tokens === 0 && output_tokens === 0 && cache_write === 0 && cache_read === 0) continue;

    const session_id = entry.sessionId ?? 'unknown';
    const messageUuid = entry.uuid ?? msg.id ?? `${session_id}-${tsMs}`;
    const turn_id = `${agent}::${session_id}::${messageUuid}`;

    const cb = costBreakdown(model, input_tokens, output_tokens, cache_write, cache_read);
    const attr = extractToolsAndFiles(msg.content);

    out.push({
      turn_id,
      agent,
      runtime: 'claude' as Runtime,
      session_id,
      ts,
      model,
      input_tokens,
      output_tokens,
      cache_read,
      cache_write,
      ...cb,
      is_sidechain: entry.isSidechain === true,
      trigger_kind: 'unknown',
      trigger_name: null,
      trigger_prompt: null,
      session_opener: null,
      parent_session: entry.parentUuid ?? null,
      tools_used: attr.tools,
      files_touched: dedupe(attr.files),
      bash_verbs: dedupe(attr.bashVerbs),
      subagents_spawned: dedupe(attr.subagents),
      audit_run_id: auditRunId,
      source_file: filePath,
    });
  }

  return out;
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

export function scanClaudeProjects(opts: IngestOpts): { turns: TurnFact[]; openers: SessionOpener[] } {
  const projectsRoot = opts.claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsRoot)) return { turns: [], openers: [] };

  const turns: TurnFact[] = [];
  const openers: SessionOpener[] = [];
  for (const agent of opts.agents) {
    const encoded = encodeCwdToProjectDir(agent.cwd);
    const dir = join(projectsRoot, encoded);
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = join(dir, f);
      try {
        const st = statSync(fp);
        if (st.mtimeMs < opts.since.getTime()) continue;
      } catch {
        continue;
      }
      turns.push(...parseClaudeTranscript(fp, agent.name, opts.auditRunId, opts.since, opts.until));
      openers.push(...extractClaudeOpeners(fp, agent.name));
    }
  }
  return { turns, openers };
}

// --- Codex ingest -----------------------------------------------------------

export function parseCodexLog(
  filePath: string,
  agent: string,
  auditRunId: string,
  since: Date,
  until: Date,
): TurnFact[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const out: TurnFact[] = [];
  // dedupe within a single ingest pass — appendCodexTokenLog can re-emit on reconnection.
  const seen = new Set<string>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: CodexTokenLine;
    try {
      entry = JSON.parse(line) as CodexTokenLine;
    } catch {
      continue;
    }
    const model = entry.model;
    if (!model) continue;
    const ts = entry.timestamp ?? new Date().toISOString();
    const tsMs = new Date(ts).getTime();
    if (!Number.isFinite(tsMs) || tsMs < sinceMs || tsMs > untilMs) continue;

    const session_id = entry.session_id ?? 'unknown';
    const turnId = entry.turn_id ?? `${session_id}-${tsMs}`;
    const dedupKey = `${session_id}::${turnId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const input_tokens = entry.input_tokens ?? 0;
    const output_tokens = entry.output_tokens ?? 0;
    const cache_read = entry.cache_read_tokens ?? 0;
    const cache_write = entry.cache_write_tokens ?? 0;
    if (input_tokens === 0 && output_tokens === 0 && cache_read === 0 && cache_write === 0) continue;

    const cb = costBreakdown(model, input_tokens, output_tokens, cache_write, cache_read);

    out.push({
      turn_id: `${agent}::${session_id}::${turnId}`,
      agent,
      runtime: 'codex' as Runtime,
      session_id,
      ts,
      model,
      input_tokens,
      output_tokens,
      cache_read,
      cache_write,
      ...cb,
      is_sidechain: false,
      trigger_kind: 'unknown',
      trigger_name: null,
      trigger_prompt: null,
      session_opener: null,
      parent_session: null,
      tools_used: [],
      files_touched: [],
      bash_verbs: [],
      subagents_spawned: [],
      audit_run_id: auditRunId,
      source_file: filePath,
    });
  }
  return out;
}

export function scanCodexLogs(opts: IngestOpts): TurnFact[] {
  const out: TurnFact[] = [];
  for (const agent of opts.agents) {
    const fp = join(opts.ctxRoot, 'logs', agent.name, 'codex-tokens.jsonl');
    if (!existsSync(fp)) continue;
    out.push(...parseCodexLog(fp, agent.name, opts.auditRunId, opts.since, opts.until));
  }
  return out;
}

// --- Combined ingest --------------------------------------------------------

export function ingestAll(opts: IngestOpts): { turns: TurnFact[]; openers: SessionOpener[] } {
  const claude = scanClaudeProjects(opts);
  const codex = scanCodexLogs(opts);
  // De-dupe by turn_id (composite primary key).
  const seen = new Set<string>();
  const out: TurnFact[] = [];
  for (const t of [...claude.turns, ...codex]) {
    if (seen.has(t.turn_id)) continue;
    seen.add(t.turn_id);
    out.push(t);
  }
  return { turns: out, openers: claude.openers };
}
