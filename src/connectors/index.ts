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
 * Runtime typeguard for `config.json:connector` values. Use this everywhere
 * a connector kind enters the program from JSON (config.json) or other
 * untyped sources, instead of an unchecked cast to `ConnectorKind`. Without
 * it a typo like `'telegrm'` would slip through the type system and bomb
 * `getConnector()` with a misleading "Unknown connector" error at dispatch
 * time. The PR-audit found three call sites doing the unchecked cast; this
 * helper centralizes the validation.
 */
export function isConnectorKind(x: unknown): x is ConnectorKind {
  return typeof x === 'string' && (CONNECTOR_ALLOWLIST as string[]).includes(x);
}

/**
 * Per-kind credential env keys. Single source of truth so that adding
 * a new connector (Matrix MATRIX_ACCESS_TOKEN, RocketChat
 * ROCKETCHAT_AUTH_TOKEN, etc.) is a one-line change here — not a hunt
 * across three CLI sites for hardcoded `['BOT_TOKEN', 'CHAT_ID', ...]`
 * lists. Pre-audit those lists drifted independently and the
 * "clear-caller-inherited-creds" sanitization that protects target
 * agents from caller-env leakage would have rotted on the next
 * connector landing.
 */
export const CONNECTOR_ENV_KEYS: Readonly<Record<ConnectorKind, readonly string[]>> = {
  telegram: ['BOT_TOKEN', 'CHAT_ID', 'ALLOWED_USER'],
  none: [],
};

/**
 * Union of every known connector kind's cred-env keys. Use this when
 * sanitizing a caller-inherited env before passing it through to a
 * target agent's connector — clearing this set guarantees no caller
 * cred leaks across the boundary regardless of which kind the target
 * agent ends up using.
 */
export function getAllConnectorCredKeys(): readonly string[] {
  const seen = new Set<string>();
  for (const kind of CONNECTOR_ALLOWLIST) {
    for (const k of CONNECTOR_ENV_KEYS[kind] ?? []) seen.add(k);
  }
  return [...seen];
}

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
    if (!token) return null;
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      // Token IS set but malformed — log a warn so a typo doesn't silently
      // disable crash-loop alerts forever. Don't echo the token; just say
      // the env var exists but doesn't match the expected `<id>:<secret>`
      // shape from BotFather.
      console.warn(
        '[connector:operator] CTX_OPERATOR_BOT_TOKEN is set but does not match the Telegram bot-token shape (`<id>:<secret>`). Crash-loop alerts will be skipped until it is fixed.',
      );
      return null;
    }
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
