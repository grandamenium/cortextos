/**
 * hook-ask-user.ts — Non-blocking PreToolUse hook for AskUserQuestion.
 *
 * Sends question(s) to the operator's remote channel (Telegram today;
 * Matrix/RocketChat in future PRs), saves state file, exits immediately.
 * The fast-checker daemon handles responses and navigates multi-question
 * flows.
 *
 * Renamed from `hook-ask-telegram.ts` in PR2 of the pluggable
 * communications connectors stack. The old file at that path remains
 * as a 1-line shim for backwards compat. PR2 keeps internals using
 * TelegramAPI directly; PR5+ migrates to connector dispatch when the
 * proper interactive lifecycle abstraction is designed.
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
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_input } = parseHookInput(input);

  const questions = tool_input.questions || [];
  if (questions.length === 0) {
    process.exit(0);
  }

  const env = loadEnv();

  if (!env.botToken || !env.chatId) {
    // No remote channel → fall through. Claude Code's built-in
    // AskUserQuestion handling takes over.
    process.exit(0);
  }

  mkdirSync(env.stateDir, { recursive: true });
  const stateFile = join(env.stateDir, 'ask-state.json');
  const state = buildAskState(questions);
  writeFileSync(stateFile, JSON.stringify(state), 'utf-8');

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
    // Non-blocking — exit even on send failure
  }

  process.exit(0);
}

// Self-exec guard with argv[1] basename check — see hook-permission-request.ts
// for the Codex H1.cr rationale (tsup bundles shim entrypoints, so a plain
// `require.main === module` guard would double-execute under the legacy
// shim path).
{
  // Exact basename match (Codex L1.crv) — see hook-permission-request.ts for rationale.
  const argv1 = process.argv[1] ?? '';
  const sep = Math.max(argv1.lastIndexOf('/'), argv1.lastIndexOf('\\'));
  const base = argv1.substring(sep + 1);
  if (base === 'hook-ask-user.js' || base === 'hook-ask-user.ts') {
    main().catch((err) => {
      process.stderr.write(`hook-ask-user error: ${err}\n`);
      process.exit(0);
    });
  }
}
