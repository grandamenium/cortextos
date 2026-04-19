import { createHash } from 'crypto';
import { stripControlChars } from '../utils/validate.js';

// Bracketed paste mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Pattern for valid inbox message IDs: {epochMs}-{agentName}-{rand5}
// e.g. "1713400000000-sage-ab12c"
const INBOX_MSG_ID_REGEX = /^\d{13}-[a-z0-9_-]+-[a-z0-9]{5}$/;

/**
 * Validate that an inbox message ID matches the expected pattern.
 * Returns true if valid, false otherwise.
 */
export function isValidInboxMsgId(msgId: string): boolean {
  return INBOX_MSG_ID_REGEX.test(msgId);
}

// Key escape sequences for TUI navigation
export const KEYS = {
  ENTER: '\r',
  CTRL_C: '\x03',
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  SPACE: ' ',
  ESCAPE: '\x1b',
  TAB: '\t',
} as const;

/**
 * Message deduplication via MD5 hash.
 * Prevents double-injection on crash recovery.
 * Matches bash fast-checker.sh dedup pattern.
 */
export class MessageDedup {
  private hashes: string[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 100) {
    this.maxEntries = maxEntries;
  }

  /**
   * Returns true if this content has been seen before (duplicate).
   */
  isDuplicate(content: string): boolean {
    const hash = createHash('md5').update(content).digest('hex');
    if (this.hashes.includes(hash)) {
      return true;
    }
    this.hashes.push(hash);
    if (this.hashes.length > this.maxEntries) {
      this.hashes.shift();
    }
    return false;
  }

  clear(): void {
    this.hashes = [];
  }
}

/**
 * Inject a message into a PTY process using bracketed paste mode.
 * Replaces tmux load-buffer + paste-buffer pattern.
 *
 * Bracketed paste mode wraps the content so the terminal treats it as
 * pasted text rather than typed input. This prevents special characters
 * from being interpreted as commands.
 *
 * @param write Function to write to the PTY (pty.write)
 * @param content The message content to inject
 * @param enterDelay Milliseconds to wait before sending Enter (default 300ms)
 */
export function injectMessage(
  write: (data: string) => void,
  content: string,
  enterDelay: number = 300,
): void {
  // BUG-079: Strip control characters (except \n and \t) to prevent PTY corruption
  // from crafted inbox message bodies. \r (0x0d) is also stripped here because PTY
  // injection uses bracketed paste mode — a bare CR inside the paste block would
  // submit the input prematurely and corrupt the terminal state.
  const safe = stripControlChars(content)
    .replace(/\r/g, '');  // also strip \r — CR inside bracketed paste submits early

  // For very large messages, chunk the write to avoid overwhelming the PTY buffer
  const MAX_CHUNK = 4096;

  if (safe.length <= MAX_CHUNK) {
    write(PASTE_START + safe + PASTE_END);
  } else {
    // Chunked write for large messages
    write(PASTE_START);
    for (let i = 0; i < safe.length; i += MAX_CHUNK) {
      write(safe.slice(i, i + MAX_CHUNK));
    }
    write(PASTE_END);
  }

  // Send Enter after a short delay to submit the pasted content
  setTimeout(() => write(KEYS.ENTER), enterDelay);
}

/**
 * Send a sequence of keys to the PTY for TUI navigation.
 * Used for AskUserQuestion option selection and Plan mode approval.
 *
 * @param write Function to write to the PTY
 * @param keys Array of key sequences to send
 * @param delay Milliseconds between each key (default 100ms)
 */
export async function sendKeySequence(
  write: (data: string) => void,
  keys: string[],
  delay: number = 100,
): Promise<void> {
  for (const key of keys) {
    write(key);
    await sleep(delay);
  }
}

/**
 * Navigate to a specific option in a TUI list and select it.
 * Matches bash fast-checker.sh AskUserQuestion navigation.
 *
 * @param write PTY write function
 * @param optionIndex 0-based index of the option to select
 * @param submit Whether to press Enter after selection
 */
export async function selectOption(
  write: (data: string) => void,
  optionIndex: number,
  submit: boolean = true,
): Promise<void> {
  // Navigate down to the option
  for (let i = 0; i < optionIndex; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);

  if (submit) {
    write(KEYS.ENTER);
  }
}

/**
 * Toggle options for multi-select TUI and submit.
 * Matches bash fast-checker.sh multi-select pattern.
 */
export async function toggleAndSubmit(
  write: (data: string) => void,
  selectedIndices: number[],
  totalOptions: number,
): Promise<void> {
  const sorted = [...selectedIndices].sort((a, b) => a - b);
  let currentPos = 0;

  for (const idx of sorted) {
    const moves = idx - currentPos;
    for (let i = 0; i < moves; i++) {
      write(KEYS.DOWN);
      await sleep(100);
    }
    write(KEYS.SPACE);
    await sleep(100);
    currentPos = idx;
  }

  // Navigate to Submit button (past all options + "Other")
  const submitPos = totalOptions + 1;
  const remaining = submitPos - currentPos;
  for (let i = 0; i < remaining; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);
  write(KEYS.ENTER);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
