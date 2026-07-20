/**
 * hook-qualifier-scan.ts — PreToolUse hook.
 *
 * Mechanically blocks outgoing Telegram/agent messages that use a
 * self-narrating qualifier word ("fair", "honest[ly]", "real[ly]",
 * "genuinely") — Lauren's fleet-wide rule (2026-07-13, reinforced
 * 2026-07-19): state the fact directly, don't narrate that you're being
 * fair/honest/genuine/real about it.
 *
 * Why a hook and not just GUARDRAILS.md: documenting the rule did not
 * prevent it from recurring. Both Cleo and anam broke it again the SAME
 * DAY it was reinforced a second time — applying one specific rule out of
 * dozens depends on it surfacing at the exact moment a sentence gets
 * written, which is a recall problem a hook doesn't have (it runs the same
 * mechanical check on every single call, regardless of what else is
 * happening in the session).
 *
 * Scope, deliberately NARROW per Lauren's explicit choice (2026-07-19,
 * chose "narrower" after being shown the tradeoff: a broad bare-word match
 * on "real"/"fair" would also block ordinary factual language like "a real
 * bug" or "a fair amount", not just self-narrating phrasing). Matches
 * specific self-narrating PHRASES, not bare adjective use — "honestly" and
 * "genuinely" as bare words (almost always a sentence-adverb aside, rarely
 * a plain factual adjective), plus "to be fair", "that's a fair X", "to be
 * honest", "honest truth/limit/answer/read". Does NOT flag bare "real" or
 * "fair" used as ordinary adjectives ("real bug", "fair price") — accepts
 * missing some violations (e.g. Cleo's "real deliverables" pattern) as the
 * cost of not blocking normal technical writing.
 *
 * Only inspects Bash tool calls whose command is a
 * `cortextos bus send-telegram` / `cortextos bus send-message` invocation
 * — does not touch any other Bash command (editing GUARDRAILS.md itself,
 * which necessarily contains these words, must never be blocked).
 *
 * Message-text extraction handles two patterns actually used in practice:
 *   1. A direct quoted string argument: `send-telegram <chat> "text"`.
 *   2. A `$(cat <path>)` substitution (used for longer/careful messages to
 *      avoid shell-quoting fragility) — reads the referenced file's actual
 *      content, since the raw command string never contains it.
 * If neither pattern is found, the call is allowed (fails open — a missed
 * scan is better than blocking an unrelated command by mistake).
 */

import { readFileSync, existsSync } from 'fs';
import { readStdin, parseHookInput } from './index.js';

// Phrase-anchored matches, not bare adjective use — deliberately excludes
// plain "real"/"fair" as ordinary adjectives ("a real bug", "a fair price")
// per Lauren's chosen narrow scope. "honestly"/"genuinely" as bare words
// are kept since those are almost always the self-narrating sentence-adverb
// use, not a plain factual adjective.
const BANNED_PATTERNS: Array<{ word: string; regex: RegExp }> = [
  { word: 'honestly', regex: /\bhonestly\b/i },
  { word: 'genuinely', regex: /\bgenuinely\b/i },
  { word: 'to be fair', regex: /\bto be fair\b/i },
  { word: "that's a fair ...", regex: /\bthat(?:'s| is) (?:a )?fair\b/i },
  { word: 'to be honest', regex: /\bto be honest\b/i },
  { word: 'honest truth/limit/answer/read', regex: /\bhonest (?:truth|limit|answer|read)\b/i },
];

const SEND_COMMAND_RE = /cortextos\s+bus\s+send-(telegram|message)\b/;
const CAT_SUBSTITUTION_RE = /\$\(\s*cat\s+"?([^")\s]+)"?\s*\)/;

export function extractMessageText(command: string): string | null {
  if (!SEND_COMMAND_RE.test(command)) return null;

  const catMatch = command.match(CAT_SUBSTITUTION_RE);
  if (catMatch) {
    const path = catMatch[1];
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  }

  // Last quoted argument on the line is the message text (chat-id/agent-name
  // /priority args come first and are never quoted with spaces inside).
  const quoted = [...command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)];
  if (quoted.length === 0) return null;
  const last = quoted[quoted.length - 1];
  return last[1] ?? last[2] ?? null;
}

export function findViolations(text: string): string[] {
  const found: string[] = [];
  for (const { word, regex } of BANNED_PATTERNS) {
    if (regex.test(text)) found.push(word);
  }
  return found;
}

function blockCall(violations: string[]): void {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        `Message contains banned self-narrating qualifier phrase(s): ${violations.join(', ')}. ` +
        `Lauren's rule (2026-07-13, reinforced 2026-07-19): state the fact directly, don't ` +
        `narrate that you're being fair/honest/genuine about it. Rewrite the message without ` +
        `this phrasing, then resend.`,
    }) + '\n',
  );
}

export async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  if (tool_name !== 'Bash') {
    process.exit(0);
    return;
  }

  const command = (tool_input as { command?: string })?.command || '';
  const messageText = extractMessageText(command);
  if (!messageText) {
    process.exit(0);
    return;
  }

  const violations = findViolations(messageText);
  if (violations.length > 0) {
    blockCall(violations);
    process.exit(0);
    return;
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}
