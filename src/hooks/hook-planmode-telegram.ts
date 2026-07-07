
/**
 * hook-planmode-telegram.ts - ExitPlanMode PermissionRequest hook
 * Reads the plan file, sends it to Telegram with Approve/Deny buttons.
 * Timeout: 1800s (30 min), auto-APPROVES so agents aren't blocked if user is away.
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
  generateId,
  waitForResponseFile,
  buildPlanKeyboard,
  cleanupResponseFile,
  resolveCustomerBoxTarget,
} from './index';
import { join } from 'path';
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';

/**
 * Find the most recent plan file in ~/.claude/plans/
 */
function findMostRecentPlan(): string | null {
  const plansDir = join(homedir(), '.claude', 'plans');
  if (!existsSync(plansDir)) return null;

  try {
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: f,
        path: join(plansDir, f),
        mtime: statSync(join(plansDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Read plan content (first 100 lines).
 */
function readPlanContent(planPath: string): string {
  try {
    const content = readFileSync(planPath, 'utf-8');
    const lines = content.split('\n').slice(0, 100);
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

  const env = loadEnv();

  if (!env.botToken || !env.chatId) {
    outputDecision('allow');
    return;
  }

  // Customer-box noise suppression + operator routing (mirrors hook-crash-alert.ts).
  // allowOperatorBotToken:false — Approve/Deny callback queries are only ever
  // received by THIS agent's own bot poller, which the daemon starts only when
  // primary BOT_TOKEN+CHAT_ID are both present (already confirmed above). A
  // distinct OPERATOR_BOT_TOKEN has no poller listening on it, so the token
  // here always stays the primary bot — only the destination CHAT_ID redirects.
  // Fail-closed auto-APPROVE is IMMEDIATE — no 30-min wait — since there is no
  // one on the customer's own chat who could ever review this, and auto-approve
  // is this hook's existing safe default so the agent is never blocked.
  const target = resolveCustomerBoxTarget(env.botToken, env.chatId, { allowOperatorBotToken: false });
  if (!target) {
    outputDecision('allow');
    return;
  }
  const sendToken = target.token;
  const sendChat = target.chatId;

  // Find plan file
  let planPath = tool_input.plan_file || '';
  if (!planPath) {
    planPath = findMostRecentPlan() || '';
  }

  // Read plan content
  let planContent = '';
  if (planPath && existsSync(planPath)) {
    planContent = readPlanContent(planPath);
  }

  if (!planContent) {
    planContent = '(Plan file not found or empty)';
  }

  // Truncate to fit Telegram limits
  if (planContent.length > 3600) {
    planContent = planContent.slice(0, 3600) + '...(truncated)';
  }

  // Generate unique ID
  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

  // Register cleanup
  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  const messageText = `PLAN REVIEW - ${env.agentName}\n\n${planContent}`;
  const keyboard = buildPlanKeyboard(uniqueId);
  const api = new TelegramAPI(sendToken);

  try {
    await api.sendMessage(sendChat, messageText, keyboard);
  } catch {
    // If send fails, auto-approve so agent isn't blocked
    outputDecision('allow');
    return;
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
        outputDecision('deny', 'Plan denied by user via Telegram. Ask what they want to change.');
      }
    } catch {
      outputDecision('allow');
    }
  } else {
    // Timeout - auto-APPROVE (not deny!) so agents aren't blocked
    try {
      await api.sendMessage(
        sendChat,
        `Plan review TIMED OUT (auto-approved): ${env.agentName}`,
      );
    } catch {
      // Ignore notification failure
    }
    outputDecision('allow');
  }
}

main().catch((err) => {
  process.stderr.write(`hook-planmode-telegram error: ${err}\n`);
  outputDecision('allow');
});
