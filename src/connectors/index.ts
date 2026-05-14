/**
 * Factory + allowlist for pluggable communications connectors.
 *
 * Mirrors the PTY-runtime dispatch idiom at
 * `src/daemon/agent-process.ts` (the `DISPATCH_ALLOWLIST` + ternary
 * dispatch). New connector kinds are added here AND to the union in
 * `AgentConfig.connector` (`src/types/index.ts`) so TypeScript and the
 * runtime allowlist agree on the supported set.
 */

import type { MessageConnector } from './connector.js';
import type { ConnectorKind, TelegramConnectorEnv } from './types.js';
import { TelegramConnector } from './telegram/telegram-connector.js';
import { NullConnector } from './none/null-connector.js';

export const CONNECTOR_ALLOWLIST: ConnectorKind[] = ['telegram', 'none'];

/**
 * Factory: unpacks process-env into the typed shape each connector
 * needs, then constructs. Called from non-legacy code paths where a
 * connector kind is set explicitly via `config.connector`. The daemon's
 * legacy Telegram-enablement path constructs `TelegramConnector`
 * directly with already-parsed values to avoid double-parsing the
 * `.env` file.
 */
export function getConnector(
  kind: ConnectorKind,
  agentDir: string,
  processEnv: NodeJS.ProcessEnv,
): MessageConnector {
  if (!CONNECTOR_ALLOWLIST.includes(kind)) {
    throw new Error(
      `Unknown connector "${kind}". Allowed: ${CONNECTOR_ALLOWLIST.join(', ')}`,
    );
  }
  switch (kind) {
    case 'telegram': {
      const env: TelegramConnectorEnv = {
        BOT_TOKEN: processEnv.BOT_TOKEN ?? '',
        CHAT_ID: processEnv.CHAT_ID ?? '',
        ALLOWED_USER: processEnv.ALLOWED_USER ?? '',
      };
      return new TelegramConnector(agentDir, env);
    }
    case 'none':
      return new NullConnector();
  }
}

/**
 * Build the operator-level (daemon-wide) MessageConnector from
 * `CTX_OPERATOR_*` env vars. Translates the operator-prefixed env
 * contract into the per-connector typed env that `getConnector()`
 * expects. Used by the daemon's crash-loop alert + other daemon-level
 * notifications that don't belong to any single agent.
 *
 * Returns null when:
 *   - `CTX_OPERATOR_CONNECTOR === 'none'` (operator opted out), OR
 *   - The operator's Telegram creds are not set (no `CTX_OPERATOR_BOT_TOKEN`).
 *
 * The connector returned is SEND-ONLY — it must NEVER be passed to
 * `startPolling()`. The empty `agentDir` argument is safe under that
 * constraint (`TelegramConnector` reads agentDir only for the poller's
 * stateDir; send/validate paths don't touch it).
 *
 * Added in PR2 of the pluggable-connectors stack (Codex H5 fix).
 */
export function getOperatorConnector(): MessageConnector | null {
  const kind = (process.env.CTX_OPERATOR_CONNECTOR ?? 'telegram') as ConnectorKind;
  if (kind === 'none') return null;
  if (kind === 'telegram') {
    const token = process.env.CTX_OPERATOR_BOT_TOKEN;
    if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) return null;
    const translated: NodeJS.ProcessEnv = {
      BOT_TOKEN: token,
      CHAT_ID: process.env.CTX_OPERATOR_CHAT_ID,
      ALLOWED_USER: process.env.CTX_OPERATOR_ALLOWED_USER,
    };
    return getConnector(kind, '', translated);
  }
  // Future kinds: factory dispatch. process.env passes through; the
  // future connector defines its own CTX_OPERATOR_* → connector-env
  // translation (or accepts process.env directly).
  return getConnector(kind, '', process.env);
}

export type { MessageConnector } from './connector.js';
export { TelegramConnector } from './telegram/telegram-connector.js';
export { NullConnector } from './none/null-connector.js';
export * from './types.js';
