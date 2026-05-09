import { randomBytes, createHash } from 'crypto';
import { Socket, createConnection } from 'net';

export interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
type MessageHandler = (message: JsonRpcMessage) => void;

interface PendingRequest {
  resolve: (message: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal WebSocket-over-Unix JSON-RPC client.
 *
 * Codex app-server's `unix://` transport is WebSocket-framed. The JSON-RPC
 * payloads inside text frames are newline-delimited, matching the stdio
 * transport after the WebSocket layer is removed. This helper intentionally
 * uses Node built-ins only so the app-server adapter adds no runtime deps.
 */
export class WsUnixJsonRpcClient {
  private socket: Socket | null = null;
  private frameBuffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private handlers: MessageHandler[] = [];

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    if (this.socket) return;

    const socket = createConnection(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    const key = randomBytes(16).toString('base64');
    socket.write([
      'GET / HTTP/1.1',
      'Host: localhost',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));

    const { header, leftover } = await this.readHandshake(socket);
    if (!header.startsWith('HTTP/1.1 101') && !header.startsWith('HTTP/1.0 101')) {
      socket.destroy();
      throw new Error(`WebSocket handshake failed: ${header.split('\r\n')[0] || header}`);
    }

    const accept = header.match(/^Sec-WebSocket-Accept:\s*(.+)$/im)?.[1]?.trim();
    const expected = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    if (accept && accept !== expected) {
      socket.destroy();
      throw new Error('WebSocket handshake failed: Sec-WebSocket-Accept mismatch');
    }

    this.socket = socket;
    socket.on('data', (chunk) => this.parseFrames(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('error', (err) => this.rejectAll(err));
    socket.on('close', () => {
      this.rejectAll(new Error('WebSocket Unix socket closed'));
      this.socket = null;
    });

    if (leftover.length > 0) {
      this.parseFrames(leftover);
    }
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      try {
        socket.end(this.encodeFrame('', 0x8));
      } catch {
        socket.destroy();
      }
    }
    this.rejectAll(new Error('WebSocket Unix socket closed'));
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<JsonRpcResponse<T>> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('WebSocket Unix socket is not connected'));
    }

    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method, params };
    return new Promise<JsonRpcResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => resolve(response as JsonRpcResponse<T>),
        reject,
        timer,
      });
      this.send(message);
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    this.send({ id, error: { code, message, data } });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('WebSocket Unix socket is not connected');
    }
    this.socket.write(this.encodeFrame(`${JSON.stringify(message)}\n`));
  }

  private readHandshake(socket: Socket): Promise<{ header: string; leftover: Buffer }> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        socket.off('data', onData);
        socket.off('error', onError);
        resolve({
          header: buffer.subarray(0, end).toString('utf-8'),
          leftover: buffer.subarray(end + 4),
        });
      };
      const onError = (err: Error) => {
        socket.off('data', onData);
        reject(err);
      };
      socket.on('data', onData);
      socket.once('error', onError);
    });
  }

  private encodeFrame(text: string, opcode = 0x1): Buffer {
    const payload = Buffer.from(text, 'utf-8');
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | opcode;

    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    return Buffer.concat([header, mask, masked]);
  }

  private parseFrames(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);

    while (this.frameBuffer.length >= 2) {
      const b0 = this.frameBuffer[0];
      const b1 = this.frameBuffer[1];
      const opcode = b0 & 0x0f;
      const masked = Boolean(b1 & 0x80);
      let length = b1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.frameBuffer.length < 4) return;
        length = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.frameBuffer.length < 10) return;
        length = Number(this.frameBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.frameBuffer.length < offset + length) return;

      let payload = this.frameBuffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.frameBuffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      this.frameBuffer = this.frameBuffer.subarray(offset + length);

      if (opcode === 0x1) {
        this.parseTextPayload(payload.toString('utf-8'));
      } else if (opcode === 0x8) {
        this.close();
        return;
      }
    }
  }

  private parseTextPayload(text: string): void {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch (err) {
        for (const handler of this.handlers) {
          handler({
            jsonrpc: '2.0',
            method: '_parse_error',
            params: { line, error: (err as Error).message },
          } as unknown as JsonRpcMessage);
        }
        continue;
      }
      if ('id' in message && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if ('error' in message && message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message as JsonRpcResponse);
        }
        continue;
      }

      for (const handler of this.handlers) {
        handler(message);
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
