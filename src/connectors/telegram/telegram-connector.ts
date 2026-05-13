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
  };

  private readonly api: TelegramAPI;
  private readonly chatId: string;
  private readonly allowedUserId?: number;
  private readonly agentDir: string;
  private poller: TelegramPoller | null = null;

  constructor(agentDir: string, env: TelegramConnectorEnv) {
    this.agentDir = agentDir;
    this.api = new TelegramAPI(env.BOT_TOKEN);
    this.chatId = env.CHAT_ID;
    this.allowedUserId = env.ALLOWED_USER ? parseInt(env.ALLOWED_USER, 10) : undefined;
  }

  /**
   * `@internal @deprecated PR2` — temporary legacy callback bridge.
   *
   * Allowed callers (enforced by CI grep guard in
   * `tests/lint-no-stray-raw-api.test.ts`):
   *   - `src/daemon/agent-manager.ts` (to populate FastChecker's
   *     `telegramApi`/`chatId` fields for the activity-channel callback
   *     edit/answer paths that PR1 keeps Telegram-direct)
   *   - `tests/connectors/telegram-connector.test.ts`
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
  async startPolling(handlers: PollingHandlers): Promise<void> {
    // stateDir: kept inside agentDir for PR1 simplicity (path matches
    // tests' mock-server invocation pattern). The production daemon
    // path uses `<ctxRoot>/state/<name>/` and constructs its own
    // poller; this implementation is for tests + PR2's migration.
    const stateDir = this.agentDir;
    this.poller = new TelegramPoller(this.api, stateDir);

    this.poller.onMessage((tgMsg: TelegramMessage) => {
      handlers.onMessage(this.toNormalizedMessage(tgMsg));
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
}
