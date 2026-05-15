import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import { randomUUID } from 'crypto';

/**
 * Shared helpers for sidecar context compaction (Pattern 1).
 *
 * - Project-dir resolution mirrors AgentProcess.shouldContinue() exactly so
 *   the sidecar reads the same JSONL the agent is writing.
 * - JSONL parsing is tolerant: malformed/unknown lines are skipped.
 * - Redaction strips obvious secrets before any external API call or before
 *   the ledger doc is written to disk.
 */

export interface ParsedTurn {
  uuid: string;
  role: 'user' | 'assistant';
  contentText: string;
  estimatedTokens: number;
  rawLine: string;
}

/**
 * Build the Claude projects dir for a given agent directory. Mirrors
 * AgentProcess.shouldContinue() one-for-one so the sidecar and the
 * agent always agree on JSONL location.
 */
export function getAgentProjectDir(agentDir: string): string {
  const slug = agentDir.split(sep).join('-');
  return join(homedir(), '.claude', 'projects', slug);
}

/**
 * Find the most recently modified .jsonl file for an agent (the active session).
 */
export function findActiveJsonl(agentDir: string): string | null {
  const projectDir = getAgentProjectDir(agentDir);
  if (!existsSync(projectDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return null;
  }
  const files = entries
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      try {
        return { path: join(projectDir, f), mtime: statSync(join(projectDir, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].path : null;
}

/**
 * Extract a session UUID from a JSONL path (filename minus .jsonl).
 */
export function sessionIdFromJsonlPath(jsonlPath: string): string | null {
  const m = jsonlPath.match(/([a-f0-9-]+)\.jsonl$/i);
  return m ? m[1] : null;
}

const REDACTION_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
  { name: 'telegram-token',   re: /\d{8,12}:[A-Za-z0-9_\-]{35}/g,                                     replacement: '[TELEGRAM_TOKEN]' },
  { name: 'supabase-anon',    re: /eyJhbGciOiJIUzI1NiIsInR5cCI6Ikp[A-Za-z0-9_\-=]+/g,                  replacement: '[SUPABASE_KEY]' },
  { name: 'jwt',              re: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,         replacement: '[JWT]' },
  { name: 'cf-token',         re: /cfut_[A-Za-z0-9]{40,}/g,                                          replacement: '[CF_TOKEN]' },
  { name: 'resend-key',       re: /re_[A-Za-z0-9]{20,}/g,                                            replacement: '[RESEND_KEY]' },
  { name: 'ark-key',          re: /ark-[a-zA-Z0-9]{20,}/gi,                                          replacement: '[ARK_KEY]' },
  { name: 'email',            re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,                replacement: '[EMAIL]' },
  { name: 'api-key-generic',  re: /[A-Za-z0-9_\-]{20,}(?:key|token|secret|password)[A-Za-z0-9_\-]*/gi, replacement: '[REDACTED_KEY]' },
  { name: 'env-file-content', re: /(?:^|\n)[A-Z_]+=(?:"|')?[^\n"']{8,}(?:"|')?\n/gm,                  replacement: '\n[ENV_LINE_REDACTED]\n' },
];

export interface RedactResult {
  text: string;
  count: number;
}

/**
 * Apply secret-redaction patterns. Returns redacted text + count of
 * substitutions for audit logging.
 */
export function redact(text: string): string {
  return redactWithCount(text).text;
}

export function redactWithCount(text: string): RedactResult {
  let result = text;
  let count = 0;
  for (const { re, replacement } of REDACTION_PATTERNS) {
    result = result.replace(re, () => {
      count++;
      return replacement;
    });
  }
  return { text: result, count };
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type : '';
    if (type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : 'unknown';
      parts.push(`[tool: ${name}]`);
    } else if (type === 'tool_result') {
      const c = b.content;
      let s = '';
      if (typeof c === 'string') {
        s = c;
      } else if (Array.isArray(c)) {
        s = c
          .map(x => (x && typeof x === 'object' && typeof (x as Record<string, unknown>).text === 'string' ? (x as Record<string, string>).text : ''))
          .join(' ');
      }
      parts.push(`[result: ${s.slice(0, 200)}]`);
    } else if (type === 'image') {
      parts.push('[image omitted]');
    }
  }
  return parts.join('\n');
}

/**
 * Tolerant JSONL parser. Malformed/unknown records are skipped, never
 * throws. Returns parsed user/assistant turns with redacted content.
 */
export function parseJsonlTurns(jsonlPath: string): ParsedTurn[] {
  let raw = '';
  try {
    raw = readFileSync(jsonlPath, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const turns: ParsedTurn[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object') continue;
      const type = (record as Record<string, unknown>).type;
      if (type !== 'user' && type !== 'assistant') continue;
      const message = (record as Record<string, unknown>).message as Record<string, unknown> | undefined;
      if (!message || !('content' in message)) continue;
      const contentText = flattenContent(message.content);
      if (!contentText.trim()) continue;
      const redacted = redact(contentText);
      const uuid = typeof (record as Record<string, unknown>).uuid === 'string'
        ? ((record as Record<string, string>).uuid)
        : randomUUID();
      turns.push({
        uuid,
        role: type,
        contentText: redacted,
        estimatedTokens: Math.ceil(contentText.length / 4),
        rawLine: line,
      });
    } catch {
      // skip malformed line
    }
  }
  return turns;
}

/**
 * Inspect the raw JSONL line for the presence of a tool_use block
 * without an accompanying tool_result. Used by the safe-point gate.
 */
/**
 * Extract all tool_use IDs from a raw JSONL record's content array.
 */
function extractToolUseIds(rawLine: string): string[] {
  try {
    const r = JSON.parse(rawLine);
    const content = r?.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((b: unknown) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_use')
      .map((b: unknown) => (b as Record<string, unknown>).id)
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/**
 * Extract all tool_result.tool_use_id values from a raw JSONL record.
 */
function extractToolResultIds(rawLine: string): string[] {
  try {
    const r = JSON.parse(rawLine);
    const content = r?.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((b: unknown) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result')
      .map((b: unknown) => (b as Record<string, unknown>).tool_use_id)
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export function lastTurnHasPendingToolUse(rawLine: string): boolean {
  return extractToolUseIds(rawLine).length > 0;
}

/**
 * Safe-point check: the last assistant turn has no trailing tool_use, AND
 * every tool_use ID emitted across the session has a matching tool_result.
 * Uses ID-based matching to correctly handle parallel/multi-tool turns where
 * one call returns before another — index comparison cannot detect this case.
 */
export function isSafePoint(turns: ParsedTurn[]): boolean {
  if (turns.length === 0) return false;
  const last = turns[turns.length - 1];
  if (last.role !== 'assistant') return false;
  if (lastTurnHasPendingToolUse(last.rawLine)) return false;

  const pendingIds = new Set<string>();
  for (const turn of turns) {
    for (const id of extractToolUseIds(turn.rawLine)) {
      pendingIds.add(id);
    }
    for (const id of extractToolResultIds(turn.rawLine)) {
      pendingIds.delete(id);
    }
  }
  return pendingIds.size === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Minimal AgentProcess surface required by pauseForJsonlSnapshot.
 * Kept narrow so unit tests can mock with a plain object.
 */
export interface SnapshotAgentLike {
  getRuntime(): string | undefined;
  getChildPid(): number | null;
  getAgentDir(): string;
}

export type Logger = (msg: string) => void;

/**
 * Pause the agent's Claude PTY child via SIGSTOP, snapshot its active
 * JSONL to /tmp, then SIGCONT. Returns the snapshot path, or null when
 * the runtime/platform is unsupported, the PID is unknown, or the copy
 * fails.
 *
 * A 2s watchdog guarantees the child is resumed even on unhandled
 * exceptions in the surrounding try block.
 */
export async function pauseForJsonlSnapshot(
  agent: SnapshotAgentLike,
  log: Logger = () => {},
): Promise<string | null> {
  const runtime = agent.getRuntime()?.trim() || 'claude-code';
  if (runtime !== 'claude-code') {
    log(`[compactor] Skipping snapshot: runtime ${runtime} not supported in Phase 4`);
    return null;
  }
  if (process.platform === 'win32') {
    log('[compactor] Skipping SIGSTOP: not supported on Windows');
    return null;
  }
  const pid = agent.getChildPid();
  if (!pid || pid <= 0) {
    log('[compactor] Cannot pause: no valid child PID');
    return null;
  }

  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    try { process.kill(pid, 'SIGCONT'); } catch { /* pid gone */ }
    log('[compactor] WATCHDOG: force-resumed after 2s (pause exceeded limit)');
  }, 2_000);

  try {
    try {
      process.kill(pid, 'SIGSTOP');
    } catch (err) {
      log(`[compactor] SIGSTOP failed: ${err}`);
      return null;
    }
    await sleep(100);
    // If watchdog already fired during sleep, the process has resumed — snapshot would
    // be taken of a running process (potentially mid-write). Discard rather than risk
    // a partial ledger.
    if (watchdogFired) {
      log('[compactor] Watchdog fired before copy — snapshot discarded');
      return null;
    }
    const src = findActiveJsonl(agent.getAgentDir());
    if (!src) {
      log('[compactor] No active JSONL to snapshot');
      return null;
    }
    const dest = `/tmp/compaction-snapshot-${Date.now()}.jsonl`;
    try {
      copyFileSync(src, dest);
    } catch (err) {
      log(`[compactor] JSONL copy failed: ${err}`);
      return null;
    }
    if (watchdogFired) {
      log('[compactor] Watchdog fired during copy — snapshot may be partial, discarding');
      return null;
    }
    return dest;
  } catch (err) {
    log(`[compactor] pause/copy error: ${err}`);
    return null;
  } finally {
    clearTimeout(watchdog);
    try { process.kill(pid, 'SIGCONT'); } catch { /* pid gone is fine */ }
  }
}
