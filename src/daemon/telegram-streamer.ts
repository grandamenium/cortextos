/**
 * TelegramStreamer — incremental Telegram message updates.
 *
 * Opens a chat with an initial `sendMessage`, captures the returned
 * `message_id`, then batches `.append(token)` calls into `editMessageText`
 * updates that respect:
 *   - Telegram rate limit (~1 edit/sec/chat) — minInterval between edits
 *   - Identical-content 400 guard — skip edit if accumulated === lastSent
 *   - Maximum message length (4096 chars) — trim leading content with a
 *     "[…]" marker so we never exceed the Telegram cap mid-stream
 *
 * Two batch knobs (suggested defaults from the spec: 20 tokens / 400ms):
 *   - flushTokenCount: flush when this many tokens have accumulated since
 *     the last edit (whichever fires first vs. flushIntervalMs)
 *   - flushIntervalMs:  schedule a deferred flush this many ms after the
 *     first un-flushed token (so a slow trickle still surfaces).
 *
 * The rate-limit clamp wins: even if both flush triggers fire faster than
 * `minEditIntervalMs`, edits are spaced by at least that gap. Pending tokens
 * accumulate until the timer permits the next edit.
 *
 * The class is intentionally framework-agnostic — it does not import
 * AgentProcess or worry about agent lifecycle. The CLI streaming command
 * and the daemon-side hook both construct it directly with a TelegramAPI
 * handle. Errors are caught and logged; a transient API failure does not
 * abort the stream — subsequent appends keep accumulating and the next
 * edit attempt re-tries with the latest text.
 */

import type { TelegramAPI } from '../telegram/api.js';

export interface TelegramStreamerOptions {
  /** Tokens accumulated before a flush is requested. Default 20. */
  flushTokenCount?: number;
  /** Max ms between flushes once tokens have arrived. Default 400. */
  flushIntervalMs?: number;
  /** Hard floor between consecutive edits, in ms. Telegram cap is ~1s. Default 1000. */
  minEditIntervalMs?: number;
  /** Parse mode for the final edit. Interim edits always use plain text to avoid
   *  parse-error 400s on mid-stream incomplete markdown. Default 'HTML'. */
  finalParseMode?: 'HTML' | null;
  /** Optional logger; defaults to a noop. */
  log?: (msg: string) => void;
}

export class TelegramStreamer {
  private api: TelegramAPI;
  private chatId: string;
  private flushTokenCount: number;
  private flushIntervalMs: number;
  private minEditIntervalMs: number;
  private finalParseMode: 'HTML' | null;
  private log: (msg: string) => void;

  // Stream state
  private messageId: number | null = null;
  private accumulated = '';
  private lastSentText = '';
  private lastEditAt = 0;
  private tokensSinceFlush = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight = false;
  private closed = false;
  // Track whether append() has been called at least once with non-empty
  // content. Used to decide if finalize() needs to do a final edit even
  // when no pending tokens remain (e.g. final flush already happened).
  private opened = false;

  // Telegram message text cap. Real cap is 4096 but we leave headroom for
  // a continuation marker and any HTML-escape inflation on the final pass.
  private static readonly MAX_TEXT_LEN = 3900;

