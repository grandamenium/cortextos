
/**
 * hook-ask-telegram.ts - Non-blocking PreToolUse hook for AskUserQuestion
 * Sends question(s) to Telegram, saves state file, exits immediately.
 * The fast-checker daemon handles responses and navigates multi-question flows.
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  buildAskState,
  buildAskSingleSelectKeyboard,
  buildAskMultiSelectKeyboard,
  formatQuestionMessage,
} from './index';
import { writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

  const questions = tool_input.questions || [];
  if (questions.length === 0) {
    process.exit(0);
  }

  const env = loadEnv();

  if (!env.botToken || !env.chatId) {
    process.exit(0);
  }

  // Save state file for fast-checker
  mkdirSync(env.stateDir, { recursive: true });
  const stateFile = join(env.stateDir, 'ask-state.json');
  const state = buildAskState(questions);
  writeFileSync(stateFile, JSON.stringify(state), 'utf-8');
  try { chmodSync(stateFile, 0o600); } catch { /* ignore on unsupported platforms */ }

  // Send first question
  const q = questions[0];
  const isMultiSelect = q.multiSelect || false;
  const options = (q.options || []).map((o: any) => o.label || o);

  const messageText = formatQuestionMessage(env.agentName, 0, questions.length, q);

  const keyboard = isMultiSelect
    ? buildAskMultiSelectKeyboard(0, options)
    : buildAskSingleSelectKeyboard(0, options);

  const api = new TelegramAPI(env.botToken);

  try {
    await api.sendMessage(env.chatId, messageText, keyboard);
  } catch {
    // Non-blocking - exit even on send failure
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`hook-ask-telegram error: ${err}\n`);
  process.exit(0);
});
