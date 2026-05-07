import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync } from 'fs';
import type { PosterConfig } from './types.js';
import type {
  PostCommentRequest,
  SendConnectionRequest,
  SendDmRequest,
  PublishPostRequest,
} from './types.js';
import { BrowserManager } from './browser.js';
import {
  postLinkedInComment,
  sendConnectionRequest,
  sendDM,
  publishLinkedInPost,
} from './actions.js';
import { sendHeartbeat } from './heartbeat.js';
import { QueueConsumer } from './queue-consumer.js';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const config: PosterConfig = {
  profileDir: process.env['PROFILE_DIR'] ?? '/var/lib/linkedin-poster/profiles/default',
  userId: process.env['USER_ID'] ?? 'default',
  senderName: process.env['SENDER_NAME'] ?? 'LinkedIn Poster',
  senderLinkedInId: process.env['SENDER_LINKEDIN_ID'] ?? '',
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseKey: requireEnv('SUPABASE_KEY'),
  port: parseInt(process.env['PORT'] ?? '3100', 10),
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const browser = new BrowserManager(config);
let inFlight = false;
let lastActionAt = 0;
const MIN_GAP_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Action guard
// ---------------------------------------------------------------------------

async function withActionGuard<T>(
  res: ServerResponse,
  handler: () => Promise<T>
): Promise<void> {
  if (inFlight) {
    send(res, 429, { success: false, error: 'Another action is in flight' });
    return;
  }
  const now = Date.now();
  const gap = now - lastActionAt;
  if (lastActionAt > 0 && gap < MIN_GAP_MS) {
    send(res, 429, {
      success: false,
      error: `Rate limited — wait ${Math.ceil((MIN_GAP_MS - gap) / 1000)}s`,
    });
    return;
  }
  inFlight = true;
  try {
    const result = await handler();
    lastActionAt = Date.now();
    send(res, 200, result);
  } catch (err) {
    send(res, 500, { success: false, error: (err as Error).message });
  } finally {
    inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // Health / readiness
  if (url === '/health' && method === 'GET') {
    const healthy = await browser.checkHealth();
    send(res, healthy ? 200 : 503, { ok: healthy, userId: config.userId });
    return;
  }

  if (method !== 'POST') {
    send(res, 405, { error: 'Method not allowed' });
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    send(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const page = browser.getPage();

  switch (url) {
    case '/comment': {
      const { postUrl, commentText } = body as PostCommentRequest;
      await withActionGuard(res, () => postLinkedInComment(page, postUrl, commentText));
      break;
    }
    case '/connect': {
      const { profileUrl, noteText } = body as SendConnectionRequest;
      await withActionGuard(res, () => sendConnectionRequest(page, profileUrl, noteText));
      break;
    }
    case '/dm': {
      const { profileUrl, messageText } = body as SendDmRequest;
      await withActionGuard(res, () => sendDM(page, profileUrl, messageText));
      break;
    }
    case '/post': {
      const { postText, imagePaths } = body as PublishPostRequest;
      await withActionGuard(res, () => publishLinkedInPost(page, postText, imagePaths));
      break;
    }
    default:
      send(res, 404, { error: 'Not found' });
  }
}

// ---------------------------------------------------------------------------
// Queue consumer (engagement + RPC jobs)
// ---------------------------------------------------------------------------

function startQueueConsumer(): QueueConsumer {
  const consumer = new QueueConsumer(config);
  consumer.start();
  return consumer;
}

// ---------------------------------------------------------------------------
// Heartbeat loop
// ---------------------------------------------------------------------------

async function runHeartbeatLoop(): Promise<void> {
  const INTERVAL_MS = 60_000;

  const tick = async () => {
    try {
      const healthy = await browser.checkHealth();
      await sendHeartbeat(config, {
        agentName: `linkedin-poster-selfhost-${config.userId}`,
        browserHealthy: healthy,
        status: inFlight ? 'busy' : 'idle',
        profilePath: config.profileDir,
        metadata: { senderName: config.senderName, lastActionAt },
      });
    } catch (err) {
      console.error('[heartbeat-loop] Error:', (err as Error).message);
    }
  };

  await tick(); // immediate first beat
  setInterval(tick, INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await browser.init();

  const queue = startQueueConsumer();

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[server] Unhandled error:', err);
      res.writeHead(500).end('Internal server error');
    });
  });

  server.listen(config.port, () => {
    console.log(`[server] linkedin-poster-selfhost listening on :${config.port}`);
    console.log(`[server] userId=${config.userId} profileDir=${config.profileDir}`);
  });

  await runHeartbeatLoop();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[server] Shutting down...');
    queue.stop();
    server.close();
    await browser.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[main] Fatal:', err);
  process.exit(1);
});
