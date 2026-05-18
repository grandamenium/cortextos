import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir } from '../utils/atomic.js';

export type MessageHandler = (msg: TelegramMessage) => void;
export type CallbackHandler = (query: TelegramCallbackQuery) => void;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void;

/**
 * Classification of a getUpdates failure. Exponential backoff applies
 * uniformly to every class; the class is surfaced only for richer alert
 * context.
 *  - rate_limit: Telegram 429 "Too Many Requests" / 502 "Bad Gateway". This
 *    is the AM-class self-sabotage amplifier that backoff PRIMARILY kills —
 *    a no-backoff 1s retry loop hammers getUpdates into a rate-limit lockout.
 *  - timeout: 15s fetch AbortSignal fired (wedged TCP).
 *  - network: fetch() itself threw — DNS/offline (PM-class, pure connectivity).
 *  - unknown: anything else.
 */
export type CommsErrorClass = 'rate_limit' | 'timeout' | 'network' | 'unknown';

/** Stable, machine-consumable payload handed to the comms-liveness callbacks. */
export interface CommsDegradedInfo {
  since: string;                 // ISO ts: first failure of this degraded run
  consecutiveFailures: number;
  lastError: string;
  lastErrorClass: CommsErrorClass;
  lastSuccessAt: string | null;  // ISO ts of last successful poll, or null
}

export interface CommsRecoveredInfo {
  recoveredAt: string;           // ISO ts of the recovering successful poll
  downSeconds: number;           // approx seconds spent degraded
  consecutiveFailures: number;   // failures cleared by this recovery
}

/**
 * Guard #2 (in-process comms-liveness) injection points — analyst eve-review
 * 2026-05-18 §4. All optional: a poller constructed without these keeps the
 * legacy behaviour EXCEPT exponential backoff, which is always-on because it
 * is pure self-protection and the PRIMARY mitigation for the AM-class
 * rate-limit self-sabotage. The degraded marker, recovery callbacks and
 * in-process restart only engage when the caller opts this poller in as the
 * comms-liveness-managed instance (the main agent poller — not the
 * activity-channel one).
 */
export interface TelegramPollerOptions {
  /**
   * Mint a fresh TelegramAPI bound to the same bot token. Used by the
   * in-process restart to shed a wedged keep-alive socket / fetch agent
   * WITHOUT killing the daemon. If omitted, restart still reloads the
   * persisted offset but reuses the existing client.
   */
  recreateApi?: () => TelegramAPI;
  /** Fired once when the poller enters sustained-failure (degraded) state. */
  onCommsDegraded?: (info: CommsDegradedInfo) => void;
  /** Fired once when a degraded poller recovers. */
  onCommsRecovered?: (info: CommsRecoveredInfo) => void;
}

