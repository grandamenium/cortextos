import { describe, it, expect, beforeEach } from 'vitest';
import { BuzzDispatcher } from '../../../src/buzz/dispatcher';
import type { BuzzChannelConfig } from '../../../src/buzz/identity';
import type { NostrEvent } from '../../../src/buzz/event';

function makeConfig(overrides: Partial<BuzzChannelConfig> = {}): BuzzChannelConfig {
  return {
    pubkey: 'agent-pubkey',
    display_name: 'test-agent',
    channels: ['chan-1'],
    allowed_pubkeys: ['sender-1'],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'event-1',
    pubkey: 'sender-1',
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [['h', 'chan-1']],
    content: 'hello',
    sig: 'sig',
    ...overrides,
  };
}

describe('BuzzDispatcher', () => {
  let dispatcher: BuzzDispatcher;

  beforeEach(() => {
    dispatcher = new BuzzDispatcher();
  });

  it('dispatches to a registered agent when both channel and pubkey match', () => {
    dispatcher.register('agent-a', makeConfig());
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([{ agentName: 'agent-a', event: makeEvent(), channelId: 'chan-1' }]);
  });

  it('does not dispatch when the channel does not match', () => {
    dispatcher.register('agent-a', makeConfig({ channels: ['other-chan'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([]);
  });

  it('does not dispatch when the sender pubkey is not allowlisted (channel match alone is insufficient)', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['someone-else'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([]);
  });

  it('fail-closed: does not dispatch when allowed_pubkeys is empty, even with correct channel', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: [] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([]);
  });

  it('dispatches to multiple agents in the same channel (N:1, unlike Telegram 1:1)', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['sender-1'] }));
    dispatcher.register('agent-b', makeConfig({ allowed_pubkeys: ['sender-1'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results.map((r) => r.agentName).sort()).toEqual(['agent-a', 'agent-b']);
  });

  it('only dispatches to agents whose allowlist matches this specific sender, not just any member', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['sender-1'] }));
    dispatcher.register('agent-b', makeConfig({ allowed_pubkeys: ['someone-else'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results.map((r) => r.agentName)).toEqual(['agent-a']);
  });

  it('unregister removes an agent from future dispatch', () => {
    dispatcher.register('agent-a', makeConfig());
    dispatcher.unregister('agent-a');
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([]);
  });

  it('unregister is a harmless no-op for an agent that was never registered', () => {
    expect(() => dispatcher.unregister('never-registered')).not.toThrow();
  });

  it('re-registering an agent overwrites its previous config (e.g. after buzz.json changes)', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['old-sender'] }));
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['sender-1'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results.map((r) => r.agentName)).toEqual(['agent-a']);
  });

  describe('allChannels', () => {
    it('returns the union of channels across all registered agents', () => {
      dispatcher.register('agent-a', makeConfig({ channels: ['c1', 'c2'] }));
      dispatcher.register('agent-b', makeConfig({ channels: ['c2', 'c3'] }));
      expect(dispatcher.allChannels().sort()).toEqual(['c1', 'c2', 'c3']);
    });

    it('returns an empty array when no agents are registered', () => {
      expect(dispatcher.allChannels()).toEqual([]);
    });
  });
});
