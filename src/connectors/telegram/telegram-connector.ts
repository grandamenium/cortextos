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
  CallbackPayload,
} from '../types.js';
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
    longPolling: true,
    typingIndicator: true,
    reactions: true,
    interactiveCallbacks: true,
    messageEdits: true,
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
   * Monotonic generation counter incremented on every `stopPolling()`.
   * Async work kicked off inside the poller handler (today: the media-
   * enrichment pipeline) snapshots this at entry and re-checks after
   * each await. A mismatch means stopPolling fired during the await —
   * the in-flight delivery is suppressed so a stopped/restarted agent
   * does not receive stale media. Without this guard the daemon would
   * inject media originated against the previous PTY lifecycle into
   * the next one.
   */
  private pollGeneration: number = 0;

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
    this.downloadDir = opts?.downloadDir;
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
    const replyMarkup = opts?.buttons ? { inline_keyboard: opts.buttons } : undefined;
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
  async startPolling(handlers: PollingHandlers, opts?: { stateDir?: string }): Promise<void> {
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
      await this.stopPolling();
    }
    // 4th arg is offsetFileSuffix — distinguishes the offset file across
    // multiple connector instances sharing a stateDir. Undefined keeps
    // the default `.telegram-offset` filename (byte-identical to PR2).
    this.poller = new TelegramPoller(this.api, stateDir, 1000, this.pollerNamespace);

    const generationAtStart = this.pollGeneration;
    this.poller.onMessage(async (tgMsg: TelegramMessage) => {
      // PR4 c4 (Codex P0): media enrichment now AWAITS processMediaMessage
      // before the poller advances its offset. The previous .then() pattern
      // let the poller ACK the update with Telegram (advance offset, persist
      // to disk) BEFORE the agent ever saw the media-formatted message —
      // a crash or stopPolling between offset-advance and the .then firing
      // dropped the message permanently because Telegram does not redeliver
      // acked updates. Now the offset only moves after the full pipeline
      // (download + transcription + handler emit) settles.
      //
      // The poller supports awaitable handlers (poller.ts:7 MessageHandler
      // signature) and applies the same offset-after-handler semantics it
      // already used for sync handlers — a thrown handler / rejected promise
      // leaves the offset untouched and the update is redelivered.
      //
      // Generation guard: if stopPolling() fires between the await and the
      // emit, suppress delivery so a stopped/restarted agent never sees
      // stale media injected into the next PTY lifecycle. The guard sits
      // AFTER the await so an in-flight download completes and is
      // dropped cleanly rather than racing the poller's stop signal.
      const baseMessage = this.toNormalizedMessage(tgMsg);
      const hasMedia = !!(tgMsg.photo || tgMsg.document || tgMsg.voice || tgMsg.audio || tgMsg.video || tgMsg.video_note);
      if (hasMedia && this.downloadDir) {
        const downloadDir = this.downloadDir;
        let processed = null;
        try {
          processed = await processMediaMessage(tgMsg, this.api, downloadDir, this.mediaLimits);
        } catch (err) {
          console.error('[telegram-connector] media processing error:', err);
        }
        if (this.pollGeneration !== generationAtStart) {
          // stopPolling() fired during the await — suppress emit.
          return;
        }
        if (processed) {
          handlers.onMessage({ ...baseMessage, media: this.toNormalizedMedia(processed) });
        } else {
          // Media flag set but processMediaMessage returned null
          // (Telegram getFile failed, file_path missing, etc.). Fall
          // back to text-only so the agent still sees the caption.
          handlers.onMessage(baseMessage);
        }
      } else {
        if (this.pollGeneration !== generationAtStart) return;
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
    this.poller.start().catch((err: unknown) => {
      console.error('[telegram-connector] poller error:', err);
    });
  }

  async stopPolling(): Promise<void> {
    // Bump generation BEFORE clearing the poller — any in-flight async
    // media-pipeline handler that finishes after this call will see the
    // mismatched generation and suppress its `handlers.onMessage` emit.
    // See the generation guard in the poller.onMessage closure above.
    this.pollGeneration += 1;
    if (this.poller) {
      this.poller.stop();
      this.poller = null;
    }
  }

  async setTypingIndicator(on: boolean): Promise<void> {
    if (on) {
      await this.api.sendChatAction(this.chatId, 'typing');
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

  async editMessage(
    messageId: string,
    text: string,
    opts?: { buttons?: Array<Array<{ text: string; callback_data: string }>> },
  ): Promise<void> {
    // Telegram message_ids are numeric; the connector accepts strings for
    // cross-connector consistency (Slack ts is "1690000000.000001",
    // RocketChat _id is opaque) but the wire format here is number.
    const numericId = Number(messageId);
    const replyMarkup = opts?.buttons ? { inline_keyboard: opts.buttons } : undefined;
    await this.api.editMessageText(this.chatId, numericId, text, replyMarkup);
  }

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
      message_id: reaction.message_id,
      old_reaction: reaction.old_reaction ?? [],
      new_reaction: reaction.new_reaction ?? [],
      raw: reaction,
    };
  }

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
