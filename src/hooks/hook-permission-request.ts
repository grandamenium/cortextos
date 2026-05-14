/**
 * hook-permission-request.ts — Blocking PermissionRequest hook.
 *
 * Tool-class-aware decision:
 *   - Safe read-only tools (Read/Glob/Grep/LS/NotebookRead) → auto-allow.
 *   - Other tools → if connector is configured AND credentials valid,
 *     forward to the connector (Approve/Deny buttons + 30-min timeout).
 *     If no connector OR creds invalid, exit 0 with no JSON output —
 *     Claude Code's hook framework falls through to the built-in
 *     terminal permission prompt.
 *   - `AgentConfig.require_remote_approval === true` restores the
 *     pre-PR2 deny-by-default behavior for the no-connector case (the
 *     operator escape hatch for strict-mode security).
 *
 * Renamed from `hook-permission-telegram.ts` in PR2 of the pluggable
 * communications connectors stack. The old file at that path remains
 * as a 1-line shim for backwards compat; the `cortextos bus
 * hook-permission-telegram` CLI subcommand also remains as an alias.
 *
 * `@pin claude-code v1.x` — the exit-0-no-output pass-through pattern
 * is a Claude Code hook framework behavior we don't control. If
 * Anthropic changes hook semantics in a future release, the
 * `tests/hooks/hook-permission-request-exit-zero-passthrough.test.ts`
 * test catches it at upgrade time. Exact version pin is set during
 * PR2 implementation against the maintainer's current Claude Code dep.
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
  generateId,
  waitForResponseFile,
  formatToolSummary,
  isClaudeDirOperation,
  sanitizeCodeBlock,
  buildPermissionKeyboard,
  cleanupResponseFile,
  readAgentConfig,
} from './index';
import { join } from 'path';
import { mkdirSync } from 'fs';

/**
 * Tools considered safe enough to auto-allow without a remote-approval
 * channel. Match the principle behind the existing `.claude/` auto-allow
 * check at line `isClaudeDirOperation` — read-only access to local
 * filesystem + structured search. These tools cannot mutate state,
 * touch the network, or spawn processes.
 */
const SAFE_AUTO_ALLOW = new Set<string>([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
]);

export async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  // ExitPlanMode and AskUserQuestion are handled by other hooks
  if (tool_name === 'ExitPlanMode' || tool_name === 'AskUserQuestion') {
    process.exit(0);
  }

  const env = loadEnv();
  const config = readAgentConfig();
  const strict = config?.require_remote_approval === true;
  const noCreds = !env.botToken || !env.chatId;

  // Auto-approve .claude/ directory writes (preserved from
  // hook-permission-telegram pre-PR2 behavior)
  if (isClaudeDirOperation(tool_name, tool_input)) {
    outputDecision('allow');
    return;
  }

  if (noCreds) {
    if (strict) {
      // Operator opt-in: strict-mode keeps deny-by-default for the no-
      // remote-channel case. Pre-PR2 behavior.
      outputDecision('deny', 'No remote approval channel configured (require_remote_approval=true)');
      return;
    }
    if (SAFE_AUTO_ALLOW.has(tool_name)) {
      // Read-only tools are safe to allow without remote approval.
      outputDecision('allow');
      return;
    }
    // Write/exec/network tools: pass-through to Claude Code's built-in
    // terminal permission prompt. The hook framework treats exit-0 with
    // no JSON output as "no decision — use default."
    process.exit(0);
  }

  // Credentials present → today's Telegram approval flow.
  const summary = formatToolSummary(tool_name, tool_input);
  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  let message = `PERMISSION REQUEST\nAgent: ${env.agentName}\nTool: ${tool_name}\n\n\`\`\`\n${sanitizeCodeBlock(summary)}\n\`\`\``;
  if (message.length > 3800) {
    message = message.slice(0, 3800) + '...(truncated)';
  }

  const keyboard = buildPermissionKeyboard(uniqueId);
  const api = new TelegramAPI(env.botToken!);

  try {
    await api.sendMessage(env.chatId!, message, keyboard);
  } catch {
    // Send failed — graceful fallback matching the no-creds path above:
    // safe tools allow, others pass through. Avoids spurious denial when
    // Telegram is briefly unreachable.
    if (SAFE_AUTO_ALLOW.has(tool_name)) {
      outputDecision('allow');
      return;
    }
    process.exit(0);
  }

  // Poll for response (30 min timeout)
  const TIMEOUT_MS = 1800 * 1000;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);

  if (content !== null) {
    try {
      const response = JSON.parse(content);
      const decision = response.decision || 'deny';
      if (decision === 'allow') {
        outputDecision('allow');
      } else {
        outputDecision('deny', 'Denied by user via Telegram');
      }
    } catch {
      outputDecision('deny', 'Invalid response file');
    }
  } else {
    try {
      await api.sendMessage(
        env.chatId!,
        `Permission request TIMED OUT (auto-denied): ${tool_name}`,
      );
    } catch {
      // Ignore notification failure
    }
    outputDecision('deny', 'Timed out waiting for Telegram approval (30m)');
  }
}

// CommonJS self-execution guard. tsup builds CommonJS output, so
// `require.main === module` is the reliable guard. ESM `import.meta.url`
// patterns are silently dead in the built dist/hooks/*.js output.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`hook-permission-request error: ${err}\n`);
    outputDecision('deny', `Hook error: ${err}`);
  });
}
