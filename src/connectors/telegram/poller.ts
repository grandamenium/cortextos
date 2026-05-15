import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir } from '../../utils/atomic.js';

/**
 * Poller handlers may be synchronous OR async. The poller awaits each
 * handler return value before advancing the offset, so an async handler
 * can hold offset advancement until its full work settles (e.g. the
 * media-enrichment pipeline in TelegramConnector that downloads files
 * before emitting the normalized message). A handler that throws OR a
 * rejected promise marks the update as failed — the offset stays put
 * and Telegram redelivers the update on the next getUpdates call.
 *
 * Sync handlers are still supported (return value is `void`); awaiting
 * a non-promise is a no-op so existing sync callers keep their old
 * semantics byte-for-byte.
 */
export type MessageHandler = (msg: TelegramMessage) => void | Promise<void>;
export type CallbackHandler = (query: TelegramCallbackQuery) => void | Promise<void>;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void | Promise<void>;

/**
 * Telegram polling loop. Replaces the Telegram portion of fast-checker.sh.
 * Polls getUpdates every 1 second and routes messages/callbacks to handlers.
 */
export class TelegramPoller {
  private api: TelegramAPI;
  private offset: number = 0;
  private running: boolean = false;
  private stateDir: string;
  private offsetFileName: string;
  private messageHandlers: MessageHandler[] = [];
  private callbackHandlers: CallbackHandler[] = [];
  private reactionHandlers: ReactionHandler[] = [];
  private pollInterval: number;
  /**
   * Monotonic generation id. Bumped on every stop() so any in-flight
   * pollOnce() can detect that it was started under a prior generation
   * and skip handler dispatch. Without this, callback and reaction
   * handlers (which lack the connector-layer GenerationMismatchError
   * guard that the message path has) could fire after stop() returns —
   * a use-after-stop bug.
   */
  private generation: number = 0;
  /** Promise of the currently in-flight start() — awaited by stop() so
   *  callers see "really stopped" semantics on stop() return. */
  private runPromise: Promise<void> | null = null;

  /**
   * @param api Telegram API client scoped to a single bot token.
   * @param stateDir Directory for persisted poller state (offset, dedup).
   * @param pollInterval Milliseconds between getUpdates calls.
   * @param offsetFileSuffix Optional distinct suffix for the offset file.
   *   When omitted (default), offset persists to `.telegram-offset`. When
   *   provided, offset persists to `.telegram-offset-<suffix>`. Use this
   *   when running a second poller in the same stateDir against a
   *   different bot token (e.g. an activity-channel bot alongside the
   *   agent's own bot), so the two pollers do not clobber each other's
   *   offsets. Without this, two pollers sharing a stateDir would both
   *   write to `.telegram-offset` and lose track of which bot each
   *   offset belonged to.
   */
  constructor(api: TelegramAPI, stateDir: string, pollInterval: number = 1000, offsetFileSuffix?: string) {
    this.api = api;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.offsetFileName = offsetFileSuffix
      ? `.telegram-offset-${offsetFileSuffix}`
      : '.telegram-offset';
    this.loadOffset();
  }

  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register a handler for callback queries.
   */
  onCallback(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  /**
   * Register a handler for message_reaction updates. These fire when a
   * user adds or removes an emoji reaction on a chat message the bot can
   * see. Requires the bot's getUpdates call to include `message_reaction`
   * in allowed_updates (handled by TelegramAPI.getUpdates).
   */
  onReaction(handler: ReactionHandler): void {
    this.reactionHandlers.push(handler);
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    const myGen = this.generation;
    const loop = (async () => {
      while (this.running && this.generation === myGen) {
        try {
          await this.pollOnce(myGen);
        } catch (err) {
          console.error('[telegram-poller] Poll error:', err);
        }
        if (!this.running || this.generation !== myGen) break;
        await sleep(this.pollInterval);
      }
    })();
    this.runPromise = loop;
    try { await loop; } finally {
      if (this.runPromise === loop) this.runPromise = null;
    }
  }

  /**
   * Stop the polling loop. Awaits the in-flight start() so callers see
   * "really stopped" on return — no callback/reaction handlers fire
   * after this resolves.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    const inflight = this.runPromise;
    if (inflight) {
      try { await inflight; } catch { /* errors already logged in start() */ }
    }
  }

  /**
   * Perform a single poll cycle.
   *
   * Offset-after-handler semantics: the offset only advances after every
   * registered handler for an update returns successfully. If any handler
   * throws, the update is left un-acknowledged (Telegram will re-deliver it
   * on the next `getUpdates` call) and the remainder of the batch is deferred
   * to preserve ordering. The offset is persisted after each successful
   * update so a crash mid-batch does not drop confirmed state.
   */
  async pollOnce(callerGen?: number): Promise<void> {
    // callerGen is the generation captured at start(); when stop() bumps
    // generation mid-flight, every subsequent handler dispatch is skipped
    // and the offset is left un-advanced (Telegram will redeliver).
    // Existing callers (tests) that invoke pollOnce() directly pass no
    // generation and get the legacy single-shot behavior — `stopped()`
    // is a no-op for them because there's no in-flight start() to fence.
    const fromStart = callerGen !== undefined;
    const myGen = callerGen ?? this.generation;
    const stopped = (): boolean => fromStart && (!this.running || this.generation !== myGen);

    const result = await this.api.getUpdates(this.offset, 1);
    if (stopped()) return;
    if (!result?.result?.length) return;

    for (const update of result.result as TelegramUpdate[]) {
      if (stopped()) return;
      const nextOffset = update.update_id + 1;
      let handlerFailed = false;

      if (update.message) {
        for (const handler of this.messageHandlers) {
          if (stopped()) return;
          try {
            await handler(update.message);
          } catch (err) {
            // PR4 c18 (Codex round-3 P2.R3-1B): GenerationMismatchError
            // is a legitimate stop-during-await signal, not a real
            // error — the connector intentionally throws it from
            // stopInbound during in-flight media so the poller leaves
            // the offset un-advanced. Suppress the noise log for that
            // specific case. Other thrown errors stay logged.
            const isGenMismatch = err instanceof Error && err.name === 'GenerationMismatchError';
            if (!isGenMismatch) {
              console.error('[telegram-poller] Message handler error:', err);
            }
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.callback_query) {
        for (const handler of this.callbackHandlers) {
          if (stopped()) return;
          try {
            await handler(update.callback_query);
          } catch (err) {
            console.error('[telegram-poller] Callback handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.message_reaction) {
        for (const handler of this.reactionHandlers) {
          if (stopped()) return;
          try {
            await handler(update.message_reaction);
          } catch (err) {
            console.error('[telegram-poller] Reaction handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (handlerFailed) {
        // Do not advance offset — the update will be redelivered.
        // Stop processing the rest of this batch to preserve ordering.
        return;
      }

      this.offset = nextOffset;
      this.saveOffset();
    }
  }

  /**
   * Load persisted offset from state file.
   */
  private loadOffset(): void {
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      if (existsSync(offsetFile)) {
        const content = readFileSync(offsetFile, 'utf-8').trim();
        const parsed = parseInt(content, 10);
        if (!isNaN(parsed)) {
          this.offset = parsed;
        }
      }
    } catch {
      // Start from 0 if can't read
    }
  }

  /**
   * Save current offset to state file.
   */
  private saveOffset(): void {
    ensureDir(this.stateDir);
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      writeFileSync(offsetFile, String(this.offset), 'utf-8');
    } catch {
      // Ignore write errors
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
