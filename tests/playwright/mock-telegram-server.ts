/**
 * Mock Telegram Bot API server for Playwright E2E tests.
 * Implements all endpoints our TelegramAPI class calls.
 */
import http from 'http';

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
  timestamp: number;
  contentType?: string;
}

export class MockTelegramServer {
  private server: http.Server;
  private port: number;
  public requests: RecordedRequest[] = [];
  private messageIdCounter = 1;
  private updateIdCounter = 100;
  private pendingUpdates: unknown[] = [];
  private fileStore: Map<string, Buffer> = new Map();
  // Configurable error responses
  private errorOverrides: Map<string, { code: number; description: string }> = new Map();
  // Rate limit simulation
  private rateLimitUntil: number = 0;

  constructor(port: number = 39182) {
    this.port = port;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  reset(): void {
    this.requests = [];
    this.messageIdCounter = 1;
    this.updateIdCounter = 100;
    this.pendingUpdates = [];
    this.fileStore.clear();
    this.errorOverrides.clear();
    this.rateLimitUntil = 0;
  }

  getBaseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  /** Queue a fake message update for getUpdates */
  queueMessage(msg: Record<string, unknown>): void {
    this.pendingUpdates.push({
      update_id: this.updateIdCounter++,
      message: {
        message_id: this.messageIdCounter++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345, type: 'private' },
        from: { id: 67890, first_name: 'Test', username: 'testuser' },
        ...msg,
      },
    });
  }

  /** Queue a callback query update for getUpdates */
  queueCallback(data: string, messageId?: number): void {
    this.pendingUpdates.push({
      update_id: this.updateIdCounter++,
      callback_query: {
        id: `cbq_${Date.now()}`,
        from: { id: 67890, first_name: 'Test', username: 'testuser' },
        message: {
          message_id: messageId ?? this.messageIdCounter - 1,
          chat: { id: 12345, type: 'private' },
          text: 'Original message',
        },
        data,
      },
    });
  }

  /**
   * Queue a message_reaction update for getUpdates.
   * Mirrors queueMessage/queueCallback. Caller passes optional old/new
   * reaction arrays (TelegramReactionType[] shape: `{type:'emoji',emoji}`
   * or `{type:'custom_emoji',custom_emoji_id}`). Default arrays are empty,
   * matching Telegram's wire format for "no prior reaction" / "user
   * removed all reactions".
   */
  queueReaction(opts: {
    messageId?: number;
    oldReaction?: Array<
      | { type: 'emoji'; emoji: string }
      | { type: 'custom_emoji'; custom_emoji_id: string }
    >;
    newReaction?: Array<
      | { type: 'emoji'; emoji: string }
      | { type: 'custom_emoji'; custom_emoji_id: string }
    >;
  } = {}): void {
    this.pendingUpdates.push({
      update_id: this.updateIdCounter++,
      message_reaction: {
        chat: { id: 12345, type: 'private' },
        user: { id: 67890, first_name: 'Test', username: 'testuser' },
        message_id: opts.messageId ?? this.messageIdCounter - 1,
        date: Math.floor(Date.now() / 1000),
        old_reaction: opts.oldReaction ?? [],
        new_reaction: opts.newReaction ?? [],
      },
    });
  }

  /** Store a file for getFile/download */
  storeFile(fileId: string, content: Buffer): void {
    this.fileStore.set(fileId, content);
  }

  /** Set an error response for a specific API method */
  setError(method: string, code: number, description: string): void {
    this.errorOverrides.set(method, { code, description });
  }

  /** Simulate rate limiting */
  setRateLimit(durationMs: number): void {
    this.rateLimitUntil = Date.now() + durationMs;
  }

  /** Get requests filtered by method */
  getRequestsFor(apiMethod: string): RecordedRequest[] {
    return this.requests.filter(r => r.path.endsWith(`/${apiMethod}`));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '', `http://localhost:${this.port}`);
    const pathParts = url.pathname.split('/');

