/**
 * Slack team-surface identity + trust layer (P2 — text-enrich only).
 *
 * Pure, injectable, daemon-free. The caller supplies the fetcher (wraps
 * SlackAPI.getUserInfo) and the cache (userId -> resolved identity), so this
 * module has zero side effects beyond populating that cache.
 *
 * trustLevel is ALWAYS resolved server-side from team_members; it is never
 * read from caller-supplied text — no spoofing surface.
 */
import type { TeamMember, TrustLevel } from '../types/index.js';

export interface SlackIdentity {
  userId: string;
  handle: string | null;          // Slack handle (users.info user.name); null if unresolved
  displayName: string;            // real_name ?? display_name ?? handle ?? userId
  trustLevel: TrustLevel | null;  // from team_members lookup by slack_handle; null if not a known member
}

export interface TrustDecision {
  allowed: boolean;
  openWarning: boolean;           // true ONLY when the allowlist is unconfigured (loudly-open)
}

// Injected for testability — the real impl wraps SlackAPI users.info.
export type SlackUserInfoFetcher =
  (userId: string) => Promise<{ handle: string | null; displayName: string } | null>;

/** Normalize a handle for case-insensitive, leading-@-tolerant comparison. */
function normalizeHandle(handle: string | null | undefined): string | null {
  if (handle == null) return null;
  const trimmed = handle.trim();
  if (trimmed === '') return null;
  const stripped = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return stripped.toLowerCase();
}

/**
 * Resolve identity with caching. cache maps userId -> {handle, displayName};
 * on cache miss call fetch() and populate. Only successful resolutions are
 * cached, so transient lookup failures retry on the next call.
 *
 * trustLevel is looked up from teamMembers by matching slack_handle
 * (case-insensitive, tolerate a leading '@').
 */
export async function resolveSlackIdentity(
  userId: string,
  fetch: SlackUserInfoFetcher,
  teamMembers: TeamMember[] | undefined,
  cache: Map<string, { handle: string | null; displayName: string }>,
): Promise<SlackIdentity> {
  let resolved = cache.get(userId);
  if (resolved === undefined) {
    const fetched = await fetch(userId);
    if (fetched === null) {
      // Lookup failed: do NOT cache (so it retries), return unresolved shape.
      return { userId, handle: null, displayName: userId, trustLevel: null };
    }
    resolved = fetched;
    cache.set(userId, resolved);
  }

  const handle = resolved.handle;
  const displayName = resolved.displayName || resolved.handle || userId;

  let trustLevel: TrustLevel | null = null;
  const normHandle = normalizeHandle(handle);
  if (normHandle !== null && teamMembers !== undefined) {
    const match = teamMembers.find(
      (m) => normalizeHandle(m.slack_handle) === normHandle,
    );
    if (match !== undefined) {
      trustLevel = match.trust_level;
    }
  }

  return { userId, handle, displayName, trustLevel };
}

/**
 * Fail-closed trust gate keyed on HANDLE.
 *  - trustedSlackUsers undefined/empty  -> { allowed: true,  openWarning: true }   (loudly open)
 *  - configured & handle in list        -> { allowed: true,  openWarning: false }
 *  - configured & handle missing/not in -> { allowed: false, openWarning: false }
 * Match handles case-insensitively, tolerate a leading '@' on either side.
 */
export function evaluateSlackTrust(
  handle: string | null,
  trustedSlackUsers: string[] | undefined,
): TrustDecision {
  if (trustedSlackUsers === undefined || trustedSlackUsers.length === 0) {
    return { allowed: true, openWarning: true };
  }

  const normHandle = normalizeHandle(handle);
  if (normHandle === null) {
    return { allowed: false, openWarning: false };
  }

  const allowed = trustedSlackUsers.some(
    (u) => normalizeHandle(u) === normHandle,
  );
  return { allowed, openWarning: false };
}

/**
 * Build the enriched originator token that goes right after "SLACK from ".
 *  - handle present + trustLevel present -> `${displayName} (@${handle}, ${trustLevel})`
 *  - handle present, no trustLevel       -> `${displayName} (@${handle})`
 *  - no handle                            -> `${displayName}`
 * trustLevel comes ONLY from the resolved identity (server-side team_members).
 */
export function formatSlackOriginator(identity: SlackIdentity): string {
  const { handle, displayName, trustLevel } = identity;
  if (handle === null) {
    return displayName;
  }
  if (trustLevel !== null) {
    return `${displayName} (@${handle}, ${trustLevel})`;
  }
  return `${displayName} (@${handle})`;
}
