import type { MessageConnector } from '../connector.js';
import type {
  ConnectorCapabilities,
  ValidateResult,
  SendOptions,
  SendResult,
  PollingHandlers,
  TelegramConnectorEnv,
  NormalizedMessage,
  NormalizedReactionPayload,
  ConnectorReaction,
  ConnectorAction,
  CallbackPayload,
} from '../types.js';
import { resolve as resolvePath } from 'path';
import { TelegramAPI } from './api.js';
import { TelegramPoller } from './poller.js';
import { processMediaMessage, type ProcessedMedia, type MediaLimits } from './media.js';
import type {
  NormalizedMedia,
} from '../types.js';
import type {
  TelegramMessage,
  TelegramCallbackQuery,
  TelegramMessageReaction,
} from '../../types/index.js';
import { stripControlChars } from '../../utils/validate.js';

/**
 * Sentinel thrown by the connector's poller-onMessage handler when
 * `stopInbound()` bumped the generation counter during an in-flight
 * media-pipeline await. The poller treats any thrown handler as failure
 * (poller.ts:117-122) and leaves the offset un-advanced — so the
 * update redelivers on the next `getUpdates`. The agent that restarts
 * after the stop sees the media correctly under the new generation.
 *
 * Pre-PR4-c14 the generation guard returned `undefined` (handler
 * "succeeded"); the poller advanced the offset and the media was
 * permanently dropped. Codex round-2 P0.B.
 */
class GenerationMismatchError extends Error {
  constructor() {
    super('telegram-connector: pollGeneration mismatch — stopInbound fired during in-flight handler');
    this.name = 'GenerationMismatchError';
  }
}

/**
 * Max retries per media message before degrading to text-only.
 * Telegram redelivers acked-but-failed updates on each getUpdates poll
 * (poller advances offset only on handler success); without a cap, a
 * permanently-broken media message wedges the inbound loop. PR4 c18
 * (Codex round-3 P1.R3-1A).
 *
 * Three attempts is a balance: a transient outage (network blip, brief
 * Telegram getFile 5xx) almost always recovers within 3 polls (~3s at
 * the default 1000ms poll interval). Beyond that the agent is better
 * served by the caption text than by waiting indefinitely for the
 * media.
 */
const MEDIA_MAX_RETRIES = 3;

/**
 * Derive a human-readable reply-context string from a Telegram replied-to
 * message. Priority: text > caption > media-type label.
 *
 * Moved out of `src/daemon/agent-manager.ts` in PR4 commit 2 of the
 * pluggable-connectors stack — the daemon should not be inspecting
 * Telegram-specific fields (`replyMsg.video`, `replyMsg.voice`, etc.) to
 * render reply context. The connector now populates
 * `NormalizedMessage.reply_to.text` from this helper at normalization
 * time, so the daemon's onMessage path is provider-agnostic.
 *
 * Exported so the connector's unit tests can pin the per-media-kind
 * label rendering directly without spinning up a full connector.
 */
export function buildTelegramReplyContext(
  replyMsg: TelegramMessage | undefined,
): string | undefined {
  if (!replyMsg) return undefined;
  if (replyMsg.text) return stripControlChars(replyMsg.text);
  if (replyMsg.caption) return stripControlChars(replyMsg.caption);
  if (replyMsg.video) return '[video]';
  if (replyMsg.video_note) return '[video note]';
  if (replyMsg.photo) return '[photo]';
  if (replyMsg.voice) return '[voice message]';
  if (replyMsg.audio) return '[audio]';
  if (replyMsg.document) return `[document: ${replyMsg.document.file_name ?? 'file'}]`;
  return undefined;
}

/**
 * `MessageConnector` implementation that wraps the existing
 * `TelegramAPI` + `TelegramPoller` (kept in this same directory after
 * the move from `src/telegram/`). Behavior matches today's daemon
 * byte-for-byte; the connector is a thin adapter so daemon/bus/PTY
 * code can talk to a generic interface instead of importing
 * Telegram-specific classes.
 */
