import type { MessageConnector } from '../connector.js';
import type {
  ConnectorCapabilities,
  ValidateResult,
  SendOptions,
  SendResult,
  PollingHandlers,
} from '../types.js';

/**
 * No-op connector for agents that have no outbound user-comms transport
 * configured. Reserved in PR1 — not the default for any malformed
 * legacy Telegram config (the daemon's legacy-compat resolver returns
 * `enabled: false` and the daemon leaves `connector = null` in that
 * case, byte-identical to pre-PR1).
 *
 * PR2 wires `connector: 'none'` through hooks + CLI for genuinely
 * comms-less agents (e.g. `openai-compatible` runtime workers that
 * receive inbox messages and reply via the bus, not Telegram).
 */
export class NullConnector implements MessageConnector {
  readonly kind = 'none' as const;
  readonly capabilities: ConnectorCapabilities = {
    inlineButtons: false,
    media: false,
    voiceTranscription: false,
    formattedText: false,
    longPolling: false,
    typingIndicator: false,
    reactions: false,
    outboundReactions: false,
    interactiveCallbacks: false,
    messageEdits: false,
  };

  async validateCredentials(): Promise<ValidateResult> {
    return { ok: true, identity: 'null-connector (no transport configured)' };
  }

  async sendMessage(_text: string, _opts?: SendOptions): Promise<SendResult> {
    return { id: 'noop', ts: Date.now() };
  }

  async sendMedia(): Promise<SendResult> {
    return { id: 'noop', ts: Date.now() };
  }

  async startPolling(_handlers: PollingHandlers, _opts?: { stateDir?: string }): Promise<void> {
    // No-op. Resolves immediately; no background loop to schedule.
    // Signature kept in sync with the interface (PR2 added opts arg).
  }

  async stopPolling(): Promise<void> {
    // No-op.
  }
}
