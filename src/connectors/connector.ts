/**
 * The `MessageConnector` interface every transport implementation
 * conforms to. Mirrors the PTY-adapter idiom at
 * `src/daemon/agent-process.ts` (interface + dispatch-allowlist + ternary
 * dispatch) — the same shape, but for user-facing messaging transports
 * instead of agent runtimes.
 *
 * Two implementations in this PR:
 *   - `TelegramConnector` in `./telegram/telegram-connector.ts`
 *   - `NullConnector` in `./none/null-connector.ts`
 *
 * Future implementations (Matrix, RocketChat, Slack, etc.) land in their
 * own subdirectories in follow-up PRs without touching this interface.
 */

import type {
  ConnectorKind,
  ConnectorCapabilities,
  ValidateResult,
  SendOptions,
  SendResult,
  PollingHandlers,
  ConnectorAction,
} from './types.js';

export interface MessageConnector {
  readonly kind: ConnectorKind;
  readonly capabilities: ConnectorCapabilities;

  /** Cheap health probe — used during enable + cold start. Must never throw. */
  validateCredentials(): Promise<ValidateResult>;

  /** Send a text reply. */
  sendMessage(text: string, opts?: SendOptions): Promise<SendResult>;

  /** Send a media attachment (caller supplies local file path). */
  sendMedia(media: {
    localPath: string;
    caption?: string;
    kind: 'photo' | 'document';
  }): Promise<SendResult>;

  /**
   * Start the background polling loop. Resolves AFTER the loop is
   * scheduled / running — does NOT await its completion (which only
   * happens when stopPolling() is called). Matches the existing
   * `poller.start().catch(...)` fire-and-forget pattern at
   * `src/daemon/agent-manager.ts:455-463` so `startAgent` does not hang.
   *
   * `opts.stateDir`: directory where the connector persists its inbound
   * polling state (e.g. Telegram's `.telegram-offset` file). When
   * omitted, the connector uses an implementation-specific default
   * (Telegram falls back to `agentDir`). The daemon should pass
   * `<ctxRoot>/state/<name>/` explicitly to keep offset files in their
   * historical location across the PR2 wire migration. Added in PR2 of
   * the pluggable-connectors stack (Codex Q5 lock).
   */
  startPolling(handlers: PollingHandlers, opts?: { stateDir?: string }): Promise<void>;
  stopPolling(): Promise<void>;

  /**
   * Optional surfaces. Connectors without the capability omit the method
   * entirely; callers MUST gate via `capabilities.<flag>` before invoking.
   */
  setTypingIndicator?(on: boolean): Promise<void>;
  registerCommands?(commands: Array<{ name: string; description: string }>): Promise<void>;

  /**
   * Acknowledge a callback query the connector emitted via
   * `PollingHandlers.onCallback`. `text` is a short toast/banner shown
   * on the user's client (Telegram: callback notification; Slack:
   * ephemeral response; RocketChat: action ack). When the connector
   * has no native concept of acknowledgement, the method is omitted
   * and the `interactiveCallbacks` capability is `false`.
   *
   * Errors are non-fatal. Callers wrap in try/catch — failures here
   * must not abort the surrounding interactive flow (the user already
   * clicked the button; missing the ack only loses the toast).
   *
   * Added in PR3 of the pluggable-connectors stack (interactive-
   * message lifecycle abstraction).
   */
  acknowledgeCallback?(callbackId: string, text?: string): Promise<void>;

  /**
   * Edit a previously-sent message in the connector's bound chat.
   * Used by FastChecker to update inline-button messages after a
   * user click ("Approved", "Got it", "Submitted", etc.) so the
   * audit-trail message reflects the resolved state.
   *
   * `messageId` is the connector-specific id of the message being
   * edited (Telegram message_id, Slack ts, RocketChat _id). The
   * chat is implicit — the connector knows its bound chat from
   * construction. Cross-chat editing (e.g. activity-channel
   * approval messages) is out of scope; that path stays direct
   * pending activity-channel pluggability.
   *
   * `opts.buttons`: optional inline-keyboard replacement. Omitting
   * preserves the existing keyboard on Telegram per the API contract.
   *
   * Errors are non-fatal. Callers wrap in try/catch — failures here
   * must not abort the surrounding interactive flow.
   *
   * Added in PR3 of the pluggable-connectors stack (interactive-
   * message lifecycle abstraction).
   */
  editMessage?(
    messageId: string,
    text: string,
    opts?: { buttons?: Array<Array<ConnectorAction>> },
  ): Promise<void>;

  /**
   * Send (or remove) a reaction emoji on a message in the connector's
   * bound chat. The cortextOS UX pattern: agents react ON the user's
   * message instead of replying with a text ack — 👀 seen, ✅ done,
   * ❌ failed, 👍 acknowledged, 🛠 working on it, ⏸ paused, 🤔
   * ambiguous. See docs/architecture/connectors.md §11.
   *
   * `messageId`: the connector-specific message id (round-tripped from
   * NormalizedMessage.id). The agent's tool layer typically gets this
   * from the inbound message being acknowledged.
   *
   * `emoji`: a unicode emoji character. Connectors validate against
   * their provider's allowed set when one exists (Telegram restricts
   * bots to a fixed standard set on a per-chat basis; Discord /
   * Mattermost / RocketChat are permissive). On rejection the
   * connector throws — callers decide whether to fall back to a text
   * reply.
   *
   * `opts.remove`: when true, the agent's reaction is REMOVED (Telegram
   * `setMessageReaction` with empty reaction array; Discord/Mattermost
   * have native delete endpoints). Useful for state-machine UX:
   * react 🛠 while working, swap for ✅ on completion (which is
   * actually a sendReaction with the new emoji — Telegram's contract is
   * "set to this list", not "add").
   *
   * `opts.isBig`: Telegram-specific flag for the "big animation"
   * display on private chats. Other connectors ignore.
   *
   * Errors are NOT auto-swallowed (unlike acknowledgeCallback and
   * editMessage). The caller decides whether a failed reaction needs a
   * text-ack fallback or can be silently dropped — different agent
   * surfaces (proactive ack vs completion signal) have different
   * sensitivity.
   *
   * Added in PR4 c10 of the pluggable-connectors stack (Codex P1.H).
   */
  sendReaction?(
    messageId: string,
    emoji: string,
    opts?: { remove?: boolean; isBig?: boolean },
  ): Promise<void>;
}
