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
   */
  startPolling(handlers: PollingHandlers): Promise<void>;
  stopPolling(): Promise<void>;

  /**
   * Optional surfaces. Connectors without the capability omit the method
   * entirely; callers MUST gate via `capabilities.<flag>` before invoking.
   */
  setTypingIndicator?(on: boolean): Promise<void>;
  registerCommands?(commands: Array<{ name: string; description: string }>): Promise<void>;
}
