import type { NostrEvent } from './event.js';
import { isBuzzChannelConfigured, isBuzzPubkeyAllowed, type BuzzChannelConfig } from './identity.js';

/**
 * Routes incoming Buzz (Nostr kind:9) channel-message events to every
 * registered agent whose `buzz.json` matches BOTH gates:
 *   1. channel match — the agent listens on the event's channel, and
 *   2. pubkey match — the event author is in the agent's allowed_pubkeys.
 *
 * Buzz channels are N:1 (an agent can be a member of several channels, and
 * a channel can have several member agents) — unlike Telegram's 1:1
 * bot-per-agent shape, a single relay connection fans an incoming message
 * out to every matching agent, not just the first.
 */

export interface BuzzDispatchTarget {
  agentName: string;
  config: BuzzChannelConfig;
}

export interface BuzzDispatchResult {
  agentName: string;
  event: NostrEvent;
  channelId: string;
}

/**
 * Registry of agents this daemon knows to be listening on Buzz. The relay
 * client's onMessage handler feeds events through `dispatch()`.
 */
export class BuzzDispatcher {
  private targets: Map<string, BuzzDispatchTarget> = new Map();

  /** Registers or updates an agent's Buzz config. */
  register(agentName: string, config: BuzzChannelConfig): void {
    this.targets.set(agentName, { agentName, config });
  }

  /** Removes an agent from dispatch (e.g. on stopAgent). */
  unregister(agentName: string): void {
    this.targets.delete(agentName);
  }

  /**
   * Computes every agent that should receive this event: channel match AND
   * pubkey-allowed match. Delivers to all matches, not just the first.
   */
  dispatch(channelId: string, event: NostrEvent): BuzzDispatchResult[] {
    const results: BuzzDispatchResult[] = [];
    for (const target of this.targets.values()) {
      if (!isBuzzChannelConfigured(target.config, channelId)) continue;
      if (!isBuzzPubkeyAllowed(target.config, event.pubkey)) continue;
      results.push({ agentName: target.agentName, event, channelId });
    }
    return results;
  }

  /** Union of every channel id across all registered agents — what the relay client should subscribe to. */
  allChannels(): string[] {
    const channels = new Set<string>();
    for (const target of this.targets.values()) {
      for (const c of target.config.channels) channels.add(c);
    }
    return [...channels];
  }
}
