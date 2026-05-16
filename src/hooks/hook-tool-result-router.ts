/**
 * hook-tool-result-router.ts — PostToolUse hook.
 *
 * Emits a single-line terminal-style status per tool call to Telegram,
 * plus the full payload to the dispatch-events stream (analytics/events/
 * {agent}/{date}.jsonl) for the dashboard activity feed.
 *
 * Telegram format (one line, ≤~80 chars where possible, no output dumps):
 *   🔨 Bash · npm test · pass (12s)
 *   📖 Read · server/services/phase-engine.ts:1-200
 *   ✏️ Edit · server/services/infer-rag.ts:310 (1 change)
 *   📝 Write · reports/foo.md (250 lines)
 *   🤖 Agent · architect · V1 vs V2 review · started
 *   ✅ Agent · architect · V1 vs V2 review · done (184s)
 *
 * Trivial / high-noise tool calls are suppressed (bus heartbeat, log-event,
 * cron-fire, memory/state reads). The hook never blocks execution — it always
 * exits 0 within its 10s settings.json timeout regardless of failures.
 */

import { readStdin, loadEnv } from './index.js';
import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';

const TELEGRAM_MAX = 200; // single-line wrap-safe cap

interface HookPayload {
  tool_name: string;
  tool_input: any;
  tool_response?: any;
  tool_result?: any;
}

/**
 * Parse the PostToolUse payload. Claude Code documents the result field
 * inconsistently across versions ("tool_response" in newer builds,
 * "tool_result" in older). Accept both.
 */
function parsePostToolPayload(input: string): HookPayload {
  try {
    const parsed = JSON.parse(input);
    return {
      tool_name: parsed.tool_name || 'unknown',
      tool_input: parsed.tool_input || {},
      tool_response: parsed.tool_response,
      tool_result: parsed.tool_result,
    };
  } catch {
    return { tool_name: 'unknown', tool_input: {} };
  }
}

/**
 * Tools that fire constantly as part of bus housekeeping. Surfacing them
 * would drown the activity feed and rate-limit Telegram.
 */
function isTrivial(toolName: string, toolInput: any): boolean {
  if (toolName === 'Bash') {
    const cmd = String(toolInput?.command || '');
    // Suppress: housekeeping, comm pass-throughs (sending a message = duplicate notification),
    // and task tracking (already visible via task list / dashboard).
    if (/cortextos\s+bus\s+(update-heartbeat|log-event|update-cron-fire|send-telegram|send-message|reply-telegram|reply-telegram-photo|ack-inbox|check-inbox|create-task|update-task|complete-task|update-cron-state)/.test(cmd)) {
      return true;
    }
    // Suppress: piped variants and `node dist/cli.js bus ...` invocations of the same commands.
    if (/(node\s+\S*cli\.js|cortextos)\s+bus\s+(send-telegram|send-message|reply-telegram|ack-inbox|create-task|update-task|complete-task)/.test(cmd)) {
      return true;
    }
  }
  if (toolName === 'Read') {
    const path = String(toolInput?.file_path || '');
    if (/state\/current-mission\.txt$/.test(path)) return true;
    if (/MEMORY[^/]*\.md$/i.test(path)) return true;
    if (/conversation-buffer\.jsonl$/.test(path)) return true;
    if (/HEARTBEAT\.md$/i.test(path)) return true;
  }
  return false;
}

/**
 * Shorten a file path for display. Keeps the last 3 path segments so the user
 * can identify the file without seeing the full repo prefix.
 */
function shortPath(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p.replace(/^\/?/, '');
  return parts.slice(-3).join('/');
}

/**
 * Squash a Bash command into a short, human-readable description. Tries to
 * pull out the meaningful verb (npm test, git push, bash bin/foo.sh, etc.)
 * and trims aggressively.
 */
function describeBash(cmd: string): string {
  const flat = cmd.replace(/\s+/g, ' ').trim();
  // Drop common noise prefixes
  const stripped = flat
    .replace(/^cd\s+\S+\s*&&\s*/, '')
    .replace(/^\s*\(\s*/, '')
    .replace(/\s*\)\s*$/, '');
  return stripped.length > 60 ? stripped.slice(0, 57) + '...' : stripped;
}

/**
 * Format a single-line summary line for the tool. The activity feed gets the
 * full payload separately; this is purely the human-facing Telegram line.
 */