export class TelegramConnector implements MessageConnector {
  readonly kind = 'telegram' as const;
  readonly capabilities: ConnectorCapabilities = {
    inlineButtons: true,
    media: true,
    voiceTranscription: true,
    formattedText: true,
    inbound: 'poll',
    typingIndicator: true,
    reactions: true,
    outboundReactions: true,
    interactiveCallbacks: true,
    messageEdits: true,
    // PR4 c20: Telegram has no first-class threads (forum supergroup
    // topics are chat-level, not message-level), no first-class block
    // schema (HTML/Markdown inside sendMessage covers basic
    // formatting but not card-style UX), and no presence event stream
    // for bots. False on all three; future connectors (Discord,
    // Mattermost, RocketChat, Matrix) advertise true.
    threads: false,
    richBlocks: false,
    presence: false,
  };

  private readonly api: TelegramAPI;
  private readonly chatId: string;
  private readonly allowedUserId?: number;
  private readonly agentDir: string;
  private readonly pollerNamespace?: string;
  private readonly downloadDir?: string;
  private readonly mediaLimits: MediaLimits;
  private poller: TelegramPoller | null = null;
  /**
   * Monotonic generation counter incremented on every `stopInbound()`.
   * Async work kicked off inside the poller handler (today: the media-
   * enrichment pipeline) snapshots this at entry and re-checks after
   * each await. A mismatch means stopInbound fired during the await —
   * the in-flight delivery is suppressed so a stopped/restarted agent
   * does not receive stale media. Without this guard the daemon would
   * inject media originated against the previous PTY lifecycle into
   * the next one.
   */
  private pollGeneration: number = 0;

  /**
   * Per-message retry counter for the media-enrichment pipeline. PR4
   * c14 (Codex round-2 P0.A) made transient `processMediaMessage`
   * failures rethrow so the poller doesn't ACK the update — Telegram
   * redelivers and we retry. But a persistently-failing media message
   * (the connector itself has a bug, the file is corrupted, etc.)
   * would wedge the inbound loop in an infinite redelivery cycle.
   *
   * PR4 c18 (Codex round-3 P1.R3-1A) caps the retry count per
   * `tgMsg.message_id` at MEDIA_MAX_RETRIES. Once exhausted, the
   * connector degrades to text-only delivery (the agent still sees
   * the caption + sender) and clears the counter. The map is
   * in-memory only; a restart resets all counts, which is the right
   * behavior (a transient outage that recovers during downtime gets
   * the original retry budget back).
   *
   * Cleared on `stopInbound`.
   */
  private mediaRetryCount = new Map<number, number>();

