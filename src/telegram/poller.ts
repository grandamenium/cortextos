import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir } from '../utils/atomic.js';

export type MessageHandler = (msg: TelegramMessage) => void;
export type CallbackHandler = (query: TelegramCallbackQuery) => void;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void;

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
   * Why the poll loop last exited. Read by AgentManager's poller-supervisor
   * (#459 supervision-gap fix) to decide whether to restart:
   *   - 'stopped-externally': intentional stop() (stopAgent) — do NOT restart.
   *   - 'conflict-self-die': a Telegram 409 Conflict (another getUpdates
   *     holder owns the lock, e.g. a not-yet-released connection after a
   *     daemon crash) — the loop exits so the supervisor can sleep 30s and
   *     retake the lock instead of hot-looping on Conflict.
   *   - 'network-self-die': a run of consecutive network-layer failures
   *     (undici "fetch failed", DNS, socket resets, 15s timeouts). Looping in
   *     place reuses a wedged keep-alive socket forever (the 2026-07-22
   *     "Telegram stuck for 2 days" incident), so the loop exits and the
   *     supervisor sleeps ~30s — long enough for the idle socket to close —
   *     then restarts with a fresh connection. Retried indefinitely (an
   *     outage must never become permanent silence), unlike Conflict.
   *   - '' : loop still running / never exited.
   */
  lastExitReason: string = '';

  /**
   * Consecutive network-layer failures seen since the last clean poll. Reset
   * to 0 on any successful pollOnce. When it reaches
   * NETWORK_SELF_DIE_THRESHOLD the loop exits with 'network-self-die' so the
   * supervisor can rebuild the connection (see lastExitReason).
   */
  private consecutiveNetErrors: number = 0;

  /**
   * How many consecutive network failures to tolerate before self-dying. At
   * the default 1s poll interval this is ~5s of hard failure before restart —
   * long enough to ride out a one-off blip, short enough that a wedged socket
   * pool cannot strand inbound Telegram for hours.
   */
  private static readonly NETWORK_SELF_DIE_THRESHOLD = 5;

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
    this.lastExitReason = '';
    this.consecutiveNetErrors = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        // A clean poll proves the network path is healthy — reset the budget
        // so an earlier transient blip cannot accumulate toward self-die.
        this.consecutiveNetErrors = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A 409 Conflict means another getUpdates connection holds the lock
        // (e.g. a not-yet-released connection lingering ~60s after a daemon
        // crash). Exit the loop with a distinct reason so the supervisor can
        // sleep and retake the lock, rather than hot-looping on Conflict.
        if (/Conflict/i.test(msg)) {
          this.lastExitReason = 'conflict-self-die';
          this.running = false;
          return;
        }
        console.error('[telegram-poller] Poll error:', err);
        // Persistent network-layer failures do NOT self-heal by looping in
        // place — a wedged keep-alive socket in the process-global fetch pool
        // keeps throwing until the connection is torn down (the 2026-07-22
        // 2-day outage). After NETWORK_SELF_DIE_THRESHOLD consecutive network
        // failures, exit so the supervisor sleeps ~30s (idle socket closes)
        // and restarts on a fresh connection. Application errors (bad token,
        // malformed request) restart won't fix, so they don't count here.
        if (this.isNetworkError(msg)) {
          if (++this.consecutiveNetErrors >= TelegramPoller.NETWORK_SELF_DIE_THRESHOLD) {
            this.lastExitReason = 'network-self-die';
            this.running = false;
            return;
          }
        } else {
          this.consecutiveNetErrors = 0;
        }
      }
      await sleep(this.pollInterval);
    }
  }

  /**
   * Classify an error message as a transient network-layer failure that a
   * fresh connection would likely clear — as opposed to a Telegram
   * application error (bad token, malformed request) that a restart won't
   * fix. Matches the two wrappers emitted by TelegramAPI.post ("request
   * failed", "request timed out") plus raw socket/DNS codes in case they
   * ever surface unwrapped.
   */
  private isNetworkError(msg: string): boolean {
    return /request failed|request timed out|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up|other side closed|UND_ERR/i.test(msg);
  }

  /**
   * Stop the polling loop. Marks the exit as intentional so the supervisor
   * does not restart it.
   */
  stop(): void {
    this.running = false;
    this.lastExitReason = 'stopped-externally';
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
  async pollOnce(): Promise<void> {
    const result = await this.api.getUpdates(this.offset, 1);
    if (!result?.result?.length) return;

    for (const update of result.result as TelegramUpdate[]) {
      const nextOffset = update.update_id + 1;
      let handlerFailed = false;

      if (update.message) {
        for (const handler of this.messageHandlers) {
          try {
            handler(update.message);
          } catch (err) {
            console.error('[telegram-poller] Message handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.callback_query) {
        for (const handler of this.callbackHandlers) {
          try {
            handler(update.callback_query);
          } catch (err) {
            console.error('[telegram-poller] Callback handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.message_reaction) {
        for (const handler of this.reactionHandlers) {
          try {
            handler(update.message_reaction);
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
