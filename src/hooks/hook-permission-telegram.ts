
/**
 * hook-permission-telegram.ts - Blocking PermissionRequest hook
 * Forwards permission prompts to Telegram with Approve/Deny inline buttons.
 * Polls for a response file written by fast-checker when the user taps a button.
 * Timeout: 1800s (30 min, deny by default).
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
  generateId,
  formatToolSummary,
  isClaudeDirOperation,
  sanitizeCodeBlock,
  buildPermissionKeyboard,
  cleanupResponseFile,
} from './index';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  // ExitPlanMode and AskUserQuestion are handled by other hooks
  if (tool_name === 'ExitPlanMode' || tool_name === 'AskUserQuestion') {
    process.exit(0);
  }

  const env = loadEnv();

  if (!env.botToken || !env.chatId) {
    outputDecision('deny', 'No Telegram credentials configured for remote approval');
    return;
  }

  // Auto-approve .claude/ directory writes
  if (isClaudeDirOperation(tool_name, tool_input)) {
    outputDecision('allow');
    return;
  }

  // Build human-readable summary
  const summary = formatToolSummary(tool_name, tool_input);

  // Generate unique ID
  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

  // Register cleanup
  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  // Build message
  let message = `PERMISSION REQUEST\nAgent: ${env.agentName}\nTool: ${tool_name}\n\n\`\`\`\n${sanitizeCodeBlock(summary)}\n\`\`\``;

  // Truncate if over limit
  if (message.length > 3800) {
    message = message.slice(0, 3800) + '...(truncated)';
  }

  const keyboard = buildPermissionKeyboard(uniqueId);
  const api = new TelegramAPI(env.botToken);

  try {
    await api.sendMessage(env.chatId, message, keyboard);
  } catch {
    outputDecision('deny', 'Failed to send permission request to Telegram');
    return;
  }

  // Poll for response (30 min timeout) with exponential backoff
  // Starts at 500ms, doubles each poll up to a cap of 5000ms, then stays at 5s
  const TIMEOUT_MS = 1800 * 1000;
  const POLL_START_MS = 500;
  const POLL_CAP_MS = 5000;
  const content = await new Promise<string | null>((resolve) => {
    let elapsed = 0;
    let delay = POLL_START_MS;

    const poll = () => {
      if (elapsed >= TIMEOUT_MS) {
        resolve(null);
        return;
      }
      try {
        if (existsSync(responseFile)) {
          resolve(readFileSync(responseFile, 'utf-8'));
          return;
        }
      } catch {
        // File might be mid-write, retry on next poll
      }
      elapsed += delay;
      const next = Math.min(delay * 2, POLL_CAP_MS);
      delay = next;
      setTimeout(poll, delay);
    };

    poll();
  });

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
    // Timeout - deny and notify
    try {
      await api.sendMessage(
        env.chatId,
        `Permission request TIMED OUT (auto-denied): ${tool_name}`,
      );
    } catch {
      // Ignore notification failure
    }
    outputDecision('deny', 'Timed out waiting for Telegram approval (30m)');
  }
}

main().catch((err) => {
  process.stderr.write(`hook-permission-telegram error: ${err}\n`);
  outputDecision('deny', `Hook error: ${err}`);
});
