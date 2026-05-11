/**
 * tests/e2e/lifecycle-codex.test.ts — codex E2E lifecycle peer to lifecycle.test.ts.
 *
 * Drives a real `WsUnixJsonRpcClient` against the in-process `mock-codex.js`
 * server and asserts the wire-level contract that the codex-app-server PTY
 * adapter relies on. Covers (per PR 09 §1 minimum):
 *
 *   - WS handshake + JSON-RPC framing
 *   - `initialize` → capabilities response
 *   - `thread/start` → thread.id + `thread/started` notification
 *   - `turn/start` → `turn/started`, `item/agentMessage/delta`, `item/completed`,
 *     `thread/tokenUsage/updated`, `turn/completed` notifications, in order
 *   - Error frame propagation (server -> client error)
 *   - `thread/goal/{set,get,clear}` round-trip and notifications
 *   - `skills/list` round-trip
 *
 * No real codex binary is required; tests run hermetically in CI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WsUnixJsonRpcClient } from '../../src/utils/ws-unix-client.js';

const { MockCodexServer } = require('./mock-codex.js') as {
  MockCodexServer: new (options: {
    socketPath: string;
    skills?: Array<{ name: string; path: string; enabled?: boolean }>;
    turnDeltaText?: string;
    tokenUsage?: Record<string, number>;
    modelContextWindow?: number;
  }) => MockCodexServerInstance;
};

interface MockCodexServerInstance {
  listen(): Promise<void>;
  close(): Promise<void>;
  failNextWith(code: number, message: string): void;
  onNotify(handler: (method: string, params: unknown) => void): () => void;
  requestLog: Array<{ method: string; params: unknown; notification?: boolean }>;
}

describe('E2E codex lifecycle (mock-codex.js + WsUnixJsonRpcClient)', () => {
  let testDir: string;
  let socketPath: string;
  let server: MockCodexServerInstance;
  let client: WsUnixJsonRpcClient;
  let notifications: Array<{ method: string; params: unknown }>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lifecycle-codex-'));
    socketPath = join(testDir, 'codex.sock');
    server = new MockCodexServer({
      socketPath,
      skills: [{ name: 'review-pr', path: '/skills/review-pr', enabled: true }],
      turnDeltaText: 'hello world',
    });
    await server.listen();
    notifications = [];
    client = new WsUnixJsonRpcClient(socketPath);
    client.onMessage((message) => {
      if (typeof message === 'object' && message !== null && 'method' in message && !('id' in message)) {
        notifications.push({ method: (message as { method: string }).method, params: (message as { params: unknown }).params });
      }
    });
    await client.connect();
  });

  afterEach(async () => {
    client.close();
    await server.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('completes the WS handshake and accepts initialize/initialized', async () => {
    const response = await client.request<{ capabilities: { experimentalApi: boolean } }>('initialize', {
      clientInfo: { name: 'cortextos-test', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    expect(response.result?.capabilities.experimentalApi).toBe(true);

    client.notify('initialized');
    await waitFor(() => server.requestLog.some((entry) => entry.method === 'initialized' && entry.notification));
    expect(server.requestLog.find((entry) => entry.method === 'initialized' && entry.notification)).toBeDefined();
  });

  it('thread/start returns a thread id and emits thread/started', async () => {
    const response = await client.request<{ thread: { id: string } }>('thread/start', {
      cwd: '/tmp/test',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(response.result?.thread.id).toMatch(/^mock-thread-/);

    await waitFor(() => notifications.some((n) => n.method === 'thread/started'));
    const started = notifications.find((n) => n.method === 'thread/started')!;
    const startedParams = started.params as { threadId: string };
    expect(startedParams.threadId).toBe(response.result?.thread.id);
  });

  it('turn/start emits the full notification sequence in order', async () => {
    const thread = await client.request<{ thread: { id: string } }>('thread/start', { cwd: '/tmp' });
    const threadId = thread.result?.thread.id;
    notifications.length = 0;

    await client.request<{ turnId: string }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    });

    await waitFor(() => notifications.some((n) => n.method === 'turn/completed'));

    const order = notifications.map((n) => n.method);
    expect(order).toContain('turn/started');
    expect(order).toContain('item/agentMessage/delta');
    expect(order).toContain('item/completed');
    expect(order).toContain('thread/tokenUsage/updated');
    expect(order).toContain('turn/completed');
    expect(order.indexOf('turn/started')).toBeLessThan(order.indexOf('turn/completed'));
    expect(order.indexOf('thread/tokenUsage/updated')).toBeLessThan(order.indexOf('turn/completed'));
  });

  it('thread/tokenUsage/updated carries the schema fields the PTY adapter consumes', async () => {
    const thread = await client.request<{ thread: { id: string } }>('thread/start', { cwd: '/tmp' });
    const threadId = thread.result?.thread.id;
    notifications.length = 0;

    await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'x', text_elements: [] }] });
    await waitFor(() => notifications.some((n) => n.method === 'thread/tokenUsage/updated'));

    const usage = notifications.find((n) => n.method === 'thread/tokenUsage/updated')!;
    const params = usage.params as {
      threadId: string;
      turnId: string;
      tokenUsage: {
        total: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number };
        modelContextWindow: number;
      };
    };
    expect(params.threadId).toBe(threadId);
    expect(typeof params.turnId).toBe('string');
    expect(params.tokenUsage.total.inputTokens).toBeGreaterThan(0);
    expect(params.tokenUsage.total.outputTokens).toBeGreaterThan(0);
    expect(params.tokenUsage.total.totalTokens).toBeGreaterThan(0);
    expect(params.tokenUsage.modelContextWindow).toBe(256000);
  });

  it('propagates server-side error frames as rejected promises', async () => {
    server.failNextWith(-32602, 'Invalid params');
    await expect(client.request('initialize', {})).rejects.toThrow(/Invalid params/);
  });

  it('thread/goal/{set,get,clear} updates state and emits matching notifications', async () => {
    const thread = await client.request<{ thread: { id: string } }>('thread/start', { cwd: '/tmp' });
    const threadId = thread.result?.thread.id;

    await client.request('thread/goal/set', { threadId, objective: 'ship PR-09' });
    await waitFor(() => notifications.some((n) => n.method === 'thread/goal/updated'));

    const get1 = await client.request<{ goal: { objective: string } | null }>('thread/goal/get', { threadId });
    expect(get1.result?.goal?.objective).toBe('ship PR-09');

    notifications.length = 0;
    await client.request('thread/goal/clear', { threadId });
    await waitFor(() => notifications.some((n) => n.method === 'thread/goal/cleared'));

    const get2 = await client.request<{ goal: { objective: string } | null }>('thread/goal/get', { threadId });
    expect(get2.result?.goal).toBeNull();
  });

  it('skills/list returns the configured fixture and is keyed by cwd', async () => {
    const response = await client.request<{ data: Array<{ cwd: string; skills: Array<{ name: string }> }> }>('skills/list', {
      cwds: ['/tmp/repo'],
      forceReload: false,
    });
    expect(response.result?.data[0].cwd).toBe('/tmp/repo');
    expect(response.result?.data[0].skills[0].name).toBe('review-pr');
  });

  it('thread/resume reuses an existing thread id when supplied', async () => {
    const start = await client.request<{ thread: { id: string } }>('thread/start', { cwd: '/tmp' });
    const threadId = start.result?.thread.id;
    const resume = await client.request<{ thread: { id: string } }>('thread/resume', { threadId, cwd: '/tmp' });
    expect(resume.result?.thread.id).toBe(threadId);
  });

  it('unknown methods return JSON-RPC -32601', async () => {
    await expect(client.request('not/a/method', {})).rejects.toThrow(/Method not found/);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
