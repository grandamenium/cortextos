/**
 * StatusLine hook — primary real-time source for the context-discipline
 * monitor (BL-2026-05-08-004 Phase 2).
 *
 * Configured in settings.json as:
 *   "statusLine": { "type": "command", "command": "cortextos bus hook-context-status",
 *                   "refreshInterval": 5, "timeout": 2 }
 *
 * Claude Code pipes a JSON blob to stdin after every assistant turn (debounced
 * ~300ms) and on each refreshInterval tick. We extract the context_window block,
 * compute severity via the model-aware threshold tables in src/monitor/context-usage.ts,
 * and atomically write `context-pct.json` (single source of truth, schema shared
 * with the heartbeat-driven `cortextos bus context-update` CLI).
 *
 * The hook ALSO emits a `context_threshold_crossed` event when severity > green,
 * so the activity feed surfaces elevated context as it happens — not just at the
 * 4h heartbeat cycle.
 *
 * Must complete quickly, swallow all errors, and always exit 0 — a failed
 * statusLine hook blocks Claude Code's status bar rendering.
 */

import { statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import {
  usageFromStatusLine,
  writeContextUsage,
  type StatusLineInput,
} from '../monitor/context-usage.js';
import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  if (!agentName) return;

  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  const org = process.env.CTX_ORG || '';
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', instanceId);
  const stateDir = join(ctxRoot, 'state', agentName);
  const outPath = join(stateDir, 'context-pct.json');

  // Debounce: skip work if the file is younger than 500ms to avoid thrashing
  // during tool-call bursts. statusLine fires after each assistant turn AND on
  // refreshInterval ticks, so back-to-back invocations are common.
  try {
    const mtime = statSync(outPath).mtimeMs;
    if (Date.now() - mtime < 500) return;
  } catch { /* file doesn't exist yet — continue */ }

  // Read stdin (Claude Code pipes the statusLine JSON).
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
    // Timeout safety: don't block forever.
    setTimeout(resolve, 1500);
  });

  let data: StatusLineInput = {};
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch { return; }

  const usage = usageFromStatusLine({ agent: agentName, input: data });
  if (!usage) return;

  writeContextUsage(stateDir, usage);

  // Best-effort event emission on severity escalation. logEvent has its own
  // error handling internally; wrap defensively to ensure the hook still
  // exits 0 even if the event log can't be written.
  if (usage.severity !== 'green') {
    try {
      const paths = resolvePaths(agentName, instanceId, org);
      const sev = usage.severity === 'red'
        ? 'critical'
        : usage.severity === 'orange'
          ? 'warning'
          : 'info';
      logEvent(paths, agentName, org, 'context', 'context_threshold_crossed', sev, {
        severity: usage.severity,
        pct: usage.pct,
        loaded_tokens: usage.current_loaded_tokens,
        context_limit: usage.context_limit,
        model: usage.model,
        next_action_threshold_pct: usage.next_action_threshold_pct,
        source: 'statusline',
      });
    } catch { /* non-fatal */ }
  }
}

main().catch(() => process.exit(0));
