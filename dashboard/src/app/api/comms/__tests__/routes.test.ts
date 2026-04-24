/**
 * Tests for the Comms Hub API routes.
 *
 * Each test spins up a fresh temp CTX_ROOT, seeds it with a minimal set
 * of agent registry + message history + inbox files, then invokes the
 * route handler directly and asserts on the Response.
 *
 * We set CTX_ROOT + ADMIN_USERNAME before importing the handlers so the
 * route modules pick them up at evaluation time.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Global setup — one shared tmp root across all tests in this file.
// Each test isolates itself by writing into its own subpath or clearing files.
// ---------------------------------------------------------------------------
const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-routes-'));
process.env.CTX_ROOT = rootTmp;
process.env.ADMIN_USERNAME = 'james';

// Dynamic imports AFTER env vars are set.
type FeedRoute = typeof import('../feed/route');
type ChannelsRoute = typeof import('../channels/route');
type ChannelRoute = typeof import('../channel/[pair]/route');
type UploadRoute = typeof import('../upload/route');

let feed: FeedRoute;
let channels: ChannelsRoute;
let channel: ChannelRoute;
let upload: UploadRoute;

beforeAll(async () => {
  feed = await import('../feed/route');
  channels = await import('../channels/route');
  channel = await import('../channel/[pair]/route');
  upload = await import('../upload/route');
});

afterAll(() => {
  try { fs.rmSync(rootTmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Wipe and re-seed CTX_ROOT before each test so state does not leak.
beforeEach(() => {
  for (const entry of fs.readdirSync(rootTmp)) {
    fs.rmSync(path.join(rootTmp, entry), { recursive: true, force: true });
  }
  // Always seed an empty enabled-agents.json so resolveIdentity has agents.
  fs.mkdirSync(path.join(rootTmp, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(rootTmp, 'config', 'enabled-agents.json'),
    JSON.stringify({ boris: {}, nick: {} }),
  );
  // Empty inbox base exists so the "no inboxBase" short-circuit doesn't fire.
  fs.mkdirSync(path.join(rootTmp, 'inbox'), { recursive: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeHistory(messages: Array<Record<string, unknown>>) {
  const logDir = path.join(rootTmp, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(path.join(logDir, 'message-history.jsonl'), lines);
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'));
}

// ---------------------------------------------------------------------------
// GET /api/comms/feed
// ---------------------------------------------------------------------------
describe('GET /api/comms/feed', () => {
  it('returns messages from history log sorted newest-first', async () => {
    writeHistory([
      { id: 'm1', from: 'boris', to: 'nick', priority: 'normal', timestamp: '2026-04-15T09:00:00Z', text: 'hello', reply_to: null },
      { id: 'm2', from: 'nick', to: 'boris', priority: 'normal', timestamp: '2026-04-15T10:00:00Z', text: 'world', reply_to: null },
    ]);

    const res = await feed.GET(makeRequest('/api/comms/feed'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('m2'); // newest first
    expect(data[1].id).toBe('m1');
  });

  it('returns an empty array when there is no inbox directory', async () => {
    // Wipe the inbox dir seeded by beforeEach to hit the short-circuit.
    fs.rmSync(path.join(rootTmp, 'inbox'), { recursive: true, force: true });

    const res = await feed.GET(makeRequest('/api/comms/feed'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it('applies the search filter to message text', async () => {
    writeHistory([
      { id: 'm1', from: 'boris', to: 'nick', priority: 'normal', timestamp: '2026-04-15T09:00:00Z', text: 'hello world', reply_to: null },
      { id: 'm2', from: 'nick', to: 'boris', priority: 'normal', timestamp: '2026-04-15T10:00:00Z', text: 'unrelated', reply_to: null },
    ]);

    const res = await feed.GET(makeRequest('/api/comms/feed?search=hello'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('m1');
  });
});

// ---------------------------------------------------------------------------
// GET /api/comms/channels
// ---------------------------------------------------------------------------
describe('GET /api/comms/channels', () => {
  it('groups messages by pair and reports last-message metadata', async () => {
    const t1 = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    writeHistory([
      { id: 'm1', from: 'boris', to: 'nick', priority: 'normal', timestamp: t1, text: 'hi', reply_to: null },
      { id: 'm2', from: 'nick', to: 'boris', priority: 'normal', timestamp: t2, text: 'reply', reply_to: null },
    ]);

    const res = await channels.GET(makeRequest('/api/comms/channels'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].pair).toBe('boris--nick');
    expect(data[0].message_count).toBe(2);
    expect(data[0].last_message.from).toBe('nick');
    expect(data[0].archived).toBe(false);
  });

  it('hides channels older than the archive threshold by default', async () => {
    writeHistory([
      { id: 'old', from: 'boris', to: 'nick', priority: 'normal', timestamp: '2020-01-01T00:00:00Z', text: 'ancient', reply_to: null },
    ]);

    const defaultRes = await channels.GET(makeRequest('/api/comms/channels'));
    expect(await defaultRes.json()).toEqual([]);

    const includeRes = await channels.GET(makeRequest('/api/comms/channels?include_archived=true'));
    const data = await includeRes.json();
    expect(data).toHaveLength(1);
    expect(data[0].archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/comms/channel/[pair]
// ---------------------------------------------------------------------------
describe('GET /api/comms/channel/[pair]', () => {
  it('returns only messages matching the pair, oldest-first', async () => {
    writeHistory([
      { id: 'm1', from: 'boris', to: 'nick', priority: 'normal', timestamp: '2026-04-15T09:00:00Z', text: 'first', reply_to: null },
      { id: 'm2', from: 'nick', to: 'boris', priority: 'normal', timestamp: '2026-04-15T10:00:00Z', text: 'second', reply_to: null },
      { id: 'm3', from: 'boris', to: 'james', priority: 'normal', timestamp: '2026-04-15T11:00:00Z', text: 'other pair', reply_to: null },
    ]);

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('m1');
    expect(data[1].id).toBe('m2');
  });

  it('rejects malformed pair strings with a 400', async () => {
    // "only-one-side" has no `--` separator.
    const res = await channel.GET(
      makeRequest('/api/comms/channel/only-one-side'),
      { params: Promise.resolve({ pair: 'only-one-side' }) },
    );
    expect(res.status).toBe(400);

    // Uppercase / special chars should also be rejected.
    const res2 = await channel.GET(
      makeRequest('/api/comms/channel/Boris--NICK'),
      { params: Promise.resolve({ pair: 'Boris--NICK' }) },
    );
    expect(res2.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/comms/upload
// ---------------------------------------------------------------------------
describe('POST /api/comms/upload', () => {
  /** Build a POST request carrying a single-file multipart body. */
  function uploadRequest(file: File): NextRequest {
    const form = new FormData();
    form.append('file', file);
    return new NextRequest(new URL('http://localhost/api/comms/upload'), {
      method: 'POST',
      body: form,
    });
  }

  it('writes a PNG into media/dashboard-uploads and returns its URL', async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], 'shot.png', {
      type: 'image/png',
    });

    const res = await upload.POST(uploadRequest(png));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.path.startsWith('media/dashboard-uploads/')).toBe(true);
    expect(data.url.startsWith('/api/media/media/dashboard-uploads/')).toBe(true);
    expect(data.filename.endsWith('.png')).toBe(true);

    const absPath = path.join(rootTmp, data.path);
    expect(fs.existsSync(absPath)).toBe(true);
  });

  it('rejects unsupported MIME types (including SVG)', async () => {
    // SVG is now explicitly disallowed because it can carry inline <script>.
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'evil.svg', {
      type: 'image/svg+xml',
    });
    const svgRes = await upload.POST(uploadRequest(svg));
    expect(svgRes.status).toBe(400);

    const html = new File(['<html></html>'], 'page.html', { type: 'text/html' });
    const htmlRes = await upload.POST(uploadRequest(html));
    expect(htmlRes.status).toBe(400);
  });

  it('forces the server-chosen extension regardless of the uploaded filename', async () => {
    // Attacker attempts to smuggle an HTML-looking filename through a png MIME.
    const png = new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], '../../evil.html', {
      type: 'image/png',
    });
    const res = await upload.POST(uploadRequest(png));
    expect(res.status).toBe(200);
    const data = await res.json();

    // Extension must be the MIME-derived .png, NOT .html.
    expect(data.filename.endsWith('.png')).toBe(true);
    expect(data.filename.includes('..')).toBe(false);
    expect(data.filename.includes('/')).toBe(false);

    // And the file must live inside the intended upload dir, not above it.
    const absPath = path.resolve(rootTmp, data.path);
    const uploadDir = path.resolve(rootTmp, 'media', 'dashboard-uploads');
    expect(absPath.startsWith(uploadDir + path.sep)).toBe(true);
  });

  it('rejects files over 10MB', async () => {
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'huge.png', {
      type: 'image/png',
    });
    const res = await upload.POST(uploadRequest(big));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(String(data.error).toLowerCase()).toContain('too large');
  });
});
