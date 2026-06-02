import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveAgentDir } from '../utils/agent-dir.js';

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
}

/**
 * Load the Slack identity override for an agent. Returns null when the agent
 * has no slack.json — that's the "Slack-disabled" signal and a normal state.
 *
 * `qualifiedName` can be bare ("boss") for shared agents or "engineer/agent"
 * for namespaced personal agents.
 */
export function loadSlackIdentity(
  frameworkRoot: string,
  org: string,
  qualifiedName: string,
): SlackIdentity | null {
  const agentDir = resolveAgentDir(frameworkRoot, org, qualifiedName);
  const path = join(agentDir, 'slack.json');
  if (!existsSync(path)) return null;
  let cfg: SlackConfig;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`slack.json parse failed for ${qualifiedName}: ${(e as Error).message}`);
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
  qualifiedName: string,
): SlackConfig | null {
  const agentDir = resolveAgentDir(frameworkRoot, org, qualifiedName);
  const path = join(agentDir, 'slack.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as SlackConfig;
}
