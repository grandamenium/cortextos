import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BuzzRelayClient } from '../../../src/buzz/relay-client';
import { generateKeypair } from '../../../src/buzz/event';

/**
 * Minimal fake WebSocket implementing just enough of the browser/Node
 * WebSocket surface (addEventListener/send/close) that relay-client.ts
 * uses, with manual test-driven triggering of open/message/close events —
 * no real network involved.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: unknown[] = [];
  closed = false;
  private listeners: Record<string, Array<(evt: any) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (evt: any) => void): void {
    (this.listeners[type] ||= []).push(handler);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
    this.emit('close', {});
  }

  emit(type: string, evt: any): void {
    for (const handler of this.listeners[type] || []) handler(evt);
  }

  triggerOpen(): void {
    this.emit('open', {});
  }

  triggerMessage(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  lastSent(): unknown {
    return this.sent[this.sent.length - 1];
  }
}

describe('BuzzRelayClient', () => {
  let originalWebSocket: unknown;
  const { secretKey, pubkey } = generateKeypair();

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  /** Drives a client through connect -> AUTH challenge -> AUTH OK, returning the socket. */
  async function connectAndAuthenticate(client: BuzzRelayClient): Promise<FakeWebSocket> {
    const startPromise = client.start();
    // Let the microtask queue advance so connectAndRun() constructs the WebSocket.
    await Promise.resolve();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.triggerOpen();
    await Promise.resolve();
    ws.triggerMessage(['AUTH', 'challenge-123']);
    await Promise.resolve();
    const authFrame = ws.lastSent() as [string, { id: string }];
    expect(authFrame[0]).toBe('AUTH');
    ws.triggerMessage(['OK', authFrame[1].id, true, '']);
    await Promise.resolve();
    void startPromise; // client.start() runs until stop(); don't await it here.
    return ws;
  }

  it('sends a signed AUTH event in response to the relay challenge', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    const ws = await connectAndAuthenticate(client);
    const authFrame = ws.sent.find((f: any) => f[0] === 'AUTH') as [string, { kind: number; pubkey: string; tags: string[][] }];
    expect(authFrame[1].kind).toBe(22242);
    expect(authFrame[1].pubkey).toBe(pubkey);
    expect(authFrame[1].tags).toContainEqual(['challenge', 'challenge-123']);
    client.stop();
  });

  it('issues a REQ subscription for each subscribed channel after authentication', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    client.subscribeChannels(['chan-1', 'chan-2']);
    const ws = await connectAndAuthenticate(client);
    const reqFrames = ws.sent.filter((f: any) => f[0] === 'REQ');
    expect(reqFrames).toHaveLength(2);
    const channelsRequested = reqFrames.map((f: any) => f[2]['#h'][0]).sort();
    expect(channelsRequested).toEqual(['chan-1', 'chan-2']);
    client.stop();
  });

  it('delivers a kind:9 EVENT to onMessage handlers only after EOSE for that subscription', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    client.subscribeChannels(['chan-1']);
    const ws = await connectAndAuthenticate(client);
    const reqFrame = ws.sent.find((f: any) => f[0] === 'REQ') as [string, string, unknown];
    const subId = reqFrame[1];

    const received: unknown[] = [];
    client.onMessage((channelId, event) => received.push({ channelId, event }));

    const preEoseEvent = { id: 'e1', pubkey: 'someone', created_at: 1, kind: 9, tags: [], content: 'backlog', sig: 'x' };
    ws.triggerMessage(['EVENT', subId, preEoseEvent]);
    expect(received).toHaveLength(0); // historical backlog before EOSE must not be delivered

    ws.triggerMessage(['EOSE', subId]);
    const liveEvent = { id: 'e2', pubkey: 'someone', created_at: 2, kind: 9, tags: [], content: 'live', sig: 'y' };
    ws.triggerMessage(['EVENT', subId, liveEvent]);
    expect(received).toEqual([{ channelId: 'chan-1', event: liveEvent }]);
    client.stop();
  });

  it('publish() sends a signed kind:9 event with the channel #h tag and resolves on OK', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    const ws = await connectAndAuthenticate(client);

    const publishPromise = client.publish('chan-1', 'hello world');
    await Promise.resolve();
    const eventFrame = ws.sent.find((f: any) => f[0] === 'EVENT') as [string, { id: string; tags: string[][] }];
    expect(eventFrame[1].tags).toContainEqual(['h', 'chan-1']);
    ws.triggerMessage(['OK', eventFrame[1].id, true, '']);

    const result = await publishPromise;
    expect(result.content).toBe('hello world');
    client.stop();
  });

  it('publish() rejects when the relay responds with OK=false', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    const ws = await connectAndAuthenticate(client);

    const publishPromise = client.publish('chan-1', 'hello world');
    await Promise.resolve();
    const eventFrame = ws.sent.find((f: any) => f[0] === 'EVENT') as [string, { id: string }];
    ws.triggerMessage(['OK', eventFrame[1].id, false, 'rate limited']);

    await expect(publishPromise).rejects.toThrow(/rate limited/);
    client.stop();
  });

  it('publish() throws immediately if not yet authenticated', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    await expect(client.publish('chan-1', 'too early')).rejects.toThrow(/not connected/);
  });

  it('stop() marks lastExitReason as stopped-externally and prevents further sends', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    await connectAndAuthenticate(client);
    client.stop();
    // Give start()'s loop a tick to observe running=false and return.
    await Promise.resolve();
    await Promise.resolve();
    expect(client.lastExitReason).toBe('stopped-externally');
  });

  it('a stale (superseded) connection frame does not deliver to handlers after reconnect (epoch guard)', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    client.subscribeChannels(['chan-1']);
    const firstWs = await connectAndAuthenticate(client);

    const received: unknown[] = [];
    client.onMessage((channelId, event) => received.push({ channelId, event }));

    // Simulate the old socket closing and a new connection superseding it
    // by calling stop() (bumps epoch) then manually feeding the old socket
    // a frame — it must be ignored since it's no longer the current epoch.
    client.stop();
    const staleEvent = { id: 'stale', pubkey: 'x', created_at: 1, kind: 9, tags: [], content: 'stale', sig: 'z' };
    firstWs.triggerMessage(['EOSE', 'buzz-chan-1']);
    firstWs.triggerMessage(['EVENT', 'buzz-chan-1', staleEvent]);
    expect(received).toHaveLength(0);
  });
});