  constructor(api: TelegramAPI, chatId: string | number, opts: TelegramStreamerOptions = {}) {
    this.api = api;
    this.chatId = String(chatId);
    this.flushTokenCount = opts.flushTokenCount ?? 20;
    this.flushIntervalMs = opts.flushIntervalMs ?? 400;
    this.minEditIntervalMs = opts.minEditIntervalMs ?? 1000;
    this.finalParseMode = opts.finalParseMode === undefined ? 'HTML' : opts.finalParseMode;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Send the initial message and capture its message_id. Must be called
   * before any append() — append() is a no-op until start() has resolved.
   * The initial text becomes the first visible content in the chat (a
   * placeholder like "…" is a sensible default if no content is ready yet).
   */
  async start(initialText: string = '…'): Promise<number> {
    if (this.messageId !== null) return this.messageId;
    // Initial send goes through sendMessage with plain text — same rationale
    // as interim edits: we may not have a complete markdown payload yet, and
    // a parse error on the opener is the worst possible failure mode.
    const result = await this.api.sendMessage(this.chatId, initialText, undefined, {
      parseMode: null,
    });
    const id = result?.result?.message_id;
    if (typeof id !== 'number') {
      throw new Error('Telegram sendMessage did not return a message_id');
    }
    this.messageId = id;
    this.lastSentText = initialText;
    this.lastEditAt = Date.now();
    return id;
  }

  /**
   * Append a token (or any substring) to the stream. Schedules a deferred
   * flush; the flush actually fires only when both the token-count / time
   * threshold AND the rate-limit window permit. Safe to call concurrently
   * with the in-flight flush — pending text accumulates and will surface
   * in the next edit.
   *
   * Empty tokens are dropped silently. Calls after finalize() are a no-op.
   */
  append(token: string): void {
    if (this.closed) return;
    if (!token) return;
    this.accumulated += token;
    this.tokensSinceFlush += 1;
    this.opened = true;
    this.trimIfOverflow();
    this.scheduleFlush();
  }

  /**
   * Force a final flush and mark the stream closed. After finalize() the
   * streamer cannot accept more tokens and no more edits will be scheduled.
   * Safe to call multiple times — extra calls are no-ops.
   */
  async finalize(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Wait for any in-flight flush to settle before we fire the final one,
    // otherwise the in-flight edit may stomp our final text.
    while (this.flushInFlight) {
      await sleep(20);
    }
    if (!this.opened) return;
    if (this.messageId === null) return;
    await this.doEdit({ final: true });
  }

  /** Whether start() has resolved and a message_id is held. */
  isStarted(): boolean {
    return this.messageId !== null;
  }

  /** The captured message_id, or null if start() has not resolved. */
  getMessageId(): number | null {
    return this.messageId;
  }

  /** Current accumulated text — mostly useful for tests. */
  getAccumulated(): string {
    return this.accumulated;
  }

  // --- private ---

  private scheduleFlush(): void {
    if (this.closed) return;
    if (this.messageId === null) return;
    if (this.flushTimer) return;

    const now = Date.now();
    const elapsedSinceLastEdit = now - this.lastEditAt;
    const rateLimitWait = Math.max(0, this.minEditIntervalMs - elapsedSinceLastEdit);

    // Two triggers race: token-count threshold (fire ASAP, clamped by rate)
    // and time threshold (fire after flushIntervalMs of tokens). The earlier
    // trigger wins.
    const tokenTrigger = this.tokensSinceFlush >= this.flushTokenCount ? rateLimitWait : Infinity;
    const timeTrigger = Math.max(rateLimitWait, this.flushIntervalMs);
    const delay = Math.min(tokenTrigger, timeTrigger);
    if (!Number.isFinite(delay)) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.doEdit({ final: false }).catch((err) => {
        this.log(`flush failed: ${err}`);
      });
    }, delay);
  }

  private async doEdit(opts: { final: boolean }): Promise<void> {
    if (this.messageId === null) return;
    if (this.flushInFlight) {
      // Re-schedule — another flush is mid-flight. We'll catch up after it.
      this.scheduleFlush();
      return;
    }

    // Identical-content guard: Telegram returns 400 if the new text exactly
    // matches the current message text. Skip when nothing has changed since
    // the last successful edit.
    if (this.accumulated === this.lastSentText) {
      this.tokensSinceFlush = 0;
      return;
    }

    const text = this.accumulated;
    const parseMode = opts.final ? this.finalParseMode : null;

    this.flushInFlight = true;
    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, undefined, {
        parseMode,
      });
      this.lastSentText = text;
      this.lastEditAt = Date.now();
      this.tokensSinceFlush = 0;
    } catch (err) {
      // Two known recoverable cases:
      //   1. "message is not modified" — content collapsed to identical mid-flight.
      //   2. parse-error 400 on the final pass (open markdown entity) — retry
      //      once with parseMode disabled so the user at least sees the text.
      const msg = err instanceof Error ? err.message : String(err);
      if (/message is not modified/i.test(msg)) {
        this.lastSentText = text;
        this.lastEditAt = Date.now();
        this.tokensSinceFlush = 0;
      } else if (opts.final && parseMode !== null && /can'?t parse entities|parse_mode/i.test(msg)) {
        try {
          await this.api.editMessageText(this.chatId, this.messageId, text, undefined, {
            parseMode: null,
          });
          this.lastSentText = text;
          this.lastEditAt = Date.now();
          this.tokensSinceFlush = 0;
        } catch (err2) {
          this.log(`final fallback edit failed: ${err2}`);
        }
      } else {
        this.log(`edit failed: ${msg}`);
      }
    } finally {
      this.flushInFlight = false;
    }

    // If new tokens arrived during the in-flight edit, schedule the next pass.
    if (!this.closed && this.accumulated !== this.lastSentText) {
      this.scheduleFlush();
    }
  }

  /**
   * Telegram's 4096-char message cap forces us to drop earlier content from
   * the head of the buffer when a long response accumulates. The drop is
   * always at a paragraph boundary when possible so we don't slice a code
   * block or markdown entity in half.
   */
  private trimIfOverflow(): void {
    if (this.accumulated.length <= TelegramStreamer.MAX_TEXT_LEN) return;
    const marker = '[…]\n';
    const overflow = this.accumulated.length - (TelegramStreamer.MAX_TEXT_LEN - marker.length);
    let cut = overflow;
    const tail = this.accumulated.slice(cut);
    const para = tail.indexOf('\n\n');
    if (para >= 0 && para < 400) {
      cut += para + 2;
    } else {
      const nl = tail.indexOf('\n');
      if (nl >= 0 && nl < 200) cut += nl + 1;
    }
    this.accumulated = marker + this.accumulated.slice(cut);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
