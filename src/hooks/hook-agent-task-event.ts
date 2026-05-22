/**
 * PostToolUse hook: emit a STACK-17 task event for the active task and append
 * a live-state log entry so the Agent Cockpit panel shows real-time progress
 * for direct (non-Codex) agent sessions.
 *
 * The hook intentionally no-ops when CTX_TASK_ID is missing so it can be
 * installed globally without generating unscoped noise.
 *
 * REGISTRATION RULE: Register this hook in exactly ONE PostToolUse chain —
 * either cortextos agent settings OR rgos dist, never both. Dual registration
 * causes every tool call to emit two events for the same task, doubling the
 * event stream. Canonical location: cortextos agent settings.json PostToolUse.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { emitAgentTaskEvent } from '../bus/agent-task-events.js';
import { appendAgentLiveLog, createAgentLiveStateHandle, mirrorAgentLiveState } from '../bus/agent-live-state.js';
import { resolveEnv } from '../utils/env.js';
import { formatToolSummary, parseHookInput, readStdin } from './index.js';

function truncate(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function readHookJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function resultPreview(hookJson: Record<string, unknown>): string {
  const candidates = [
    hookJson.tool_response,
    hookJson.tool_result,
    hookJson.result,
    hookJson.output,
  ];
  const found = candidates.find((value) => value != null);
  if (typeof found === 'string') return truncate(found);
  if (found != null) return truncate(JSON.stringify(found));
  return '';
}

async function emitSubagentStartIfNeeded(env = resolveEnv(), taskId: string): Promise<void> {
  const subagentId = process.env.CTX_SUBAGENT_ID;
  if (!subagentId) return;

  const stateDir = join(env.ctxRoot, 'state', env.agentName, 'agent-task-events');
  const markerPath = join(stateDir, `${taskId}-${subagentId}.started`);
  if (existsSync(markerPath)) return;

  mkdirSync(stateDir, { recursive: true });
  await emitAgentTaskEvent(env, taskId, 'subagent_start', {
    subagent_id: subagentId,
    parent_agent_id: env.agentName,
    label: process.env.CTX_SUBAGENT_LABEL || subagentId,
  });
  writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
}

// Mirror throttle: max one Supabase upload per 15 seconds per task.
// Uses a small timestamp file in the live-state dir so separate hook processes share state.
function shouldMirrorNow(dir: string): boolean {
  const markerPath = join(dir, 'last-live-mirror.txt');
  try {
    const ts = parseInt(readFileSync(markerPath, 'utf-8').trim(), 10);
    if (!isNaN(ts) && Date.now() - ts < 15_000) return false;
  } catch {
    // File doesn't exist yet — first mirror
  }
  writeFileSync(markerPath, String(Date.now()), 'utf-8');
  return true;
}

async function main(): Promise<void> {
  const taskId = process.env.CTX_TASK_ID;
  if (!taskId) return;

  const input = await readStdin();
  const hookJson = readHookJson(input);
  const { tool_name, tool_input } = parseHookInput(input);
  const env = resolveEnv();

  await emitSubagentStartIfNeeded(env, taskId);
  const outputPreview = resultPreview(hookJson) || formatToolSummary(tool_name, tool_input);
  await emitAgentTaskEvent(env, taskId, 'tool_call_result', {
    call_id: String(hookJson.tool_use_id || hookJson.call_id || `${tool_name}:${Date.now()}`),
    tool: tool_name,
    output_preview: outputPreview,
    is_error: Boolean(hookJson.is_error || hookJson.error),
  });

  // Append to agent live log so Agent Cockpit shows progress for direct sessions.
  const liveState = createAgentLiveStateHandle({ ctxRoot: env.ctxRoot, org: env.org, agent: env.agentName, taskId });
  if (liveState) {
    const isError = Boolean(hookJson.is_error || hookJson.error);
    const prefix = isError ? '[ERR]' : '[ ok]';
    const line = `${new Date().toISOString()} ${prefix} ${tool_name}: ${outputPreview.slice(0, 200)}\n`;
    appendAgentLiveLog(liveState, line);
    if (shouldMirrorNow(liveState.dir)) {
      await mirrorAgentLiveState(liveState);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`hook-agent-task-event error: ${(err as Error).message}\n`);
  process.exit(0);
});
