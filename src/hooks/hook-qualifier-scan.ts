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

/**
 * Return every chunk of text that could be the outgoing message body, for a
 * command that invokes send-telegram/send-message. Returns [] if this is not
 * a send command at all.
 *
 * Returns MULTIPLE candidates rather than one "best guess" because of a real
 * gap found 2026-07-20, hours after this hook shipped: the dominant way long
 * messages get composed is
 *
 *     cat > /tmp/draft.txt << 'EOF'
 *     ...message text...
 *     EOF
 *     cortextos bus send-telegram <chat> "$(cat /tmp/draft.txt)"
 *
 * all inside ONE Bash call. PreToolUse fires BEFORE the command runs, so at
 * inspection time /tmp/draft.txt does not exist yet (or still holds stale
 * content from a previous run) — existsSync() failed, extraction returned
 * null, and the hook silently allowed the message through unscanned. That is
 * exactly backwards: the write-then-send-in-one-call pattern is used for the
 * LONGEST and most carefully-worded messages, which are the ones most likely
 * to contain this phrasing. Confirmed live: identical text blocked when the
 * file pre-existed and passed unchecked when written in the same call.
 *
 * Fix: always scan the raw command string too. When the body is written via
 * heredoc in the same call, the text is literally present in the command, so
 * scanning the command catches what reading the not-yet-existent file cannot.
 * A readable cat-referenced file is still read as well, for the case where
 * the draft was written by an earlier call.
 */
export function extractMessageCandidates(command: string): string[] {
  if (!SEND_COMMAND_RE.test(command)) return [];

  const candidates: string[] = [];

  // 1. The raw command itself — covers heredoc-in-same-call and direct quoted
  //    args, and cannot be defeated by file-timing.
  candidates.push(command);

  // 2. A cat-referenced draft file, when it already exists at inspection time.
  const catMatch = command.match(CAT_SUBSTITUTION_RE);
  if (catMatch) {
    const path = catMatch[1];
    if (existsSync(path)) {
      try {
        candidates.push(readFileSync(path, 'utf-8'));
      } catch {
        /* unreadable draft — the raw-command scan above still applies */
      }
    }
  }

  return candidates;
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
  const candidates = extractMessageCandidates(command);
  if (candidates.length === 0) {
    process.exit(0);
    return;
  }

  const violations = [...new Set(candidates.flatMap(findViolations))];
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
