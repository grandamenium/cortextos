import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir } from '../utils/atomic.js';

export type MessageHandler = (msg: TelegramMessage) => void;
export type CallbackHandler = (query: TelegramCallbackQuery) => void;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void;

/**
 * Long-poll window (seconds) handed to getUpdates. Telegram holds the request
 * open until an update arrives or this elapses, so idle bots make ~1 request
 * per (LONG_POLL_SECONDS + pollInterval) instead of 1/sec — a ~25x cut in idle
 * API traffic with no added message latency (long-poll returns the instant an
 * update arrives). Must stay below the getUpdates HTTP abort in TelegramAPI
 * (which scales its abort to this value); see api.ts (A:F-08).
 */
const LONG_POLL_SECONDS = 25;

/** Outcome classification for a failed poll cycle (#C1 poll-error split). */
export type PollErrorPlan =
  | { type: 'conflict' }
  | { type: 'rate-limit'; delayMs: number; nextNetFailures: number }
  | { type: 'network'; delayMs: number; circuitTripped: boolean; nextNetFailures: number };

const POLL_BACKOFF_BASE_MS = 1000;
const POLL_BACKOFF_CAP_MS = 60_000;
/** Consecutive network failures before we emit a circuit-breaker log line. */
const POLL_CIRCUIT_THRESHOLD = 5;

/**
 * Classify a poll-loop error and decide the next-poll delay (#C1). Pure: takes
 * the error message and the current consecutive-network-failure count, returns
 * the plan without mutating state or adding jitter (the caller does both, so
 * this stays deterministically testable).
 *
 *  - 409 Conflict       → caller self-dies so the supervisor retakes the lock.
 *  - 429 Too Many Requests → honour the `retry after N` value Telegram sends;
 *                            network-failure streak resets (server was reached).
 *  - network / timeout  → exponential backoff base*2^(n-1) capped, and a
 *                         circuit-breaker log once the streak hits the threshold.
 */
export function planPollError(message: string, netFailures: number): PollErrorPlan {
  if (/conflict/i.test(message)) {
    return { type: 'conflict' };
  }
  if (/too many requests|retry after|\b429\b/i.test(message)) {
    const m = message.match(/retry after (\d+)/i);
    const retryAfterSec = m ? parseInt(m[1], 10) : 1;
    return { type: 'rate-limit', delayMs: Math.max(1, retryAfterSec) * 1000, nextNetFailures: 0 };
  }
  const next = netFailures + 1;
  const delayMs = Math.min(POLL_BACKOFF_BASE_MS * 2 ** (next - 1), POLL_BACKOFF_CAP_MS);
  return { type: 'network', delayMs, circuitTripped: next === POLL_CIRCUIT_THRESHOLD, nextNetFailures: next };
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
  /** Consecutive network/timeout poll failures, for exponential backoff (#C1). */
  private netFailures: number = 0;
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
    while (this.running) {
      try {
        await this.pollOnce();
        // A clean cycle clears the network-failure streak so the next blip
        // starts the exponential backoff from the base again.
        this.netFailures = 0;
        await sleep(this.pollInterval + this.pollJitterMs());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const plan = planPollError(msg, this.netFailures);
        if (plan.type === 'conflict') {
          // Another getUpdates connection holds the lock (e.g. lingering ~60s
          // after a daemon crash). Exit so the supervisor sleeps + retakes the
          // lock rather than hot-looping on Conflict.
          this.lastExitReason = 'conflict-self-die';
          this.running = false;
          return;
        }
        this.netFailures = plan.nextNetFailures;
        if (plan.type === 'rate-limit') {
          console.error(`[telegram-poller] 429 Too Many Requests — backing off ${plan.delayMs}ms (retry-after honoured)`);
        } else {
          console.error('[telegram-poller] Poll error:', err);
          if (plan.circuitTripped) {
            console.error(
              `[telegram-poller] CIRCUIT: ${this.netFailures} consecutive network failures — ` +
              `sustained outage; continuing with capped backoff.`
            );
          }
        }
        // Per-agent jitter de-syncs the fleet so retries do not thunder back
        // in lockstep after a shared outage or rate-limit window (#C1).
        await sleep(plan.delayMs + this.pollJitterMs());
      }
    }
  }

  /** Random per-cycle jitter (0–500ms) to spread fleet-wide poll/retry timing. */
  private pollJitterMs(): number {
    return Math.floor(Math.random() * 500);
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
    const result = await this.api.getUpdates(this.offset, LONG_POLL_SECONDS);
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
