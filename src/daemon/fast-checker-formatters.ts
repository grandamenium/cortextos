import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Format a Telegram text message for injection.
 * Matches bash fast-checker.sh format.
 */
export function formatTelegramTextMessage(
  from: string,
  chatId: string | number,
  text: string,
  frameworkRoot: string,
  replyToText?: string,
  lastSentText?: string,
  recentHistory?: string,
): string {
  let replyCx = '';
  if (replyToText) {
    replyCx = `[Replying to: "${replyToText.slice(0, 500)}"]\n`;
  }

  let lastSentCtx = '';
  if (lastSentText) {
    lastSentCtx = `[Your last message: "${lastSentText.slice(0, 500)}"]\n`;
  }

  let historyCx = '';
  if (recentHistory) {
    historyCx = `[Recent conversation:]\n${recentHistory}\n`;
  }

  // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
  // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
  // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
  const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
  const body = isSlashCommand
    ? text.trim()
    : `\`\`\`\n${text}\n\`\`\``;
  return `=== TELEGRAM from [USER: ${from}] (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
}

/**
 * Format a Telegram message_reaction update for PTY injection.
 * Reactions are emoji additions/removals on existing messages — they
 * surface to the agent so it can follow up on positive acknowledgements
 * or clarify after a negative reaction.
 *
 * `newReaction` is the current reaction state (an empty list means the
 * user REMOVED their reaction). `oldReaction` lets the formatter
 * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
 * render as [custom_emoji] since we don't resolve the custom_emoji_id.
 */
export function formatTelegramReaction(
  from: string,
  chatId: string | number,
  messageId: number,
  oldReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
  newReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
): string {
  const render = (list: typeof newReaction): string =>
    list.length === 0
      ? '(none)'
      : list.map((r) => (r.type === 'emoji' ? r.emoji : '[custom_emoji]')).join(' ');

  const removed = newReaction.length === 0 && oldReaction.length > 0;
  const label = removed ? `removed ${render(oldReaction)}` : render(newReaction);

  return `=== REACTION from [USER: ${from}] (chat_id:${chatId}) on message ${messageId}: ${label} ===

`;
}

/**
 * Format a Telegram photo message for injection.
 * Matches bash fast-checker.sh format.
 */
export function formatTelegramPhotoMessage(
  from: string,
  chatId: string | number,
  caption: string,
  imagePath: string,
): string {
  return `=== TELEGRAM PHOTO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
}

/**
 * Format a Telegram document message for injection.
 * Matches bash fast-checker.sh format.
 */
export function formatTelegramDocumentMessage(
  from: string,
  chatId: string | number,
  caption: string,
  filePath: string,
  fileName: string,
): string {
  return `=== TELEGRAM DOCUMENT from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
}

/**
 * Format a Telegram voice/audio message for injection.
 * Matches bash fast-checker.sh format.
 *
 * `transcript` is populated by `src/telegram/transcribe.ts` when whisper-cli
 * and the GGML model are available; otherwise it stays undefined and the
 * agent receives only the .ogg path. The codex extractor surfaces the
 * transcript block when present.
 */
export function formatTelegramVoiceMessage(
  from: string,
  chatId: string | number,
  filePath: string,
  duration: number | undefined,
  transcript?: string,
): string {
  const dur = duration !== undefined ? duration : 'unknown';
  const transcriptBlock = transcript && transcript.trim()
    ? `transcript:\n\`\`\`\n${transcript.trim()}\n\`\`\`\n`
    : '';
  return `=== TELEGRAM VOICE from ${from} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
${transcriptBlock}Reply using: cortextos bus send-telegram-voice ${chatId} '<your reply>'

`;
}

/**
 * Format a Telegram video/video_note message for injection.
 * Matches bash fast-checker.sh format.
 */
export function formatTelegramVideoMessage(
  from: string,
  chatId: string | number,
  caption: string,
  filePath: string,
  fileName: string,
  duration: number | undefined,
): string {
  const dur = duration !== undefined ? duration : 'unknown';
  return `=== TELEGRAM VIDEO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
duration: ${dur}s
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
}

/**
 * Read the last-sent message file for conversation context.
 * Returns the content (up to 500 chars) or null if not available.
 */
export function readLastSent(stateDir: string, chatId: string | number): string | null {
  const filePath = join(stateDir, `last-telegram-${chatId}.txt`);
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    if (!content) return null;
    return content.slice(0, 500);
  } catch {
    return null;
  }
}
