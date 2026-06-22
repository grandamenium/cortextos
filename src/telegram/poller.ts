import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { BusPaths, TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir } from '../utils/atomic.js';
import { logEvent } from '../bus/event.js';

export type MessageHandler = (msg: TelegramMessage) => void;
export type CallbackHandler = (query: TelegramCallbackQuery) => void;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void;

export interface TelegramPollerObservability {
  paths?: BusPaths;
  agentName?: string;
  org?: string;
  log?: (m: string) => void;
}

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
  private observability?: TelegramPollerObservability;
  /**
   * Why the poll loop last exited. Read by AgentManager's poller-supervisor
   * (#459 supervision-gap fix) to decide whether to restart:
   *   - 'stopped-externally': intentional stop() (stopAgent) — do NOT restart.
   *   - 'conflict-self-die': a Telegram 409 Conflict (another getUpdates
   *     holder owns the lock, e.g. a not-yet-released connection after a
   *     daemon crash) — the loop exits so the supervisor can sleep 30s and
   *     retake the lock instead of hot-looping on Conflict.
   *   - '' : loop still running / never exited.
   */
  lastExitReason: string = '';

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
  constructor(
    api: TelegramAPI,
    stateDir: string,
    pollInterval: number = 1000,
    offsetFileSuffix?: string,
    observability?: TelegramPollerObservability,
  ) {
    this.api = api;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.observability = observability;
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
    while (this.running) {
      try {
        await this.pollOnce();
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
        // A 401 Unauthorized means the BOT_TOKEN is invalid or not yet loaded.
        // This is a PERMANENT failure, not transient — retrying getUpdates once
        // per second never clears it. Exit the loop so the supervisor backs off
        // instead of hot-looping. (2026-06-22 OOM: a stale token spammed ~1
        // error/sec for days → 95k errors → 785MB log → daemon killed.)
        if (/Unauthorized|\b401\b/i.test(msg)) {
          console.error('[telegram-poller] Auth failure (401 Unauthorized) — BOT_TOKEN invalid or unloaded. Exiting loop; supervisor will back off.');
          this.lastExitReason = 'auth-failed';
          this.running = false;
          return;
        }
        // Other errors are transient — log and continue polling.
        console.error('[telegram-poller] Poll error:', err);
      }
      await sleep(this.pollInterval);
    }
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
      const updateType = detectUpdateType(update);
      let handlerFailed = false;

      this.observability?.log?.(`[telegram-poller] update_id=${update.update_id} type=${updateType}`);

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

      if (!update.message && !update.callback_query && !update.message_reaction) {
        const keys = Object.keys(update);
        console.warn(`[telegram-poller] UNKNOWN update shape: update_id=${update.update_id} keys=${keys.join(',')}`);
        if (this.observability?.paths && this.observability.agentName && this.observability.org) {
          logEvent(this.observability.paths, this.observability.agentName, this.observability.org, 'error', 'telegram_unknown_update', 'warning', {
            update_id: update.update_id,
            keys,
          });
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

function detectUpdateType(update: TelegramUpdate): 'message' | 'callback_query' | 'message_reaction' | 'unknown' {
  if (update.message) return 'message';
  if (update.callback_query) return 'callback_query';
  if (update.message_reaction) return 'message_reaction';
  return 'unknown';
}
