import { readFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { TelegramAPI } from '../telegram/api.js';

/**
 * Decision request: a single tappable Telegram message that asks the
 * operator to pick one of N options (default YES/NO/HOLD). Replaces the
 * wall-of-text "decisions queue" pattern with one inline-keyboard
 * message per decision.
 *
 * Mirrors the bus/approval.ts pattern (state file + Telegram inline
 * keyboard + callback resolver via fast-checker) but kept intentionally
 * minimal — no expiry, no priority, no escalation. The chief explicitly
 * called out that scope-creep there.
 *
 * State lives at {ctxRoot}/state/pending-decisions.json as a single JSON
 * file (not one-file-per-id) because expected volume is low and a flat
 * list keeps listing/scanning trivial. Atomic writes via atomicWriteSync
 * keep concurrent createDecision/resolveDecision calls safe.
 */
export interface Decision {
  id: string;
  title: string;
  context: string;
  options: string[];
  chat_id: string;
  message_id: number;
  agent: string;
  created_at: string;
  status: 'pending' | 'resolved';
  chosen?: string;
  resolved_at?: string;
}

interface DecisionState {
  decisions: Decision[];
}

function decisionStatePath(paths: BusPaths): string {
  return join(paths.ctxRoot, 'state', 'pending-decisions.json');
}

function readState(paths: BusPaths): DecisionState {
  const filePath = decisionStatePath(paths);
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.decisions)) {
      return parsed as DecisionState;
    }
    return { decisions: [] };
  } catch {
    return { decisions: [] };
  }
}

function writeState(paths: BusPaths, state: DecisionState): void {
  const filePath = decisionStatePath(paths);
  ensureDir(join(paths.ctxRoot, 'state'));
  atomicWriteSync(filePath, JSON.stringify(state, null, 2));
}

/**
 * Build the inline keyboard for a decision message. One row, one button
 * per option. callback_data is `decision_<id>_<optionIndex>` so the
 * fast-checker callback handler can look up the decision and the picked
 * option without a parse fork.
 */
function buildDecisionKeyboard(decisionId: string, options: string[]): object {
  return {
    inline_keyboard: [
      options.map((opt, i) => ({
        text: opt,
        callback_data: `decision_${decisionId}_${i}`,
      })),
    ],
  };
}

/**
 * Resolve a Telegram bot token from agent .env or process.env, matching
 * the lookup order in cli/bus.ts send-telegram. Inlined here (rather
 * than imported) so this module stays a thin lib usable by both CLI and
 * agent code without dragging in the CLI helper graph.
 */
function resolveBotToken(agentDir?: string): string {
  if (agentDir) {
    try {
      const { existsSync, readFileSync } = require('fs') as typeof import('fs');
      const envPath = join(agentDir, '.env');
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match && match[1].trim()) return match[1].trim();
      }
    } catch {
      // fall through to process.env
    }
  }
  return process.env.BOT_TOKEN || '';
}

/**
 * Create a decision. Sends the Telegram message with inline keyboard,
 * stores the entry in pending-decisions.json, and returns the id +
 * Telegram message id.
 *
 * Caller must `await` — the Telegram send is async and short-lived CLI
 * processes may exit before the fetch lands otherwise (same gotcha as
 * createApproval). On Telegram failure the entry is NOT written: a
 * decision without a Telegram surface is useless and would silently
 * accumulate junk in state.
 */
export async function createDecision(
  paths: BusPaths,
  args: {
    title: string;
    context: string;
    options: string[];
    chat_id: string;
    agent: string;
    agentDir?: string;
    botToken?: string;
  },
): Promise<{ id: string; message_id: number }> {
  if (!args.options || args.options.length === 0) {
    throw new Error('createDecision: options must be a non-empty array');
  }

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const id = `decision_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const text = `${args.title}\n\n${args.context}`;
  const keyboard = buildDecisionKeyboard(id, args.options);

  const botToken = args.botToken ?? resolveBotToken(args.agentDir);
  if (!botToken) {
    throw new Error('createDecision: BOT_TOKEN not configured (agent .env or process.env)');
  }

  const api = new TelegramAPI(botToken);
  const result = await api.sendMessage(args.chat_id, text, keyboard, { parseMode: null });
  const messageId: number = result?.result?.message_id ?? 0;
  if (!messageId) {
    throw new Error('createDecision: Telegram sendMessage returned no message_id');
  }

  const decision: Decision = {
    id,
    title: args.title,
    context: args.context,
    options: args.options,
    chat_id: args.chat_id,
    message_id: messageId,
    agent: args.agent,
    created_at: now,
    status: 'pending',
  };

  const state = readState(paths);
  state.decisions.push(decision);
  writeState(paths, state);

  return { id, message_id: messageId };
}

/**
 * Look up a decision by id. Returns undefined if not found.
 */
export function getDecision(paths: BusPaths, id: string): Decision | undefined {
  const state = readState(paths);
  return state.decisions.find((d) => d.id === id);
}

/**
 * List decisions, optionally filtered by status, newest-first.
 */
export function listDecisions(
  paths: BusPaths,
  status?: 'pending' | 'resolved',
): Decision[] {
  const state = readState(paths);
  const filtered = status
    ? state.decisions.filter((d) => d.status === status)
    : state.decisions.slice();
  return filtered.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/**
 * Mark a decision resolved with the chosen option. Returns the updated
 * decision, or undefined if not found / already resolved (the caller —
 * fast-checker — uses that signal to send "Already resolved" via
 * answerCallbackQuery).
 */
export function resolveDecision(
  paths: BusPaths,
  id: string,
  chosen: string,
): Decision | undefined {
  const state = readState(paths);
  const idx = state.decisions.findIndex((d) => d.id === id);
  if (idx === -1) return undefined;
  const d = state.decisions[idx];
  if (d.status === 'resolved') return undefined;

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  d.status = 'resolved';
  d.chosen = chosen;
  d.resolved_at = now;
  state.decisions[idx] = d;
  writeState(paths, state);
  return d;
}

/**
 * Internal helper for tests + callers that want the full state file
 * path (e.g. fast-checker logging).
 */
export function getDecisionStatePath(paths: BusPaths): string {
  return decisionStatePath(paths);
}

