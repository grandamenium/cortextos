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

export type { MessageConnector } from './connector.js';
export { TelegramConnector } from './telegram/telegram-connector.js';
export { NullConnector } from './none/null-connector.js';
export * from './types.js';
