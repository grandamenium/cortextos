/**
 * hook-planmode-approval.ts — ExitPlanMode PermissionRequest hook.
 *
 * Reads the plan file, sends it to the operator's remote channel
 * with Approve/Deny buttons. 30-min timeout, auto-APPROVES so agents
 * aren't blocked if user is away.
 *
 * Renamed from `hook-planmode-telegram.ts` in PR2 of the pluggable
 * communications connectors stack. The old file at that path remains
 * as a 1-line shim for backwards compat. PR2 keeps internals using
 * TelegramAPI directly; PR5+ migrates to connector dispatch.
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

function readPlanContent(planPath: string): string {
  try {
    const content = readFileSync(planPath, 'utf-8');
    const lines = content.split('\n').slice(0, 100);
    return lines.join('\n');
  } catch {
    return '';
  }
}

export async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

  const env = loadEnv();

  if (!env.botToken || !env.chatId) {
    // No remote channel → auto-allow so agents aren't blocked.
    outputDecision('allow');
    return;
  }

  let planPath = tool_input.plan_file || '';
  if (!planPath) {
    planPath = findMostRecentPlan() || '';
  }

  let planContent = '';
  if (planPath && existsSync(planPath)) {
    planContent = readPlanContent(planPath);
  }

  if (!planContent) {
    planContent = '(Plan file not found or empty)';
  }

  if (planContent.length > 3600) {
    planContent = planContent.slice(0, 3600) + '...(truncated)';
  }

  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

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
    outputDecision('allow');
    return;
  }

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
    process.stderr.write(`hook-planmode-approval error: ${err}\n`);
    outputDecision('allow');
  });
}
