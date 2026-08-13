import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Resolves the on-disk directory for an agent: `orgs/<org>/agents/<name>`. */
function resolveAgentDir(frameworkRoot: string, org: string, agentName: string): string {
  return join(frameworkRoot, 'orgs', org, 'agents', agentName);
}

/**
 * Per-agent Slack identity override — applied to every chat.postMessage.
 * Either icon_emoji OR icon_url, not both (Slack honors the first present).
 */
export interface SlackIdentity {
  username: string;
  icon_emoji?: string;
  icon_url?: string;
}

/** Schema of `agents/<name>/slack.json`. */
export interface SlackConfig {
  display_name: string;
  icon_emoji?: string;
  icon_url?: string;
  /** Map of purpose ("recap", "ops", "approvals", ...) → channel id (Cxxx). */
  channels: Record<string, string>;
  /** Channel ids the agent is allowed to read from (SP3b uses this). */
  allowed_channels: string[];
  /**
   * `"<team_id>:<user_id>"` composite keys allowed to message this agent
   * (SP3b's fail-closed gate — mirrors Telegram's ALLOWED_USER). Channel
   * membership alone is too weak a gate: channels are N-member and
   * membership can change after setup, so an unrecognized identity posting
   * in an allowed channel is IGNORED, not processed, exactly like an
   * unrecognized Telegram user id is rejected before ever reaching the
   * agent. Required (not optional) — a slack.json with an empty or missing
   * list means the agent accepts messages from NO one, matching Telegram's
   * fail-closed default when ALLOWED_USER is unset.
   *
   * team_id is part of the key, not just user_id: Slack user ids are
   * workspace-scoped, not globally unique, so user_id alone is not a safe
   * security key (warden review, SP3b) — this matters most if the Slack app
   * is ever installed org-wide across an Enterprise Grid (multiple
   * workspaces can then fan events into one Socket Mode connection).
   *
   * NOTE — this list is a single flat allowlist across ALL of this agent's
   * allowed_channels, not a per-channel map. Correct for a single-channel
   * agent (e.g. Beau's); a future multi-channel agent needing different
   * trust levels per channel would need this reworked into a
   * Record<channelId, string[]> — do not assume today's flat shape implies
   * "same channel" or "same trust level" without checking allowed_channels'
   * length first.
   */
  allowed_users: string[];
}

/**
 * Load the Slack identity override for an agent. Returns null when the agent
 * has no slack.json — that's the "Slack-disabled" signal and a normal state.
 */
export function loadSlackIdentity(
  frameworkRoot: string,
  org: string,
  agentName: string,
): SlackIdentity | null {
  const agentDir = resolveAgentDir(frameworkRoot, org, agentName);
  const path = join(agentDir, 'slack.json');
  if (!existsSync(path)) return null;
  let cfg: SlackConfig;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`slack.json parse failed for ${agentName}: ${(e as Error).message}`);
  }
  const id: SlackIdentity = { username: cfg.display_name };
  if (cfg.icon_emoji) id.icon_emoji = cfg.icon_emoji;
  else if (cfg.icon_url) id.icon_url = cfg.icon_url;
  return id;
}

/**
 * Load the full Slack config for an agent (for routing — SP3a doesn't use this,
 * but identity.ts is the right home for the loader; SP3b's bus dispatcher
 * imports it.).
 */
export function loadSlackConfig(
  frameworkRoot: string,
  org: string,
  agentName: string,
): SlackConfig | null {
  const agentDir = resolveAgentDir(frameworkRoot, org, agentName);
  const path = join(agentDir, 'slack.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as SlackConfig;
}

/** Builds the `"<team_id>:<user_id>"` composite key used by allowed_users. */
export function slackIdentityKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

/**
 * Fail-closed allowlist check — mirrors Telegram's ALLOWED_USER gate.
 * Channel membership alone is not a sufficient gate (channels are N-member
 * and membership drifts after setup), so this is a second, independent
 * check the dispatcher applies before an inbound Slack message ever reaches
 * an agent's PTY. A config with a missing or empty `allowed_users` allows
 * NO one — matching Telegram's posture when ALLOWED_USER is unset — rather
 * than silently defaulting to "anyone in the channel."
 *
 * Keys on team_id+user_id, not user_id alone — see allowed_users' docblock
 * for why (Slack user ids are workspace-scoped, not globally unique).
 */
export function isSlackUserAllowed(config: SlackConfig, teamId: string, userId: string): boolean {
  return Array.isArray(config.allowed_users) && config.allowed_users.includes(slackIdentityKey(teamId, userId));
}