function formatToolLine(
  toolName: string,
  toolInput: any,
  result: any,
): string {
  switch (toolName) {
    case 'Bash': {
      const cmd = String(toolInput?.command || '');
      const desc = describeBash(cmd);
      const status = bashStatus(result);
      return `🔨 Bash · ${desc} · ${status}`;
    }
    case 'Read': {
      const path = shortPath(String(toolInput?.file_path || ''));
      const offset = toolInput?.offset;
      const limit = toolInput?.limit;
      if (typeof offset === 'number' || typeof limit === 'number') {
        const start = typeof offset === 'number' ? offset : 1;
        const end = typeof limit === 'number' ? start + limit - 1 : '';
        return `📖 Read · ${path}:${start}${end !== '' ? '-' + end : ''}`;
      }
      return `📖 Read · ${path}`;
    }
    case 'Edit': {
      const path = shortPath(String(toolInput?.file_path || ''));
      const replaceAll = toolInput?.replace_all === true;
      const changes = replaceAll ? 'all' : '1';
      const lineHint = lineNumberFromEdit(toolInput);
      const where = lineHint ? `${path}:${lineHint}` : path;
      return `✏️ Edit · ${where} (${changes} change${changes === '1' ? '' : 's'})`;
    }
    case 'Write': {
      const path = shortPath(String(toolInput?.file_path || ''));
      const content = String(toolInput?.content || '');
      const lines = content ? content.split('\n').length : 0;
      return `📝 Write · ${path} (${lines} lines)`;
    }
    case 'NotebookEdit': {
      const path = shortPath(String(toolInput?.notebook_path || ''));
      return `📓 NotebookEdit · ${path}`;
    }
    case 'Glob': {
      const pattern = String(toolInput?.pattern || '').slice(0, 60);
      const matchCount = countLines(result);
      return `🔍 Glob · ${pattern}${matchCount ? ` (${matchCount} matches)` : ''}`;
    }
    case 'Grep': {
      const pattern = String(toolInput?.pattern || '').slice(0, 60);
      const matchCount = countLines(result);
      return `🔍 Grep · ${pattern}${matchCount ? ` (${matchCount} matches)` : ''}`;
    }
    case 'WebFetch': {
      const url = String(toolInput?.url || '').slice(0, 80);
      return `🌐 WebFetch · ${url}`;
    }
    case 'WebSearch': {
      const query = String(toolInput?.query || '').slice(0, 80);
      return `🌐 WebSearch · ${query}`;
    }
    case 'Task':
    case 'Agent': {
      const subtype = String(toolInput?.subagent_type || 'agent');
      const desc = String(toolInput?.description || '').slice(0, 60);
      // Agent calls in PostToolUse are "done" — the result is already back.
      const duration = agentDuration(result);
      const tail = duration ? `done (${duration})` : 'done';
      return `✅ Agent · ${subtype} · ${desc} · ${tail}`;
    }
    default:
      return `⚙️ ${toolName}`;
  }
}

/**
 * Best-effort: extract a line-number hint from an Edit call by looking at the
 * old_string for any line-number markers Claude Code prepends in its diffs.
 * Returns empty string if not found — the formatter falls back to the path.
 */
function lineNumberFromEdit(toolInput: any): string {
  const old = String(toolInput?.old_string || '');
  // Claude Code never injects line numbers into old_string itself, so we have
  // no reliable hint without re-reading the file. Leave blank.
  void old;
  return '';
}

/**
 * Render a Bash status: `pass`, `fail`, `pass (12s)`, `fail (3 lines stderr)`.
 * Duration comes from result.duration_ms when present.
 */
function bashStatus(result: any): string {
  if (result == null) return 'done';
  const exitCode =
    typeof result?.exit_code === 'number'
      ? result.exit_code
      : typeof result?.exitCode === 'number'
        ? result.exitCode
        : typeof result?.code === 'number'
          ? result.code
          : null;
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const durationMs =
    typeof result?.duration_ms === 'number'
      ? result.duration_ms
      : typeof result?.durationMs === 'number'
        ? result.durationMs
        : null;

  const ok = exitCode == null ? !/error|failed|fatal/i.test(stderr) : exitCode === 0;
  const durTag = durationMs != null ? ` (${formatDuration(durationMs)})` : '';
  if (ok) return `pass${durTag}`;
  const stderrLines = stderr ? stderr.split('\n').filter((l: string) => l.trim()).length : 0;
  if (stderrLines > 0) return `fail (${stderrLines} lines stderr)${durTag}`;
  return `fail${durTag}`;
}

/**
 * Render duration from milliseconds to short human form: 12s, 3m, 1h.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

/**
 * Best-effort: extract agent duration. Claude Code's Task tool result shape
 * is opaque, so we look for any duration field on the response and otherwise
 * return empty.
 */
function agentDuration(result: any): string {
  if (result == null) return '';
  const ms =
    typeof result?.duration_ms === 'number'
      ? result.duration_ms
      : typeof result?.totalDurationMs === 'number'
        ? result.totalDurationMs
        : null;
  return ms != null ? formatDuration(ms) : '';
}

/**
 * Count lines in a textual result (for Grep/Glob match summaries).
 */
function countLines(result: any): number {
  if (result == null) return 0;
  let text = '';
  if (typeof result === 'string') text = result;
  else if (typeof result?.content === 'string') text = result.content;
  else if (typeof result?.output === 'string') text = result.output;
  else if (typeof result?.stdout === 'string') text = result.stdout;
  if (!text) return 0;
  return text.split('\n').filter((l) => l.trim()).length;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const payload = parsePostToolPayload(input);
  const { tool_name, tool_input } = payload;

  if (!tool_name || tool_name === 'unknown') return;
  if (isTrivial(tool_name, tool_input)) return;

  const env = loadEnv();
  const agentName = env.agentName || 'agent';
  const org = process.env.CTX_ORG || '';

  const result = payload.tool_response ?? payload.tool_result;
  const line = formatToolLine(tool_name, tool_input, result);

  // 1. Activity feed (best-effort; never blocks). Keep the full payload here
  //    so the dashboard can render output dumps — Telegram never sees them.
  try {
    const paths = resolvePaths(agentName, env.ctxRoot.split('/').pop() || 'default', org);
    logEvent(paths, agentName, org, 'agent_activity', 'tool_result', 'info', {
      tool: tool_name,
      summary: line,
      tool_input: tool_input,
      tool_result: result,
    });
  } catch {
    // Activity feed is best-effort.
  }

  // 2. Telegram (best-effort; never blocks). One line, agent name prefix.
  if (!env.botToken || !env.chatId) return;

  const message = `[${agentName}] ${line}`.slice(0, TELEGRAM_MAX);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.chatId,
        text: message,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
  } catch {
    // Never fail — PostToolUse must not block the agent.
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(0));
