import { createHash } from 'crypto';

// Bracketed paste mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

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

  /**
   * Roll back a previously-recorded hash (#510). Used when an inject was
   * accepted as non-duplicate but ultimately failed to submit (deferred
   * ENTER lost to a torn-down/restarted PTY) — without this, a caller's
   * retry of the identical content would be wrongly swallowed as a dupe.
   */
  forget(content: string): void {
    const hash = createHash('md5').update(content).digest('hex');
    const idx = this.hashes.indexOf(hash);
    if (idx !== -1) this.hashes.splice(idx, 1);
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
 * Resolves `true` only once the deferred ENTER that actually submits the
 * pasted content has been written successfully — `false` if either write
 * throws (PTY torn down mid-inject). Callers MUST await this before treating
 * the message as delivered (#510): the paste alone lands in the input box
 * unsubmitted, and is lost silently if the PTY dies before ENTER follows.
 *
 * @param write Function to write to the PTY (pty.write)
 * @param content The message content to inject
 * @param enterDelay Milliseconds to wait before sending Enter (default 300ms)
 */
export function injectMessage(
  write: (data: string) => void,
  content: string,
  enterDelay: number = 300,
): Promise<boolean> {
  // For very large messages, chunk the write to avoid overwhelming the PTY buffer
  const MAX_CHUNK = 4096;

  try {
    if (content.length <= MAX_CHUNK) {
      write(PASTE_START + content + PASTE_END);
    } else {
      // Chunked write for large messages
      write(PASTE_START);
      for (let i = 0; i < content.length; i += MAX_CHUNK) {
        write(content.slice(i, i + MAX_CHUNK));
      }
      write(PASTE_END);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[inject] paste write failed (pty likely torn down): ${msg}`);
    return Promise.resolve(false);
  }

  // Send Enter after a short delay to submit the pasted content. Without this
  // explicit ENTER, bracketed paste never auto-submits (that's the whole
  // point of the mode — embedded newlines in a multi-line paste must not act
  // as Enter). If the PTY is torn down during the enterDelay window — e.g.
  // hard-restart IPC kills the child — the write throws and we resolve
  // false so the caller (#510) treats this as a failed, retryable inject
  // instead of a false success that silently drops the message.
  // Root cause: PR #196 fixed three this.pty! callers in agent-process.ts
  // but missed worker-process.ts:93; this Promise-returning contract is the
  // structural fix that covers every present and future caller.
  return new Promise<boolean>((resolve) => {
    setTimeout(() => {
      try {
        write(KEYS.ENTER);
        resolve(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[inject] deferred Enter failed (pty likely torn down): ${msg}`);
        resolve(false);
      }
    }, enterDelay);
  });
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