/**
 * Telegram polling loop. Replaces the Telegram portion of fast-checker.sh.
 * Polls getUpdates and routes messages/callbacks to handlers.
 *
 * Guard #2 — in-process comms-liveness detector (analyst eve-review §4).
 * Architecturally DISTINCT from the fast-checker 50-minute heartbeat
 * watchdog: that watches *agent*-liveness via a file write and has no
 * poller-restart path at any interval; this watches *comms*-liveness with a
 * sub-minute / ≤2-minute recovery SLA, in-process at the poller level
 * (external monitoring is structurally disqualified — measured flap windows
 * were sub-90s). Three components, priority order:
 *   (i)   exponential backoff on poll-failure — PRIMARY, always-on; kills the
 *         AM-class rate-limit self-sabotage (1s→2s→4s→…→max 60s).
 *   (ii)  poll-fail-count threshold → explicit in-process poller restart
 *         (stop/start equivalent), ≤2min SLA.
 *   (iii) durable, filesystem-local out-of-band signal (.comms-degraded
 *         marker + injected logEvent sink) — survives the very outage it
 *         signals; never a single fragile Telegram HTTP call.
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

  // ── Guard #2 state ──────────────────────────────────────────────────────────
  private consecutiveFailures = 0;
  private degraded = false;
  private degradedSince: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError = '';
  private lastErrorClass: CommsErrorClass = 'unknown';
  private commsManaged = false;
  private recreateApi?: () => TelegramAPI;
  private onCommsDegraded?: (info: CommsDegradedInfo) => void;
  private onCommsRecovered?: (info: CommsRecoveredInfo) => void;

  // Backoff doubles per consecutive failure, capped. Cumulative sleep reaches
  // ≈123s by the 7th failure (1+2+4+8+16+32+60) — head-room under the
  // analyst-measured ~11.5min self-recovery margin and the basis for the
  // ≤2min restart SLA.
  private static readonly BACKOFF_MAX_MS = 60_000;
  // Sustained-failure → out-of-band alert. ~31s of solid failure (1+2+4+8+16):
  // long enough not to fire on a single transient blip, fast enough that Dan
  // is not silently blind.
  private static readonly DEGRADED_AFTER_FAILS = 5;
  // In-process poller restart (stop/start equivalent) — ≈123s cumulative ⇒
  // ≤2min SLA per analyst §4 (NOT the 50min agent watchdog).
  private static readonly RESTART_AFTER_FAILS = 7;
  // Re-attempt the restart periodically while still wedged (~every 5min at cap).
  private static readonly RESTART_RETRY_EVERY = 5;
  // Stable contract for an external relay (Guard #2 last-mile — out of scope
  // here; analyst §4 assigns it to an external watchdog).
  private static readonly DEGRADED_MARKER = '.comms-degraded';
  private static readonly DEGRADED_MARKER_SCHEMA = 1;

  /**
   * @param api Telegram API client scoped to a single bot token.
   * @param stateDir Directory for persisted poller state (offset, dedup,
   *   .comms-degraded marker).
   * @param pollInterval Milliseconds between getUpdates calls (and the
   *   exponential-backoff base).
   * @param offsetFileSuffix Optional distinct suffix for the offset file.
   *   When omitted (default), offset persists to `.telegram-offset`. When
   *   provided, offset persists to `.telegram-offset-<suffix>`. Use this
   *   when running a second poller in the same stateDir against a
   *   different bot token (e.g. an activity-channel bot alongside the
   *   agent's own bot), so the two pollers do not clobber each other's
   *   offsets.
   * @param opts Guard #2 comms-liveness injection points (see
   *   TelegramPollerOptions). Omit for backoff-only behaviour.
   */
  constructor(
    api: TelegramAPI,
    stateDir: string,
    pollInterval: number = 1000,
    offsetFileSuffix?: string,
    opts?: TelegramPollerOptions,
  ) {
    this.api = api;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.offsetFileName = offsetFileSuffix
      ? `.telegram-offset-${offsetFileSuffix}`
      : '.telegram-offset';
    this.recreateApi = opts?.recreateApi;
    this.onCommsDegraded = opts?.onCommsDegraded;
    this.onCommsRecovered = opts?.onCommsRecovered;
    // Opt-in as the comms-liveness-managed poller (degraded marker + restart +
    // recovery callbacks). Backoff stays always-on regardless.
    this.commsManaged = !!(opts && (opts.recreateApi || opts.onCommsDegraded || opts.onCommsRecovered));
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
   *
   * On a successful poll the loop sleeps the normal pollInterval. On a
   * failed poll it sleeps an exponentially-growing, capped delay (Guard #2
   * component (i)) and — when comms-managed — escalates to a durable
   * out-of-band signal (iii) and an in-process restart (ii).
   */
  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      let failed = false;
      try {
        await this.pollOnce();
      } catch (err) {
        failed = true;
        this.handlePollFailure(err);
      }
      if (!failed) this.handlePollSuccess();
      if (!this.running) break;
      await sleep(this.computeSleepMs(failed));
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
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
   *
   * Note: a handler throwing returns early WITHOUT throwing out of pollOnce,
   * so it is not treated as a comms failure (it is not — the network is
   * fine). Only a getUpdates/network/rate-limit failure propagates and
   * drives Guard #2 backoff.
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

  // ── Guard #2 — comms-liveness (analyst eve-review §4) ───────────────────────

  /**
   * (i) Exponential backoff. Success (or no failures yet) → normal interval.
   * Failure → pollInterval × 2^(n-1), capped at BACKOFF_MAX_MS. Always-on:
   * this is the PRIMARY mitigation and pure self-protection (it also stops
   * the activity-channel poller hammering during an outage).
   */
  private computeSleepMs(failed: boolean): number {
    if (!failed || this.consecutiveFailures === 0) return this.pollInterval;
    const exp = this.pollInterval * Math.pow(2, this.consecutiveFailures - 1);
    return Math.min(exp, TelegramPoller.BACKOFF_MAX_MS);
  }

  private handlePollSuccess(): void {
    const wasDegraded = this.degraded;
    const clearedFailures = this.consecutiveFailures;
    const since = this.degradedSince;

    this.consecutiveFailures = 0;
    this.lastSuccessAt = new Date().toISOString();

    if (!this.commsManaged) return;

    if (wasDegraded) {
      this.degraded = false;
      this.degradedSince = null;
      const downSeconds = since
        ? Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000))
        : 0;
      try {
        this.onCommsRecovered?.({
          recoveredAt: this.lastSuccessAt,
          downSeconds,
          consecutiveFailures: clearedFailures,
        });
      } catch {
        /* alert sink must never break the poll loop */
      }
    }
    // Clear the marker — including a stale one left by a previous process
    // (first successful poll is the authoritative "comms ok" signal).
    this.clearDegradedMarker();
  }

  private handlePollFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorClass = classifyCommsError(this.lastError);
    console.error(
      `[telegram-poller] Poll error (#${this.consecutiveFailures}, ${this.lastErrorClass}): ${this.lastError}`,
    );

    if (!this.commsManaged) return;

    // (iii) Out-of-band signal on sustained failure — durable, filesystem-
    // local, survives the very outage it signals.
    if (this.consecutiveFailures === TelegramPoller.DEGRADED_AFTER_FAILS) {
      this.degraded = true;
      this.degradedSince = new Date().toISOString();
    }
    if (this.degraded) {
      this.writeDegradedMarker();
      if (this.consecutiveFailures === TelegramPoller.DEGRADED_AFTER_FAILS) {
        try {
          this.onCommsDegraded?.({
            since: this.degradedSince as string,
            consecutiveFailures: this.consecutiveFailures,
            lastError: this.lastError,
            lastErrorClass: this.lastErrorClass,
            lastSuccessAt: this.lastSuccessAt,
          });
        } catch {
          /* alert sink must never break the poll loop */
        }
      }
    }

    // (ii) In-process poller restart (stop/start equivalent), ≤2min SLA, then
    // periodically re-attempted while still wedged.
    const over = this.consecutiveFailures - TelegramPoller.RESTART_AFTER_FAILS;
    if (over >= 0 && over % TelegramPoller.RESTART_RETRY_EVERY === 0) {
      this.restartPollerInProcess();
    }
  }

  /**
   * In-process equivalent of stop()+start() for the poll machinery: re-mint
   * the API client (sheds a wedged keep-alive socket / fetch agent) and
   * reload the persisted offset, WITHOUT killing the daemon process. A
   * literal stop()+start() recursion is deliberately avoided — start() is
   * the currently-executing loop, so recursing would stack loops and grow
   * the call stack unboundedly. This realises the analyst-§4 intent (clean
   * restart of a wedged-but-alive retry loop) safely and in-process.
   */
  private restartPollerInProcess(): void {
    console.error(
      `[telegram-poller] In-process restart after ${this.consecutiveFailures} consecutive failures`,
    );
    try {
      if (this.recreateApi) this.api = this.recreateApi();
    } catch (e) {
      console.error('[telegram-poller] recreateApi failed:', e);
    }
    this.loadOffset();
  }

  /**
   * Durable comms-degraded marker for an external relay (Guard #2 last-mile,
   * out of this scope — analyst §4 assigns the relay to an external
   * watchdog). STABLE PATH: `<stateDir>/.comms-degraded`. STABLE JSON schema
   * (schema_version 1) — fields a relay can rely on:
   *   schema_version       : number
   *   state                : "degraded"  (file present ⇒ degraded; absent ⇒ ok)
   *   since                : ISO ts      (degradation start)
   *   consecutive_failures : number
   *   last_ok              : ISO ts | null  (last successful poll)
   *   updated              : ISO ts      (marker last refreshed — liveness)
   * Context extras (not required by relays): last_error, last_error_class,
   * detector. Best-effort: a write failure never blocks the poll loop.
   */
  private writeDegradedMarker(): void {
    try {
      const payload = {
        schema_version: TelegramPoller.DEGRADED_MARKER_SCHEMA,
        state: 'degraded',
        since: this.degradedSince,
        consecutive_failures: this.consecutiveFailures,
        last_ok: this.lastSuccessAt,
        updated: new Date().toISOString(),
        last_error: this.lastError,
        last_error_class: this.lastErrorClass,
        detector: 'guard2-poller-in-process',
      };
      writeFileSync(
        join(this.stateDir, TelegramPoller.DEGRADED_MARKER),
        JSON.stringify(payload, null, 2),
        'utf-8',
      );
    } catch {
      /* best-effort — the marker is secondary to staying in the loop */
    }
  }

  private clearDegradedMarker(): void {
    try {
      const p = join(this.stateDir, TelegramPoller.DEGRADED_MARKER);
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* best-effort */
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

/**
 * Classify a getUpdates failure message. Backoff applies uniformly; the
 * class only enriches the out-of-band signal so a human/relay can tell an
 * AM-class rate-limit lockout from a pure network partition.
 */
function classifyCommsError(message: string): CommsErrorClass {
  if (/Too Many Requests|\b429\b|Bad Gateway|\b502\b/i.test(message)) return 'rate_limit';
  if (/timed out|TimeoutError|AbortError/i.test(message)) return 'timeout';
  if (/request failed|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(message)) {
    return 'network';
  }
  return 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