  /**
   * `opts.pollerNamespace`: passed through to TelegramPoller as the
   * `offsetFileSuffix` so multiple TelegramConnector instances sharing
   * a stateDir (agent's primary connector + org's activity-channel
   * connector, today's only case) keep their offset files distinct —
   * primary uses `.telegram-offset`, activity uses
   * `.telegram-offset-activity`. Added in PR3 of the pluggable-
   * connectors stack so activity-channel pluggability can land.
   *
   * `opts.downloadDir`: when set, the connector's inbound polling
   * pipeline downloads media (photo/document/voice/audio/video/
   * video_note) to this directory and emits a `NormalizedMessage`
   * with `media` populated. When unset (e.g. activity-channel
   * connector — outbound primarily, inbound is logged-only), media
   * flags on inbound messages are ignored and a text-only normalized
   * message is emitted. Added in PR4 of the pluggable-connectors
   * stack (first-class `NormalizedMessage.media`).
   *
   * `opts.mediaLimits`: DoS-protection caps for the media pipeline
   * (PR4 c5 / Codex P0.2). Defaults: 20 MB per file, 500 MB total
   * quota per downloadDir. Override to `{ perFileBytes: undefined,
   * totalQuotaBytes: undefined }` to disable both (tests that need
   * full backwards compatibility). Both limits enforced inside
   * `processMediaMessage`. See src/connectors/telegram/media.ts.
   */
  constructor(
    agentDir: string,
    env: TelegramConnectorEnv,
    opts?: { pollerNamespace?: string; downloadDir?: string; mediaLimits?: MediaLimits },
  ) {
    this.agentDir = agentDir;
    this.api = new TelegramAPI(env.BOT_TOKEN);
    this.chatId = env.CHAT_ID;
    this.allowedUserId = env.ALLOWED_USER ? parseInt(env.ALLOWED_USER, 10) : undefined;
    this.pollerNamespace = opts?.pollerNamespace;
    // PR4 c13 (Codex P2.6 NORMALIZED_MEDIA_ABSOLUTE_PATH_NOT_ENFORCED):
    // resolve the caller-supplied downloadDir to an absolute path at
    // construction time. The spec promises NormalizedMedia.localPath is
    // absolute (rules in §4) but processMediaMessage writes via
    // `path.join(downloadDir, ...)` which preserves whatever shape the
    // caller passed. Resolving here means every code path downstream
    // (media writes, BUG-046 path-relativization, future Discord/
    // Mattermost connectors copying the pattern) sees an absolute root.
    this.downloadDir = opts?.downloadDir !== undefined ? resolvePath(opts.downloadDir) : undefined;
    // Defaults: 20 MB per file (matches Telegram's stated bot-API ceiling
    // for downloads); 500 MB total quota per downloadDir (sane fallback
    // — agents that need more override). `undefined` in opts.mediaLimits
    // means "use defaults"; explicit `undefined` on a sub-field disables
    // that specific cap.
    this.mediaLimits = {
      perFileBytes: opts?.mediaLimits && 'perFileBytes' in opts.mediaLimits
        ? opts.mediaLimits.perFileBytes
        : 20 * 1024 * 1024,
      totalQuotaBytes: opts?.mediaLimits && 'totalQuotaBytes' in opts.mediaLimits
        ? opts.mediaLimits.totalQuotaBytes
        : 500 * 1024 * 1024,
    };
  }

  /**
   * `@internal @deprecated PR2` — temporary legacy callback bridge.
   *
   * Allowed callers (enforced by CI grep guard in
   * `tests/lint-no-stray-raw-api.test.ts`):
   *   - `src/daemon/agent-process.ts` inside `setConnector(c)` — the
   *     `instanceof TelegramConnector` branch reads this to populate the
   *     legacy `telegramApi`/`telegramChatId` fields so the
   *     CodexAppServerPTY session-refresh path (agent-process.ts:126-128)
   *     and FastChecker callback edit/answer paths (PR1 Telegram-direct
   *     exceptions) keep working.
   *   - `src/daemon/agent-manager.ts` reads this once at construction so
   *     the shared TelegramAPI instance feeds the legacy `telegramApi`
   *     variable (Codex M2.cr — avoids constructing TelegramAPI twice
   *     against the same bot token).
   *   - The connector class's own unit + integration tests under
   *     `tests/unit/connectors/` and `tests/integration/`.
   *
   * Do not add new callers. PR2 introduces the proper interactive-
   * message lifecycle abstraction and removes this method.
   */
  rawTelegramApi(): TelegramAPI {
    return this.api;
  }

  /** Telegram chat id this connector is bound to. */
  getChatId(): string {
    return this.chatId;
  }

  /** Numeric allowed-user id (Telegram numeric user id), or undefined. */
  getAllowedUserId(): number | undefined {
    return this.allowedUserId;
  }

