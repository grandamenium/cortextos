#!/usr/bin/env node
/**
 * Mock codex-app-server for E2E testing.
 *
 * Speaks the same WebSocket-over-Unix-socket JSON-RPC protocol as the real
 * `codex app-server` binary, but uses a deterministic in-memory state machine
 * so tests can drive lifecycle transitions without depending on a real codex
 * install. Mirrors `tests/e2e/mock-claude.js` for the codex runtime.
 *
 * Two usage modes:
 *
 *   1. Library: `const { startMockCodexServer } = require('./mock-codex.js');`
 *      Creates a server bound to a unix socket; tests connect with the real
 *      `WsUnixJsonRpcClient` and exercise the protocol end-to-end.
 *
 *   2. Binary: `node mock-codex.js app-server --listen unix://./codex.sock`
 *      Matches the CLI shape of the real codex binary so that fixtures which
 *      shim `codex` on PATH (e.g. via a wrapper shell script) can spawn this
 *      mock instead.
 *
 * Coverage (per PR 09 scope §1, "minimum: init handshake, turn/start,
 * turn/completed, error frames"):
 *   - WS upgrade handshake
 *   - JSON-RPC `initialize` request + `initialized` notification
 *   - `thread/start`, `thread/resume`, `thread/list` requests
 *   - `turn/start` request → emits `turn/started`, `item/agentMessage/delta`,
 *     `item/completed`, `thread/tokenUsage/updated`, `turn/completed`
 *   - `thread/goal/{set,get,clear}` requests + `thread/goal/{updated,cleared}`
 *     notifications
 *   - `skills/list` request returning a configurable fixture
 *   - Synthetic error frames on demand (for client error-handling tests)
 */

'use strict';

