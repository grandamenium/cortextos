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

  /**
   * Forget one content hash so the same content can inject again.
   * Used when delivery confirmation fails: the un-ACKed message redelivers
   * with identical content, which isDuplicate() would otherwise drop.
   */
  forget(content: string): void {
    const hash = createHash('md5').update(content).digest('hex');
    const idx = this.hashes.indexOf(hash);
    if (idx >= 0) this.hashes.splice(idx, 1);
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
  // For very large messages, chunk the write to avoid overwhelming the PTY buffer
  const MAX_CHUNK = 4096;

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

  // Send Enter after a short delay to submit the pasted content.
  // Why the try/catch: the write callback captures `this.pty` (or similar
  // nullable PTY handle) via closure in callers. If the PTY is torn down
  // during the enterDelay window — e.g. hard-restart IPC kills the child —
  // the callback will read `null.write` and throw. Swallowing here keeps
  // the daemon process alive; the dropped Enter is the acceptable cost.
  // Root cause: PR #196 fixed three this.pty! callers in agent-process.ts
  // but missed worker-process.ts:93. This try/catch is the structural fix
  // that covers every present and future caller.
  setTimeout(() => {
    try {
      write(KEYS.ENTER);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[inject] deferred Enter failed (pty likely torn down): ${msg}`);
    }
  }, enterDelay);
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

/**
 * Result of a confirmed injection attempt.
 */
export interface ConfirmedInjectResult {
  /** true = turn-start confirmed; false = every Enter retry exhausted */
  confirmed: boolean;
  /** how many Enters were sent (1 = first attempt confirmed) */
  enterAttempts: number;
}

export interface ConfirmedInjectOptions {
  /** Returns true once the runtime shows the prompt actually submitted */
  isConfirmed: () => boolean;
  /** ms before the first Enter (mirrors injectMessage default) */
  enterDelay?: number;
  /** ms to poll isConfirmed() after each Enter before retrying */
  attemptTimeoutMs?: number;
  /** poll granularity */
  pollMs?: number;
  /** total Enter attempts (first + retries) */
  maxEnterAttempts?: number;
  log?: (msg: string) => void;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Inject a message and CONFIRM it submitted, retrying Enter when it did not.
 *
 * The fire-and-forget injectMessage() above sends Enter 300 ms after the
 * paste and swallows failures — "the dropped Enter is the acceptable cost."
 * The 2026-07-09 fleet stalls showed the real cost: when the Enter fails to
 * submit, the pasted content sits in the CLI input box, the session looks
 * idle, every later injection appends to the same unsubmitted box, and the
 * whole backlog flushes as one batch whenever any later Enter finally lands.
 *
 * This variant closes the loop: paste once, then send Enter and poll a
 * turn-start signal (last_prompt.flag via the UserPromptSubmit hook); no
 * signal within the window → send Enter again (idempotent against a loaded
 * input box — an empty box treats it as a no-op) up to maxEnterAttempts.
 * Defaults: 3 attempts × 9 s ≈ 28 s worst case, inside the 30-second
 * delivery gate.
 */
export async function injectMessageConfirmed(
  write: (data: string) => void,
  content: string,
  options: ConfirmedInjectOptions,
): Promise<ConfirmedInjectResult> {
  const {
    isConfirmed,
    enterDelay = 300,
    attemptTimeoutMs = 9000,
    pollMs = 500,
    maxEnterAttempts = 3,
    log = () => {},
    sleep: doSleep = sleep,
  } = options;

  const MAX_CHUNK = 4096;
  if (content.length <= MAX_CHUNK) {
    write(PASTE_START + content + PASTE_END);
  } else {
    write(PASTE_START);
    for (let i = 0; i < content.length; i += MAX_CHUNK) {
      write(content.slice(i, i + MAX_CHUNK));
    }
    write(PASTE_END);
  }
  await doSleep(enterDelay);

  let enterAttempts = 0;
  while (enterAttempts < maxEnterAttempts) {
    enterAttempts++;
    try {
      write(KEYS.ENTER);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[inject] Enter attempt ${enterAttempts} failed (pty likely torn down): ${msg}`);
      return { confirmed: false, enterAttempts };
    }

    const deadline = attemptTimeoutMs;
    let waited = 0;
    while (waited < deadline) {
      await doSleep(pollMs);
      waited += pollMs;
      if (isConfirmed()) {
        if (enterAttempts > 1) {
          log(`[inject] delivery confirmed after ${enterAttempts} Enter attempts`);
        }
        return { confirmed: true, enterAttempts };
      }
    }
    log(`[inject] no turn-start signal ${deadline} ms after Enter attempt ${enterAttempts}/${maxEnterAttempts} — retrying`);
  }

  return { confirmed: false, enterAttempts };
}
