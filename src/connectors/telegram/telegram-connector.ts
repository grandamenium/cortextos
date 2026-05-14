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
import { processMediaMessage, type ProcessedMedia } from './media.js';
import type {
  NormalizedMedia,
} from '../types.js';
import type {
  TelegramMessage,
  TelegramCallbackQuery,
  TelegramMessageReaction,
} from '../../types/index.js';

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
  private poller: TelegramPoller | null = null;

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
   */
  constructor(
    agentDir: string,
    env: TelegramConnectorEnv,
    opts?: { pollerNamespace?: string; downloadDir?: string },
  ) {
    this.agentDir = agentDir;
    this.api = new TelegramAPI(env.BOT_TOKEN);
    this.chatId = env.CHAT_ID;
    this.allowedUserId = env.ALLOWED_USER ? parseInt(env.ALLOWED_USER, 10) : undefined;
    this.pollerNamespace = opts?.pollerNamespace;
    this.downloadDir = opts?.downloadDir;
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
    // 4th arg is offsetFileSuffix — distinguishes the offset file across
    // multiple connector instances sharing a stateDir. Undefined keeps
    // the default `.telegram-offset` filename (byte-identical to PR2).
    this.poller = new TelegramPoller(this.api, stateDir, 1000, this.pollerNamespace);

    this.poller.onMessage((tgMsg: TelegramMessage) => {
      // PR4: media enrichment pipeline. When the inbound message
      // carries any media flag AND the connector was constructed with
      // a `downloadDir`, we kick off media download + transcription
      // fire-and-forget exactly as the pre-PR4 daemon's
      // `processMediaMessage(...).then(...)` pattern did. The
      // poller's offset advance happens synchronously after this
      // handler returns; the user's onMessage fires AFTER the media
      // pipeline settles (or immediately for text). Order matches the
      // pre-migration behavior byte-for-byte — see
      // `agent-manager.ts:466-509` (pre-PR4) for the old call site.
      const baseMessage = this.toNormalizedMessage(tgMsg);
      const hasMedia = !!(tgMsg.photo || tgMsg.document || tgMsg.voice || tgMsg.audio || tgMsg.video || tgMsg.video_note);
      if (hasMedia && this.downloadDir) {
        const downloadDir = this.downloadDir;
        processMediaMessage(tgMsg, this.api, downloadDir).then((processed) => {
          if (processed) {
            handlers.onMessage({ ...baseMessage, media: this.toNormalizedMedia(processed) });
          } else {
            // Media flag set but processMediaMessage returned null
            // (Telegram getFile failed, file_path missing, etc.). Fall
            // back to text-only so the agent still sees the caption.
            handlers.onMessage(baseMessage);
          }
        }).catch((err) => {
          console.error('[telegram-connector] media processing error:', err);
          handlers.onMessage(baseMessage);
        });
      } else {
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
    return {
      id: String(msg.message_id),
      ts: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
      from: {
        id: msg.from?.id !== undefined ? String(msg.from.id) : '',
        username: msg.from?.username,
        name: msg.from?.first_name,
      },
      text: msg.text ?? msg.caption ?? '',
      raw: msg,
    };
  }

  private toCallbackPayload(query: TelegramCallbackQuery): CallbackPayload {
    return {
      id: query.id,
      from: { id: query.from?.id !== undefined ? String(query.from.id) : '' },
      data: query.data ?? '',
      message_id: query.message?.message_id !== undefined ? String(query.message.message_id) : '',
      raw: query,  // PR2 H1.v2 — FastChecker.handleCallback casts this back to TelegramCallbackQuery
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
