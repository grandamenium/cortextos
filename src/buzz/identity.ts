import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Buzz (Nostr/NIP-29) identity + channel config for a single agent.
 *
 * Mirrors the shape of Telegram's per-agent `.env` (BOT_TOKEN/CHAT_ID)
 * separation: non-secret config lives in `buzz.json`, the private key is
 * resolved from the agent's `.env` (`BUZZ_PRIVATE_KEY`) at runtime and is
 * never written to a JSON file that might get committed.
 */

export interface BuzzChannelConfig {
  /** hex secp256k1 pubkey — this agent's OWN Nostr identity, never the human operator's. */
  pubkey: string;
  /** Display name presented in the Buzz UI / relay-signed profile. */
  display_name: string;
  /** Channel UUIDs this agent listens on (N:1 — an agent can be in multiple channels). */
  channels: string[];
  /** Fail-closed allowlist of hex pubkeys permitted to message this agent. Empty = deny all. */
  allowed_pubkeys: string[];
  /** Relay WebSocket URL, e.g. wss://relay.example.com. One relay per org. */
  relay_url?: string;
}

export interface BuzzConfig extends BuzzChannelConfig {
  /** hex secp256k1 secret key, loaded from BUZZ_PRIVATE_KEY — never persisted to buzz.json. */
  secret_key: string;
}

/**
 * Loads `buzz.json` (non-secret config) from an agent directory. Returns
 * null if the file is absent, unreadable, or malformed — callers treat that
 * as "Buzz not configured for this agent" rather than an error.
 */
export function loadBuzzChannelConfig(agentDir: string): BuzzChannelConfig | null {
  const configPath = join(agentDir, 'buzz.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.pubkey !== 'string' || !raw.pubkey) return null;
    return {
      pubkey: raw.pubkey,
      display_name: typeof raw.display_name === 'string' ? raw.display_name : '',
      channels: Array.isArray(raw.channels) ? raw.channels.filter((c: unknown) => typeof c === 'string') : [],
      allowed_pubkeys: Array.isArray(raw.allowed_pubkeys) ? raw.allowed_pubkeys.filter((p: unknown) => typeof p === 'string') : [],
      relay_url: typeof raw.relay_url === 'string' ? raw.relay_url : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves BUZZ_PRIVATE_KEY from an agent's `.env` file. Returns undefined
 * if the file is absent or the key is not set — same "missing creds means
 * feature silently disabled" posture as Telegram's BOT_TOKEN resolution.
 */
export function loadBuzzSecretKey(agentDir: string): string | undefined {
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) return undefined;
  try {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^BUZZ_PRIVATE_KEY=(.+)$/m);
    const value = match?.[1]?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads the full BuzzConfig (channel config + secret key) for an agent.
 * Returns null if either buzz.json is missing/invalid or BUZZ_PRIVATE_KEY
 * is not set — Buzz requires both to be usable, matching Telegram's
 * BOT_TOKEN-and-CHAT_ID-both-required gate.
 */
export function loadBuzzConfig(agentDir: string): BuzzConfig | null {
  const channelConfig = loadBuzzChannelConfig(agentDir);
  if (!channelConfig) return null;
  const secretKey = loadBuzzSecretKey(agentDir);
  if (!secretKey) return null;
  // Basic hex sanity check: 64 hex chars (32 bytes). Malformed keys fail
  // closed rather than being passed to the signer, where a bad key would
  // either throw deep in @noble/secp256k1 or (worse) silently derive the
  // wrong pubkey.
  if (!/^[0-9a-fA-F]{64}$/.test(secretKey)) return null;
  return { ...channelConfig, secret_key: secretKey };
}

/**
 * Fail-closed pubkey allowlist check, mirroring `isSlackUserAllowed`'s
 * posture: an empty allowlist means NO pubkey is permitted (deny all),
 * not "anyone may message this agent". Comparison is case-insensitive
 * since hex pubkeys are sometimes copy-pasted with mixed case.
 */
export function isBuzzPubkeyAllowed(config: BuzzChannelConfig, pubkey: string): boolean {
  if (!config.allowed_pubkeys || config.allowed_pubkeys.length === 0) return false;
  const normalized = pubkey.toLowerCase();
  return config.allowed_pubkeys.some((p) => p.toLowerCase() === normalized);
}

/**
 * Checks whether a channel id is one this agent is configured to listen on.
 */
export function isBuzzChannelConfigured(config: BuzzChannelConfig, channelId: string): boolean {
  return config.channels.includes(channelId);
}
