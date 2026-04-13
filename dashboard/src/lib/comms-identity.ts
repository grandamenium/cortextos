/**
 * Comms identity resolution — ensures all message sources (bus, Telegram,
 * dashboard chat bar) resolve to the same channel pair key for the same
 * logical conversation.
 *
 * The canonical user identity is the dashboard admin username
 * (ADMIN_USERNAME env var). This is always present regardless of whether
 * Telegram is configured, and serves as the anchor for pair key
 * construction. Telegram from_name is display enrichment only — it does
 * not affect channel grouping.
 *
 * Multi-user safe: the resolver normalizes all non-agent names to the
 * canonical user identity. Future multi-user support would map additional
 * Telegram chat_ids to additional dashboard users.
 */

import fs from 'fs';
import path from 'path';

export interface CommsIdentity {
  /** Set of known agent names (lowercase). */
  agents: Set<string>;
  /** Canonical user identity — the dashboard admin username. Used as the
   *  non-agent side of every pair key. */
  canonicalUser: string;
}

/**
 * Discover agent names and resolve the canonical user identity.
 * Called once per API request.
 */
export function resolveIdentity(ctxRoot: string): CommsIdentity {
  const agents = new Set<string>();

  // Discover agents from enabled-agents.json — the authoritative registry.
  // The inbox directory is NOT reliable because it contains non-agent dirs
  // (dashboard, mobile-user, cortextos) that would pollute the agents set.
  const configPath = path.join(ctxRoot, 'config', 'enabled-agents.json');
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      for (const name of Object.keys(data)) {
        agents.add(name.toLowerCase());
      }
    } catch { /* ignore */ }
  }

  // Canonical user = dashboard admin username (always set in .env.local)
  const canonicalUser = (process.env.ADMIN_USERNAME ?? 'user').toLowerCase();

  return { agents, canonicalUser };
}

/**
 * Normalize a message sender/recipient name to its canonical form.
 * Agent names pass through unchanged. All non-agent names resolve to
 * the canonical dashboard user identity.
 */
export function normalizeName(
  name: string,
  identity: CommsIdentity,
): string {
  const lower = name.toLowerCase();
  if (identity.agents.has(lower)) return lower;
  return identity.canonicalUser;
}

/**
 * Build a canonical pair key from two message participants.
 * Both names are normalized, then sorted alphabetically and joined
 * with '--'. This ensures the same conversation always produces the
 * same key regardless of message direction or source.
 */
export function buildPairKey(
  from: string,
  to: string,
  identity: CommsIdentity,
): string {
  const a = normalizeName(from, identity);
  const b = normalizeName(to, identity);
  return [a, b].sort().join('--');
}