    // Handle file downloads: /file/bot{token}/{filePath}
    if (url.pathname.startsWith('/file/')) {
      const fileId = pathParts[pathParts.length - 1];
      const content = this.fileStore.get(fileId);
      if (content) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end('File not found');
      }
      return;
    }

    // API methods: /bot{token}/{method}
    const apiMethod = pathParts[pathParts.length - 1];

    // Check rate limit
    if (Date.now() < this.rateLimitUntil) {
      const retryAfter = Math.ceil((this.rateLimitUntil - Date.now()) / 1000);
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
      res.end(JSON.stringify({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after ' + retryAfter,
        parameters: { retry_after: retryAfter },
      }));
      return;
    }

    // Check error overrides
    if (this.errorOverrides.has(apiMethod)) {
      const err = this.errorOverrides.get(apiMethod)!;
      res.writeHead(err.code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: err.code, description: err.description }));
      return;
    }

    // Collect body
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      let body: Record<string, unknown> = {};

      if (contentType.includes('application/json')) {
        try { body = JSON.parse(rawBody.toString()); } catch { /* empty */ }
      } else if (contentType.includes('multipart/form-data')) {
        // Simple multipart parsing - extract text fields
        body = { _multipart: true, _size: rawBody.length };
        const boundary = contentType.split('boundary=')[1]?.split(';')[0];
        if (boundary) {
          const parts = rawBody.toString('binary').split(`--${boundary}`);
          for (const part of parts) {
            const nameMatch = part.match(/name="([^"]+)"/);
            const filenameMatch = part.match(/filename="([^"]+)"/);
            if (nameMatch) {
              const name = nameMatch[1];
              if (filenameMatch) {
                body[name] = `[file: ${filenameMatch[1]}]`;
                body[`${name}_filename`] = filenameMatch[1];
              } else {
                const valueMatch = part.split('\r\n\r\n');
                if (valueMatch[1]) {
                  body[name] = valueMatch[1].replace(/\r\n--$/, '').trim();
                }
              }
            }
          }
        }
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(rawBody.toString());
        for (const [k, v] of params) { body[k] = v; }
      }

      this.requests.push({
        method: req.method || 'GET',
        path: url.pathname,
        body,
        timestamp: Date.now(),
        contentType: contentType || undefined,
      });

      const response = this.routeMethod(apiMethod, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  }

  private routeMethod(method: string, body: Record<string, unknown>): unknown {
    switch (method) {
      case 'sendMessage': return this.handleSendMessage(body);
      case 'sendPhoto': return this.handleSendPhoto(body);
      case 'editMessageText': return this.handleEditMessage(body);
      case 'sendChatAction': return { ok: true, result: true };
      case 'answerCallbackQuery': return { ok: true, result: true };
      case 'setMyCommands': return { ok: true, result: true };
      case 'getUpdates': return this.handleGetUpdates(body);
      case 'getFile': return this.handleGetFile(body);
      default: return { ok: true, result: {} };
    }
  }

  private handleSendMessage(body: Record<string, unknown>) {
    const msgId = this.messageIdCounter++;
    return {
      ok: true,
      result: {
        message_id: msgId,
        from: { id: 111, is_bot: true, first_name: 'TestBot' },
        chat: { id: Number(body.chat_id) || 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: body.text,
      },
    };
  }

  private handleSendPhoto(body: Record<string, unknown>) {
    const msgId = this.messageIdCounter++;
    return {
      ok: true,
      result: {
        message_id: msgId,
        from: { id: 111, is_bot: true, first_name: 'TestBot' },
        chat: { id: Number(body.chat_id) || 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        photo: [
          { file_id: 'photo_small', width: 90, height: 90 },
          { file_id: 'photo_large', width: 800, height: 600 },
        ],
        caption: body.caption,
      },
    };
  }

  private handleEditMessage(body: Record<string, unknown>) {
    return {
      ok: true,
      result: {
        message_id: Number(body.message_id) || 1,
        from: { id: 111, is_bot: true, first_name: 'TestBot' },
        chat: { id: Number(body.chat_id) || 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: body.text,
      },
    };
  }

  private handleGetUpdates(_body: Record<string, unknown>) {
    const updates = [...this.pendingUpdates];
    this.pendingUpdates = [];
    return { ok: true, result: updates };
  }

  private handleGetFile(body: Record<string, unknown>) {
    const fileId = body.file_id as string;
    if (this.fileStore.has(fileId)) {
      return {
        ok: true,
        result: {
          file_id: fileId,
          file_unique_id: `unique_${fileId}`,
          file_size: this.fileStore.get(fileId)!.length,
          file_path: fileId, // Use fileId as the download path
        },
      };
    }
    return {
      ok: false,
      error_code: 400,
      description: 'Bad Request: file not found',
    };
  }
}