  async validateCredentials(): Promise<ValidateResult> {
    try {
      const result = await this.api.validateCredentials(this.chatId);
      if (result.ok) {
        const title = result.chatTitle ? ` "${result.chatTitle}"` : '';
        return {
          ok: true,
          identity: `@${result.botUsername} → ${result.chatType}${title}`,
        };
      }
      // Map Telegram-specific reasons to generic ones
      const generic: ValidateResult = (() => {
        switch (result.reason) {
          case 'bad_token':
          case 'self_chat':
            return { ok: false, reason: 'bad_credentials' as const, detail: result.detail };
          case 'chat_not_found':
          case 'bot_recipient':
            return { ok: false, reason: 'unreachable_recipient' as const, detail: result.detail };
          case 'network_error':
            return { ok: false, reason: 'network_error' as const, detail: result.detail };
          case 'rate_limited':
            return { ok: false, reason: 'rate_limited' as const, detail: result.detail };
        }
      })();
      return generic;
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async sendMessage(text: string, opts?: SendOptions): Promise<SendResult> {
    // PR4 c9 (Codex P1.G): SendOptions.buttons is a 2D array of
    // ConnectorAction. Translate to Telegram inline_keyboard at the
    // boundary — Telegram doesn't use `style`, so we drop it. Future
    // Discord / Mattermost / RocketChat translations would consume
    // `style` to map to the provider's native button color.
    const replyMarkup = opts?.buttons
      ? { inline_keyboard: opts.buttons.map((row) => row.map(this.toTelegramButton)) }
      : undefined;
    // SendOptions.parseMode: 'markdown' | 'plain' | null → TelegramAPI parseMode: 'HTML' | null
    // 'plain' or explicit null disables HTML; 'markdown' or absence enables (TelegramAPI does Markdown→HTML internally).
    const parseMode = opts?.parseMode === 'plain' || opts?.parseMode === null ? null : 'HTML';
    const result = await this.api.sendMessage(this.chatId, text, replyMarkup, { parseMode });
    // TelegramAPI returns the full response shape { ok, result } — extract
    // message_id from result.result; fall back to '' if absent (e.g. an empty
    // multi-chunk send where the last chunk has no body).
    return {
      id: String(result?.result?.message_id ?? ''),
      ts: Date.now(),
    };
  }

  async sendMedia(media: {
    localPath: string;
    caption?: string;
    kind: 'photo' | 'document';
  }): Promise<SendResult> {
    const result =
      media.kind === 'photo'
        ? await this.api.sendPhoto(this.chatId, media.localPath, media.caption)
        : await this.api.sendDocument(this.chatId, media.localPath, media.caption);
    // TelegramAPI returns the full response shape { ok, result } — extract
    // message_id from result.result; fall back to '' if absent (e.g. an empty
    // multi-chunk send where the last chunk has no body).
    return {
      id: String(result?.result?.message_id ?? ''),
      ts: Date.now(),
    };
  }

  /**
   * Start the background polling loop. Resolves AFTER the loop is
   * scheduled — does NOT await its completion. Matches today's
   * `poller.start().catch(...)` fire-and-forget at
   * `src/daemon/agent-manager.ts:455-463`.
   *
   * Note for PR1: the daemon does not currently invoke this method;
   * it continues to construct `TelegramPoller` directly and wire
   * handlers. This method is implemented (and unit-tested) so the
   * interface contract holds, and PR2 will migrate the daemon to use
   * it once hook + CLI generalization is in place.
   */
  async startInbound(handlers: PollingHandlers, opts?: { stateDir?: string }): Promise<void> {
    // PR2 Codex Q5 lock: caller can pass `stateDir` explicitly (the daemon
    // does, to preserve the historical `<ctxRoot>/state/<name>/.telegram-offset`
    // path across the wire migration from direct TelegramPoller construction
    // to connector.startPolling). When omitted, fall back to agentDir — same
    // PR1 behavior for tests that construct TelegramConnector standalone.
    const stateDir = opts?.stateDir ?? this.agentDir;
    // PR4 c4 (Codex P2.2): idempotent re-start. Stop any prior poller
    // (and bump the generation guard) before constructing a new one, so a
    // double-startPolling can't leak two concurrent loops sharing handlers
    // and racing on offset state.
    if (this.poller) {
      await this.stopInbound();
    }
    // 4th arg is offsetFileSuffix — distinguishes the offset file across
    // multiple connector instances sharing a stateDir. Undefined keeps
    // the default `.telegram-offset` filename (byte-identical to PR2).
    this.poller = new TelegramPoller(this.api, stateDir, 1000, this.pollerNamespace);

    const generationAtStart = this.pollGeneration;
    this.poller.onMessage(async (tgMsg: TelegramMessage) => {
      // PR4 c4 (Codex P0.1): media enrichment AWAITS processMediaMessage
      // before the poller advances its offset. The previous .then()
      // pattern let the poller ACK the update with Telegram (advance
      // offset, persist to disk) BEFORE the agent ever saw the
      // media-formatted message — a crash or stopInbound between
      // offset-advance and the .then firing dropped the message
      // permanently because Telegram does not redeliver acked updates.
      // Now the offset only moves after the full pipeline (download +
      // transcription + handler emit) settles.
      //
      // PR4 c14 (Codex round-2 P0.A): exceptions from processMediaMessage
      // RETHROW instead of falling through to text-only. Pre-c14, any
      // transient network blip caught the exception, logged it, then
      // emitted a text-only NormalizedMessage — the handler returned
      // successfully and the poller advanced the offset. Telegram never
      // redelivered, the media payload was permanently lost. Post-c14,
      // only `processMediaMessage`'s explicit `null` return (= known
      // permanent failure: Telegram getFile returned no file_path, the
      // file expired on Telegram's side) triggers text-only fallback.
      // Anything else (network 5xx, download stream abort, disk-write
      // failure) throws out of the handler so the poller leaves the
      // offset un-advanced and Telegram redelivers the update on the
      // next getUpdates call. This matches the same retry-on-throw
      // contract the poller already uses for sync handlers.
      //
      // PR4 c14 (Codex round-2 P0.B): generation guard mismatch now
      // throws GenerationMismatchError instead of silently returning.
      // Pre-c14 the early-return on `this.pollGeneration !==
      // generationAtStart` looked like a successful handler — the
      // poller advanced the offset and Telegram acked the update. Any
      // media in-flight at stop/restart was both suppressed AND
      // permanently ACKed. Post-c14 the throw signals "no delivery
      // happened" so the poller's handlerFailed branch fires and the
      // offset stays put. The update will be re-delivered when the
      // connector restarts; the generation check there will pass under
      // the new generation and the agent gets the media correctly.
      const baseMessage = this.toNormalizedMessage(tgMsg);
      const hasMedia = !!(tgMsg.photo || tgMsg.document || tgMsg.voice || tgMsg.audio || tgMsg.video || tgMsg.video_note);
      if (hasMedia && this.downloadDir) {
        const downloadDir = this.downloadDir;
        // PR4 c18 (Codex round-3 P1.R3-1A): retry cap. Track attempts
        // per tgMsg.message_id; after MEDIA_MAX_RETRIES, degrade to
        // text-only delivery so a permanently-broken media message
        // doesn't wedge the inbound loop forever. The retry counter
        // increments BEFORE the await so an exception path still bumps.
        const attempts = (this.mediaRetryCount.get(tgMsg.message_id) ?? 0) + 1;
        this.mediaRetryCount.set(tgMsg.message_id, attempts);

        let processed = null;
        try {
          processed = await processMediaMessage(tgMsg, this.api, downloadDir, this.mediaLimits);
        } catch (err) {
          if (attempts >= MEDIA_MAX_RETRIES) {
            // Exhausted retries — degrade to text-only delivery so the
            // poller advances past this update. Log the giving-up so
            // operators see the failure mode without flooding (this
            // fires at most once per message — subsequent updates are
            // tracked under their own message_ids).
            console.error(`[connector:telegram] media pipeline exhausted ${MEDIA_MAX_RETRIES} retries for message ${tgMsg.message_id}, degrading to text-only: ${err instanceof Error ? err.message : String(err)}`);
            this.mediaRetryCount.delete(tgMsg.message_id);
            // Fall through to the !processed branch which emits text.
          } else {
            // Re-throw so the poller leaves the offset un-advanced and
            // Telegram redelivers. The retry counter persists.
            throw err;
          }
        }

        if (this.pollGeneration !== generationAtStart) {
          // Throw so the poller's handlerFailed branch leaves the
          // offset un-advanced. Telegram redelivers on restart. The
          // retry counter persists (resets only on stopInbound, but
          // a generation bump means stopInbound already happened).
          throw new GenerationMismatchError();
        }

        if (processed) {
          // Successful delivery — clear the retry counter for this id.
          this.mediaRetryCount.delete(tgMsg.message_id);
          handlers.onMessage({ ...baseMessage, media: this.toNormalizedMedia(processed) });
        } else {
          // Either:
          //   - processMediaMessage returned null (file expired on
          //     Telegram's side, file_path missing — known permanent),
          //   - OR we exhausted retries and degraded above.
          // Either way: emit text-only and clear the counter so future
          // media messages aren't accidentally degraded.
          this.mediaRetryCount.delete(tgMsg.message_id);
          handlers.onMessage(baseMessage);
        }
      } else {
        if (this.pollGeneration !== generationAtStart) {
          throw new GenerationMismatchError();
        }
        handlers.onMessage(baseMessage);
      }
    });

    if (handlers.onCallback) {
      const onCallback = handlers.onCallback;
      this.poller.onCallback((query: TelegramCallbackQuery) => {
        onCallback(this.toCallbackPayload(query));
      });
    }

    if (handlers.onReaction) {
      const onReaction = handlers.onReaction;
      this.poller.onReaction((reaction: TelegramMessageReaction) => {
        onReaction(this.toNormalizedReaction(reaction));
      });
    }

    // Fire-and-forget — DO NOT await. Matches the existing daemon pattern.
    // PR4 c13 (Codex P2.3 POLLER_START_ERRORS_ARE_NOT_OBSERVABLE_BY_CALLER):
    // tagged log line so health-grep can spot terminal poller failures.
    // The `.catch()` already runs INSIDE the connector after the poll
    // loop exits — by the time we land here, the inbound delivery has
    // stopped. A proper health-callback contract (PollingHandlers
    // `onError?`) is tracked for a follow-up PR; for now this log
    // line is the operator's signal.
    this.poller.start().catch((err: unknown) => {
      console.error(`[connector:telegram] inbound loop terminated with error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async stopInbound(): Promise<void> {
    // Bump generation BEFORE clearing the poller — any in-flight async
    // media-pipeline handler that finishes after this call will see the
    // mismatched generation and suppress its `handlers.onMessage` emit.
    // See the generation guard in the poller.onMessage closure above.
    this.pollGeneration += 1;
    if (this.poller) {
      this.poller.stop();
      this.poller = null;
    }
    // PR4 c18: clear media retry counters. A fresh startInbound starts
    // every message with a clean retry budget — a transient outage
    // that recovered during downtime shouldn't burn the post-restart
    // retry budget.
    this.mediaRetryCount.clear();
  }

  async setTypingIndicator(on: boolean): Promise<void> {
    // PR4 c13 (Codex P2.4 SET_TYPING_SPEC_AND_CODE_DISAGREE): the spec
    // (docs/architecture/connectors.md §2 "Capability-gated method
    // semantics") promises callers don't need to wrap this in try/catch
    // because the typing indicator is purely cosmetic. Honor that
    // contract by catching internally so a Telegram outage during a
    // typing-hint emit can't propagate up to the daemon's hot path.
    // The error is logged at a tagged level so ops can grep it without
    // it being load-bearing for any health signal.
    if (on) {
      try {
        await this.api.sendChatAction(this.chatId, 'typing');
      } catch (err) {
        console.error(`[connector:telegram] setTypingIndicator error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // off is a no-op — Telegram auto-clears the typing indicator after ~5s.
  }

  async registerCommands(
    commands: Array<{ name: string; description: string }>,
  ): Promise<void> {
    // Map generic shape to Telegram BotCommand shape.
    const tgCommands = commands.map((c) => ({ command: c.name, description: c.description }));
    await this.api.setMyCommands(tgCommands);
  }

  async acknowledgeCallback(callbackId: string, text?: string): Promise<void> {
    await this.api.answerCallbackQuery(callbackId, text);
  }

  /**
   * Send (or remove) a reaction emoji on a message. PR4 c10 (Codex
   * P1.H) wires Telegram Bot API 7.0+'s `setMessageReaction` into the
   * connector layer.
   *
   * Telegram's contract is "set the bot's reactions on this message to
   * this list", not "add to existing". The connector exposes the
   * narrower add/remove view: `sendReaction(id, emoji)` sets to
   * `[emoji]`, `sendReaction(id, _, { remove: true })` sets to `[]`.
   * To CHANGE the bot's reaction emoji (e.g. swap 🛠 for ✅ on task
   * completion), call sendReaction again with the new emoji — Telegram
   * replaces the old reaction.
   */
  async sendReaction(
    messageId: string,
    emoji: string,
    opts?: { remove?: boolean; isBig?: boolean },
  ): Promise<void> {
    const numericId = Number(messageId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      throw new Error(`sendReaction: invalid Telegram message_id ${JSON.stringify(messageId)}`);
    }
    const reaction = opts?.remove ? [] : [{ type: 'emoji' as const, emoji }];
    await this.api.setMessageReaction(this.chatId, numericId, reaction, opts?.isBig ?? false);
  }

  async editMessage(
    messageId: string,
    text: string,
    opts?: { buttons?: Array<Array<ConnectorAction>> },
  ): Promise<void> {
    // PR4 c9 + P2 Codex EDIT_MESSAGE_ACCEPTS_NAN: Telegram message_ids
    // are numeric; the connector accepts strings for cross-connector
    // consistency (Slack ts is "1690000000.000001", RocketChat _id is
    // opaque) but the wire format here is number. Validate that the
    // string represents a safe integer so a bad id throws a typed error
    // at the call site instead of silently producing a Telegram API
    // failure with NaN. Tests for this live under "editMessage".
    const numericId = Number(messageId);
    // Telegram message_ids are positive integers. Number('') === 0 is a
    // safe integer but not a valid message id, so reject both `<= 0` and
    // non-integers in one check.
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      throw new Error(`editMessage: invalid Telegram message_id ${JSON.stringify(messageId)}`);
    }
    const replyMarkup = opts?.buttons
      ? { inline_keyboard: opts.buttons.map((row) => row.map(this.toTelegramButton)) }
      : undefined;
    await this.api.editMessageText(this.chatId, numericId, text, replyMarkup);
  }

  /**
   * Translate a single connector-agnostic `ConnectorAction` to
   * Telegram's `InlineKeyboardButton` shape. Telegram doesn't render
   * `style` (no button colors in Bot API) so we drop it — future
   * connectors (Discord, Mattermost) consume `style` to map to their
   * native color palette. Arrow form so `.map(this.toTelegramButton)`
   * keeps `this` unbound.
   *
   * PR4 c15 (Codex round-2 P1.C) handles both ConnectorAction variants:
   * - `kind: 'callback'` → Telegram `{text, callback_data}` (default)
   * - `kind: 'url'` → Telegram `{text, url}` (opens external link, no
   *   callback fires; matches Discord ButtonStyle.Link)
   */
  private toTelegramButton = (a: ConnectorAction): { text: string; callback_data: string } | { text: string; url: string } => {
    if (a.kind === 'url') {
      return { text: a.label, url: a.url };
    }
    return { text: a.label, callback_data: a.actionId };
  };

  // ---------------------------------------------------------------------
  // Normalizers — Telegram update shape → generic connector shape
  // ---------------------------------------------------------------------

  private toNormalizedMessage(msg: TelegramMessage): NormalizedMessage {
    // PR4 commit 2: `chat_id` + `reply_to.text` are populated here so the
    // daemon's onMessage hot path no longer reads provider-specific fields
    // off `m.raw`. `reply_to` is set iff the inbound message has a
    // `reply_to_message`; `text` may still be undefined when the replied-
    // to message had no rendering hint (e.g. reply to an unknown sticker).
    const replyTo = msg.reply_to_message
      ? {
          id: String(msg.reply_to_message.message_id),
          text: buildTelegramReplyContext(msg.reply_to_message),
        }
      : undefined;
    return {
      id: String(msg.message_id),
      ts: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
      from: {
        id: msg.from?.id !== undefined ? String(msg.from.id) : '',
        username: msg.from?.username,
        name: msg.from?.first_name,
      },
      text: msg.text ?? msg.caption ?? '',
      chat_id: msg.chat?.id !== undefined ? String(msg.chat.id) : undefined,
      reply_to: replyTo,
      raw: msg,
    };
  }

  private toCallbackPayload(query: TelegramCallbackQuery): CallbackPayload {
    return {
      id: query.id,
      from: {
        id: query.from?.id !== undefined ? String(query.from.id) : '',
        username: query.from?.username,
        name: query.from?.first_name,
      },
      data: query.data ?? '',
      message_id: query.message?.message_id !== undefined ? String(query.message.message_id) : '',
      chat_id: query.message?.chat?.id !== undefined ? String(query.message.chat.id) : undefined,
      raw: query,  // @deprecated PR4+ — kept for the legacy non-connector edit path
    };
  }

  private toNormalizedReaction(reaction: TelegramMessageReaction): NormalizedReactionPayload {
    return {
      id: `${reaction.message_id}-${reaction.date}`,
      ts: reaction.date * 1000,
      from: {
        id: reaction.user?.id !== undefined ? String(reaction.user.id) : '',
        username: reaction.user?.username,
        name: reaction.user?.first_name,
      },
      chat_id: reaction.chat?.id !== undefined ? String(reaction.chat.id) : undefined,
      // PR4 c8 (Codex P1.F): stringify message_id + translate the
      // Telegram tagged-union reaction shape to the connector-agnostic
      // `ConnectorReaction { kind: 'unicode' | 'custom', value: string }`.
      message_id: String(reaction.message_id),
      old_reaction: (reaction.old_reaction ?? []).map(this.toConnectorReaction),
      new_reaction: (reaction.new_reaction ?? []).map(this.toConnectorReaction),
      raw: reaction,
    };
  }

  /** Translate a single Telegram reaction-type variant to the
   *  connector-agnostic `ConnectorReaction` shape. Arrow form so the
   *  `.map(this.toConnectorReaction)` call site keeps `this` un-bound. */
  private toConnectorReaction = (r: { type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }): ConnectorReaction => {
    return r.type === 'emoji'
      ? { kind: 'unicode', value: r.emoji }
      : { kind: 'custom', value: r.custom_emoji_id };
  };

  /**
   * Translate `processMediaMessage`'s `ProcessedMedia` shape into the
   * connector-agnostic `NormalizedMedia` shape. ProcessedMedia is a
   * legacy Telegram-specific structure (photo uses `image_path`,
   * everything else uses `file_path`); NormalizedMedia collapses both
   * into a single `localPath` so downstream consumers don't care which
   * provider produced the file. Added in PR4 of the pluggable-
   * connectors stack.
   */
  private toNormalizedMedia(processed: ProcessedMedia): NormalizedMedia {
    const localPath = processed.image_path ?? processed.file_path ?? '';
    return {
      kind: processed.type,
      localPath,
      fileName: processed.file_name,
      duration: processed.duration,
      transcription: processed.transcript,
    };
  }
}
