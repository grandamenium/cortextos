import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveEnv } from '../utils/env.js';
import { loadBuzzChannelConfig, loadBuzzSecretKey } from '../buzz/identity.js';
import { buildAuthEvent, buildChannelMessageEvent } from '../buzz/event.js';

/**
 * `cortextos buzz` — one-shot CLI entry points for the Buzz (Nostr/NIP-29)
 * adapter, mirroring `cortextos slack`'s shape: a `send` command the
 * injected "Reply using:" line invokes, plus operator-facing `test-send`
 * and `discover-channels` utilities.
 *
 * Each command opens its own short-lived connection (connect, AUTH, publish
 * or subscribe, then exit) rather than reusing the daemon's persistent
 * BuzzRelayClient — this mirrors buzz-ws-client's `publish_event()`
 * one-shot helper and keeps the CLI usable even when the daemon isn't
 * running (e.g. testing credentials before starting an agent).
 */

const CONNECT_TIMEOUT_MS = 20_000;
const AUTH_TIMEOUT_MS = 20_000;
const OK_TIMEOUT_MS = 30_000;

/** Resolves relay URL + secret key for the caller's agent, or process.env fallback. */
function resolveBuzzCredentials(): { relayUrl: string; secretKey: string; pubkey: string } | null {
  const env = resolveEnv();
  let relayUrl: string | undefined;
  let secretKey: string | undefined;

  if (env.agentDir) {
    const channelConfig = loadBuzzChannelConfig(env.agentDir);
    relayUrl = channelConfig?.relay_url;
    secretKey = loadBuzzSecretKey(env.agentDir);
  }

  relayUrl = relayUrl || process.env.BUZZ_RELAY_URL;
  secretKey = secretKey || process.env.BUZZ_PRIVATE_KEY;

  if (!relayUrl || !secretKey) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(secretKey)) return null;

  const { getPublicKey } = require('../buzz/event.js') as typeof import('../buzz/event.js');
  return { relayUrl, secretKey, pubkey: getPublicKey(secretKey) };
}

/**
 * Opens a WebSocket, completes the NIP-42 AUTH handshake, and returns the
 * open+authenticated socket. Callers are responsible for closing it.
 */
async function connectAndAuthenticate(relayUrl: string, secretKey: string): Promise<WebSocket> {
  const ws = new WebSocket(relayUrl);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket error')); }, { once: true });
  });

  const challenge = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for AUTH challenge')), AUTH_TIMEOUT_MS);
    const handler = (evt: MessageEvent) => {
      try {
        const arr = JSON.parse(String(evt.data));
        if (arr[0] === 'AUTH' && typeof arr[1] === 'string') {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          resolve(arr[1]);
        }
      } catch { /* ignore malformed frames while waiting */ }
    };
    ws.addEventListener('message', handler);
  });

  const authEvent = buildAuthEvent(challenge, relayUrl, secretKey);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for AUTH OK')), OK_TIMEOUT_MS);
    const handler = (evt: MessageEvent) => {
      try {
        const arr = JSON.parse(String(evt.data));
        if (arr[0] === 'OK' && arr[1] === authEvent.id) {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          if (arr[2]) resolve();
          else reject(new Error(`AUTH rejected: ${arr[3] || ''}`));
        }
      } catch { /* ignore malformed frames while waiting */ }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify(['AUTH', authEvent]));
  });

  return ws;
}

async function publishOnce(relayUrl: string, secretKey: string, channelId: string, text: string, replyTo?: string): Promise<void> {
  const ws = await connectAndAuthenticate(relayUrl, secretKey);
  try {
    const event = buildChannelMessageEvent(channelId, text, secretKey, replyTo);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for publish OK')), OK_TIMEOUT_MS);
      const handler = (evt: MessageEvent) => {
        try {
          const arr = JSON.parse(String(evt.data));
          if (arr[0] === 'OK' && arr[1] === event.id) {
            clearTimeout(timer);
            ws.removeEventListener('message', handler);
            if (arr[2]) resolve();
            else reject(new Error(`relay rejected event: ${arr[3] || ''}`));
          }
        } catch { /* ignore malformed frames while waiting */ }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify(['EVENT', event]));
    });
  } finally {
    ws.close();
  }
}

export const buzzCommand = new Command('buzz')
  .description('Buzz (Nostr/NIP-29) relay commands');

buzzCommand
  .command('send')
  .description('Send a message to a Buzz channel')
  .requiredOption('--channel <id>', 'Channel UUID')
  .requiredOption('--text <text>', 'Message text')
  .option('--reply-to <event-id>', 'Nostr event id to reply to (NIP-10 thread)')
  .option('--agent <name>', 'Agent whose buzz.json/.env to use (defaults to CTX_AGENT_NAME)')
  .action(async (opts: { channel: string; text: string; replyTo?: string; agent?: string }) => {
    const creds = resolveBuzzCredentials();
    if (!creds) {
      console.error('Error: Buzz not configured. Set BUZZ_RELAY_URL + BUZZ_PRIVATE_KEY (agent .env or process env), and ensure buzz.json exists.');
      process.exit(1);
    }
    try {
      await publishOnce(creds.relayUrl, creds.secretKey, opts.channel, opts.text, opts.replyTo);
      console.log('Message sent');
    } catch (err) {
      console.error(`Failed to send: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

buzzCommand
  .command('test-send')
  .description('Send a test message to a Buzz channel and verify the relay accepts it — for validating credentials/connectivity before starting an agent')
  .requiredOption('--channel <id>', 'Channel UUID')
  .option('--text <text>', 'Message text', 'cortextOS Buzz adapter test message')
  .action(async (opts: { channel: string; text: string }) => {
    const creds = resolveBuzzCredentials();
    if (!creds) {
      console.error('Error: Buzz not configured. Set BUZZ_RELAY_URL + BUZZ_PRIVATE_KEY.');
      process.exit(1);
    }
    console.log(`Connecting to ${creds.relayUrl} as pubkey ${creds.pubkey}...`);
    try {
      await publishOnce(creds.relayUrl, creds.secretKey, opts.channel, opts.text);
      console.log('OK — relay accepted the test event. Buzz connectivity verified.');
    } catch (err) {
      console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

buzzCommand
  .command('discover-channels')
  .description("List the channel UUIDs configured in this agent's buzz.json")
  .option('--agent <name>', 'Agent whose buzz.json to read (defaults to CTX_AGENT_NAME)')
  .action((opts: { agent?: string }) => {
    const env = resolveEnv();
    let agentDir = env.agentDir;
    if (opts.agent && opts.agent !== env.agentName && env.projectRoot && env.org) {
      const candidate = join(env.projectRoot, 'orgs', env.org, 'agents', opts.agent);
      if (existsSync(candidate)) agentDir = candidate;
    }
    if (!agentDir) {
      console.error('Error: could not resolve agent directory.');
      process.exit(1);
    }
    const config = loadBuzzChannelConfig(agentDir);
    if (!config) {
      console.error(`No buzz.json found at ${join(agentDir, 'buzz.json')}`);
      process.exit(1);
    }
    if (config.channels.length === 0) {
      console.log('No channels configured.');
      return;
    }
    console.log(`Pubkey: ${config.pubkey}`);
    console.log(`Channels (${config.channels.length}):`);
    for (const c of config.channels) console.log(`  - ${c}`);
  });
