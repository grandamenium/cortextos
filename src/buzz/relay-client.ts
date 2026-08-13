import { buildAuthEvent, buildChannelMessageEvent, type NostrEvent } from './event.js';

export type BuzzMessageHandler = (channelId: string, event: NostrEvent) => void;

type PendingOk = {
  resolve: (accepted: boolean, message: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Seconds to wait for the relay to send the NIP-42 AUTH challenge after
 * connecting, and for the OK response to the AUTH/publish events. Mirrors
 * the floors buzz-ws-client's connection.rs enforces (>=20s / >=30s) so a
 * slow relay doesn't get treated as dead prematurely.
 */
const AUTH_CHALLENGE_TIMEOUT_MS = 20_000;
const AUTH_OK_TIMEOUT_MS = 20_000;
const PUBLISH_OK_TIMEOUT_MS = 30_000;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * One shared WebSocket connection to a Buzz (Nostr/NIP-29) relay, owned at
 * the org level — mirrors Slack Socket Mode's single-shared-connection
 * shape (one relay per org, not one connection per agent) rather than
 * Telegram's per-bot poller shape.
 *
 * Connection lifecycle ported from buzz-ws-client's connection.rs reference
 * (connect -> wait AUTH challenge -> send signed AUTH -> wait OK -> ready)
 * but adapted to Node's event-driven WebSocket API and TelegramPoller's
 * daemon-managed start/stop/reconnect idioms rather than transliterating
 * Rust's blocking async loop.
 */
export class BuzzRelayClient {
  private relayUrl: string;
  private secretKeyHex: string;
  private ws: WebSocket | null = null;
  private running = false;
  private authenticated = false;
  /**
   * Bumped on every connect() call. Frames delivered by a WebSocket instance
   * whose epoch no longer matches `this.epoch` are dropped — same
   * stale-connection guard Slack's socket-mode.ts uses to avoid processing
   * frames from a socket that reconnect() has already superseded.
   */
  private epoch = 0;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private messageHandlers: BuzzMessageHandler[] = [];
  private log: (msg: string) => void;

  // Subscriptions this client should (re)establish on every (re)connect.
  private subscribedChannels = new Set<string>();
  // sub_id -> channelId, so incoming EVENT frames can be routed back to a channel.
  private subToChannel = new Map<string, string>();
  // Tracks which sub ids have passed EOSE, so historical backlog is never
  // delivered to onMessage handlers — only live pushes after EOSE, matching
  // the "don't replay old messages on reconnect" posture the design spec
  // calls out (same concern Slack's epoch-guard addresses).
  private eoseSeen = new Set<string>();

  private pendingOks = new Map<string, PendingOk>();
  private pendingAuthChallenge: { resolve: (challenge: string) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  /** Why the client last stopped. Read by daemon supervision to decide whether to restart. */
  lastExitReason: string = '';

  constructor(relayUrl: string, secretKeyHex: string, log: (msg: string) => void = () => {}) {
    this.relayUrl = relayUrl;
    this.secretKeyHex = secretKeyHex;
    this.log = log;
  }

  /**
   * Register a handler for incoming channel messages (kind:9 EVENT frames
   * after EOSE has been seen for that subscription).
   */
  onMessage(handler: BuzzMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Registers the set of channel ids to subscribe to. Call before start(),
   * or at any point — an active connection will (re)issue REQ frames for
   * any channels not yet subscribed.
   */
  subscribeChannels(channelIds: string[]): void {
    for (const id of channelIds) this.subscribedChannels.add(id);
    if (this.authenticated) this.sendSubscriptions();
  }

  /**
   * Starts the connection lifecycle: connect, authenticate, subscribe, and
   * keep reconnecting with backoff until stop() is called. Resolves once
   * the loop has permanently exited (stopped externally or given up).
   *
   * Non-blocking startup contract: this method's caller (agent-manager.ts)
   * wraps both `new BuzzRelayClient()` construction AND this start() call
   * in try/catch, so a bad relay URL or an outage can never block
   * orchestrator boot.
   */
  async start(): Promise<void> {
    this.running = true;
    this.lastExitReason = '';
    while (this.running) {
      try {
        await this.connectAndRun();
      } catch (err) {
        this.log(`connection error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.running) {
        this.lastExitReason = 'stopped-externally';
        return;
      }
      this.log(`reconnecting in ${this.backoffMs}ms`);
      await this.sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
    this.lastExitReason = 'stopped-externally';
  }

  /** Stops the client. Marks the exit as intentional so it will not restart. */
  stop(): void {
    this.running = false;
    this.authenticated = false;
    this.epoch++; // invalidate any in-flight frames from the current socket
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending('client stopped');
    try {
      this.ws?.close();
    } catch { /* best-effort */ }
    this.ws = null;
  }

  /**
   * Publishes a kind:9 channel message and waits for the relay's OK.
   * Throws if the connection is not currently authenticated, or if the
   * relay does not OK within PUBLISH_OK_TIMEOUT_MS.
   */
  async publish(channelId: string, content: string, replyToEventId?: string): Promise<NostrEvent> {
    if (!this.ws || !this.authenticated) {
      throw new Error('BuzzRelayClient: not connected/authenticated');
    }
    const event = buildChannelMessageEvent(channelId, content, this.secretKeyHex, replyToEventId);
    const { accepted, message } = await this.sendAndAwaitOk(event, PUBLISH_OK_TIMEOUT_MS);
    if (!accepted) {
      throw new Error(`relay rejected event: ${message}`);
    }
    return event;
  }

  private async connectAndRun(): Promise<void> {
    const myEpoch = ++this.epoch;
    this.authenticated = false;
    this.eoseSeen.clear();

    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const openTimer = setTimeout(() => reject(new Error('connect timeout')), 20_000);
      ws.addEventListener('open', () => {
        clearTimeout(openTimer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(openTimer);
        reject(new Error('websocket error during connect'));
      }, { once: true });
    });

    if (myEpoch !== this.epoch) return; // superseded while connecting

    this.log('connected, waiting for AUTH challenge');

    const messagesDone = new Promise<void>((resolve) => {
      ws.addEventListener('close', () => {
        if (myEpoch === this.epoch) {
          this.authenticated = false;
          this.rejectAllPending('connection closed');
        }
        resolve();
      }, { once: true });
    });

    ws.addEventListener('message', (evt) => this.handleFrame(myEpoch, String(evt.data)));
    ws.addEventListener('error', () => {
      // Handled via 'close' — WebSocket fires close after error.
    });

    const challenge = await this.waitForAuthChallenge(myEpoch);
    if (myEpoch !== this.epoch) return;

    const authEvent = buildAuthEvent(challenge, this.relayUrl, this.secretKeyHex);
    const { accepted, message } = await this.sendAndAwaitOk(authEvent, AUTH_OK_TIMEOUT_MS);
    if (myEpoch !== this.epoch) return;
    if (!accepted) {
      throw new Error(`AUTH rejected: ${message}`);
    }

    this.authenticated = true;
    this.backoffMs = INITIAL_BACKOFF_MS; // reset backoff on a clean successful auth
    this.log('NIP-42 authentication successful');

    this.sendSubscriptions();

    await messagesDone;
  }

  private sendSubscriptions(): void {
    if (!this.ws) return;
    for (const channelId of this.subscribedChannels) {
      const subId = `buzz-${channelId.slice(0, 16)}`;
      this.subToChannel.set(subId, channelId);
      this.sendRaw(['REQ', subId, { kinds: [9], '#h': [channelId] }]);
    }
  }

  private waitForAuthChallenge(myEpoch: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAuthChallenge = null;
        reject(new Error('timed out waiting for AUTH challenge'));
      }, AUTH_CHALLENGE_TIMEOUT_MS);
      this.pendingAuthChallenge = {
        resolve: (challenge: string) => {
          if (myEpoch !== this.epoch) return;
          clearTimeout(timer);
          resolve(challenge);
        },
        timer,
      };
    });
  }

  private sendAndAwaitOk(event: NostrEvent, timeoutMs: number): Promise<{ accepted: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOks.delete(event.id);
        reject(new Error('timed out waiting for OK'));
      }, timeoutMs);
      this.pendingOks.set(event.id, {
        resolve: (accepted, message) => {
          clearTimeout(timer);
          resolve({ accepted, message });
        },
        timer,
      });
      const frameType = event.kind === 22242 ? 'AUTH' : 'EVENT';
      this.sendRaw([frameType, event]);
    });
  }

  private sendRaw(value: unknown): void {
    if (!this.ws) return;
    this.ws.send(JSON.stringify(value));
  }

  private handleFrame(myEpoch: number, raw: string): void {
    if (myEpoch !== this.epoch) return; // stale connection — ignore

    let arr: unknown[];
    try {
      arr = JSON.parse(raw);
    } catch {
      return;
    }
    const type = arr[0];

    switch (type) {
      case 'AUTH': {
        const challenge = arr[1];
        if (typeof challenge === 'string' && this.pendingAuthChallenge) {
          this.pendingAuthChallenge.resolve(challenge);
          this.pendingAuthChallenge = null;
        }
        break;
      }
      case 'OK': {
        const eventId = arr[1];
        const accepted = Boolean(arr[2]);
        const message = typeof arr[3] === 'string' ? arr[3] : '';
        if (typeof eventId === 'string') {
          const pending = this.pendingOks.get(eventId);
          if (pending) {
            this.pendingOks.delete(eventId);
            pending.resolve(accepted, message);
          }
        }
        break;
      }
      case 'EOSE': {
        const subId = arr[1];
        if (typeof subId === 'string') this.eoseSeen.add(subId);
        break;
      }
      case 'EVENT': {
        const subId = arr[1];
        const nostrEvent = arr[2] as NostrEvent | undefined;
        if (typeof subId !== 'string' || !nostrEvent) break;
        // Skip historical backlog delivered before EOSE for this subscription.
        if (!this.eoseSeen.has(subId)) break;
        const channelId = this.subToChannel.get(subId);
        if (!channelId) break;
        for (const handler of this.messageHandlers) {
          try {
            handler(channelId, nostrEvent);
          } catch (err) {
            this.log(`message handler error: ${err}`);
          }
        }
        break;
      }
      case 'NOTICE':
      case 'CLOSED':
      case 'COUNT':
        // Not needed for the MVP text-in/text-out scope; log and ignore.
        break;
      default:
        break;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingOks) {
      clearTimeout(pending.timer);
      pending.resolve(false, reason);
    }
    this.pendingOks.clear();
    if (this.pendingAuthChallenge) {
      clearTimeout(this.pendingAuthChallenge.timer);
      this.pendingAuthChallenge = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