const net = require('net');
const { createHash, randomUUID } = require('crypto');
const { promisify } = require('util');
const { unlink } = require('fs/promises');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class MockCodexServer {
  constructor(options = {}) {
    this.socketPath = options.socketPath;
    this.skills = options.skills || [];
    this.tokenUsage = options.tokenUsage || {
      cachedInputTokens: 0,
      inputTokens: 100,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      totalTokens: 150,
    };
    this.modelContextWindow = options.modelContextWindow || 256000;
    this.threadStartDelayMs = options.threadStartDelayMs || 0;
    this.turnDeltaText = options.turnDeltaText || 'mock response';
    this.failNextRequest = null;
    this.threads = new Map();
    this.nextTurnId = 1;
    this.server = null;
    this.connections = new Set();
    this.notifyHooks = [];
    this.requestLog = [];
  }

  async listen() {
    if (this.server) return;
    try { await unlink(this.socketPath); } catch { /* ok */ }

    const server = net.createServer((socket) => this._handleConnection(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  async close() {
    for (const conn of this.connections) {
      try { conn.destroy(); } catch { /* ok */ }
    }
    this.connections.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    try { await unlink(this.socketPath); } catch { /* ok */ }
  }

  /** Force the next inbound request (any method) to respond with a JSON-RPC error. */
  failNextWith(code, message) {
    this.failNextRequest = { code, message };
  }

  /** Subscribe to every outbound notification (for assertion convenience). */
  onNotify(handler) {
    this.notifyHooks.push(handler);
    return () => {
      this.notifyHooks = this.notifyHooks.filter((h) => h !== handler);
    };
  }

  _handleConnection(socket) {
    this.connections.add(socket);
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let frameBuffer = Buffer.alloc(0);

    const onData = (chunk) => {
      if (!handshakeDone) {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const header = buffer.subarray(0, end).toString('utf-8');
        const leftover = buffer.subarray(end + 4);

        const keyMatch = header.match(/^Sec-WebSocket-Key:\s*(.+)$/im);
        if (!keyMatch) {
          socket.destroy();
          return;
        }
        const accept = createHash('sha1').update(keyMatch[1].trim() + WS_GUID).digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'));
        handshakeDone = true;
        if (leftover.length > 0) frameBuffer = leftover;
        return;
      }

      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      while (frameBuffer.length >= 2) {
        const b0 = frameBuffer[0];
        const b1 = frameBuffer[1];
        const opcode = b0 & 0x0f;
        const masked = Boolean(b1 & 0x80);
        let length = b1 & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (frameBuffer.length < 4) return;
          length = frameBuffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (frameBuffer.length < 10) return;
          length = Number(frameBuffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (frameBuffer.length < offset + length) return;
        let payload = frameBuffer.subarray(offset, offset + length);
        if (masked) {
          const mask = frameBuffer.subarray(maskOffset, maskOffset + 4);
          payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
        }
        frameBuffer = frameBuffer.subarray(offset + length);

        if (opcode === 0x1) {
          this._processTextFrame(socket, payload.toString('utf-8'));
        } else if (opcode === 0x8) {
          try { socket.end(this._encodeFrame('', 0x8)); } catch { /* ok */ }
          return;
        }
      }
    };

    socket.on('data', onData);
    socket.on('error', () => { /* swallow; close handler cleans up */ });
    socket.on('close', () => this.connections.delete(socket));
  }

  _processTextFrame(socket, text) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method && message.id !== undefined) {
        this.requestLog.push({ method: message.method, params: message.params });
        this._handleRequest(socket, message);
      } else if (message.method) {
        this.requestLog.push({ method: message.method, params: message.params, notification: true });
        // Notifications (e.g. `initialized`) are accepted silently.
      }
    }
  }

  _handleRequest(socket, message) {
    const { id, method, params } = message;
    if (this.failNextRequest) {
      const { code, message: errMsg } = this.failNextRequest;
      this.failNextRequest = null;
      this._send(socket, { id, error: { code, message: errMsg } });
      return;
    }

    switch (method) {
      case 'initialize':
        this._send(socket, { id, result: { capabilities: { experimentalApi: true } } });
        return;
      case 'thread/start': {
        const threadId = `mock-thread-${randomUUID().slice(0, 8)}`;
        this.threads.set(threadId, { cwd: params?.cwd || '/tmp', goal: null });
        this._send(socket, { id, result: { thread: { id: threadId } } });
        setTimeout(() => {
          this._notify(socket, 'thread/started', { threadId });
        }, this.threadStartDelayMs);
        return;
      }
      case 'thread/resume': {
        const threadId = params?.threadId || `mock-thread-${randomUUID().slice(0, 8)}`;
        if (!this.threads.has(threadId)) {
          this.threads.set(threadId, { cwd: params?.cwd || '/tmp', goal: null });
        }
        this._send(socket, { id, result: { thread: { id: threadId } } });
        return;
      }
      case 'thread/list':
        this._send(socket, {
          id,
          result: {
            data: Array.from(this.threads.entries()).map(([threadId, state]) => ({
              id: threadId,
              cwd: state.cwd,
            })),
          },
        });
        return;
      case 'turn/start': {
        const turnId = `mock-turn-${this.nextTurnId++}`;
        const threadId = params?.threadId;
        this._send(socket, { id, result: { turnId } });
        this._notify(socket, 'turn/started', { threadId, turnId });
        this._notify(socket, 'item/agentMessage/delta', { threadId, turnId, delta: this.turnDeltaText });
        this._notify(socket, 'item/completed', {
          threadId,
          turnId,
          item: { type: 'agentMessage', text: this.turnDeltaText },
        });
        this._notify(socket, 'thread/tokenUsage/updated', {
          threadId,
          turnId,
          tokenUsage: {
            last: this.tokenUsage,
            total: this.tokenUsage,
            modelContextWindow: this.modelContextWindow,
          },
        });
        this._notify(socket, 'turn/completed', { threadId, turnId });
        return;
      }
      case 'thread/goal/set': {
        const state = this.threads.get(params?.threadId);
        const goal = { objective: params?.objective || '', status: 'active' };
        if (state) state.goal = goal;
        this._send(socket, { id, result: { goal } });
        this._notify(socket, 'thread/goal/updated', { threadId: params?.threadId, goal });
        return;
      }
      case 'thread/goal/get': {
        const state = this.threads.get(params?.threadId);
        this._send(socket, { id, result: { goal: state?.goal ?? null } });
        return;
      }
      case 'thread/goal/clear': {
        const state = this.threads.get(params?.threadId);
        if (state) state.goal = null;
        this._send(socket, { id, result: {} });
        this._notify(socket, 'thread/goal/cleared', { threadId: params?.threadId });
        return;
      }
      case 'skills/list':
        this._send(socket, {
          id,
          result: {
            data: [{ cwd: params?.cwds?.[0] || '/tmp', skills: this.skills }],
          },
        });
        return;
      default:
        this._send(socket, {
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  }

  _notify(socket, method, params) {
    const message = { method, params };
    for (const hook of this.notifyHooks) {
      try { hook(method, params); } catch { /* ok */ }
    }
    this._send(socket, message);
  }

  _send(socket, message) {
    if (socket.destroyed) return;
    try {
      socket.write(this._encodeFrame(`${JSON.stringify(message)}\n`));
    } catch { /* ok */ }
  }

  _encodeFrame(text, opcode = 0x1) {
    const payload = Buffer.from(text, 'utf-8');
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = payload.length;
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, payload]);
  }
}

async function startMockCodexServer(options) {
  const server = new MockCodexServer(options);
  await server.listen();
  return server;
}

module.exports = { MockCodexServer, startMockCodexServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] !== 'app-server') {
    console.error('mock-codex: only `app-server` subcommand is supported');
    process.exit(1);
  }
  let socketPath = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--listen' && args[i + 1]) {
      const value = args[i + 1];
      const match = value.match(/^unix:\/\/(?:\.\/)?(.+)$/);
      socketPath = match ? match[1] : value;
      i += 1;
    }
  }
  if (!socketPath) {
    console.error('mock-codex: --listen unix://./<socket> is required');
    process.exit(1);
  }
  const cwd = process.cwd();
  const path = require('path');
  const resolved = path.isAbsolute(socketPath) ? socketPath : path.join(cwd, socketPath);

  const server = new MockCodexServer({ socketPath: resolved });
  server.listen().then(() => {
    process.stdout.write(`[codex-app-server] ready socket=${resolved}\n`);
  }).catch((err) => {
    console.error(`mock-codex: listen failed: ${err.message}`);
    process.exit(1);
  });

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
