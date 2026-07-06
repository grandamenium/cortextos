
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
} from './index';
import { join } from 'path';
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';

export interface PlanDecisionResult {
  decision: 'allow' | 'deny';
  reason?: string;
}

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

export function resolvePlanDecision(content: string | null): PlanDecisionResult {
  if (content === null) {
    return { decision: 'allow' };
  }

  try {
    const response = JSON.parse(content) as { decision?: string };
    const decision = response.decision || 'deny';
    if (decision === 'allow') {
      return { decision: 'allow' };
    }
    return {
      decision: 'deny',
      reason: 'Plan denied by user via Telegram. Ask what they want to change.',
    };
  } catch {
    return {
      decision: 'deny',
      reason: 'Plan approval response was unreadable — denying for safety. Re-plan.',
    };
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
  const api = new TelegramAPI(env.botToken);

  try {
    await api.sendMessage(env.chatId, messageText, keyboard);
  } catch {
    // If send fails, auto-approve so agent isn't blocked
    outputDecision('allow');
    return;
  }

  // Poll for response (30 min timeout)
  const TIMEOUT_MS = 1800 * 1000;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);

  if (content !== null) {
    const decision = resolvePlanDecision(content);
    if (decision.decision === 'allow') {
      outputDecision('allow');
    } else {
      outputDecision('deny', decision.reason);
    }
  } else {
    // Timeout - auto-APPROVE (not deny!) so agents aren't blocked
    try {
      await api.sendMessage(
        env.chatId,
        `Plan review TIMED OUT (auto-approved): ${env.agentName}`,
      );
    } catch {
      // Ignore notification failure
    }
    outputDecision('allow');
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`hook-planmode-telegram error: ${err}\n`);
    outputDecision('allow');
  });
}
