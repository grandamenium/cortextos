/**
 * Telegram Bot API client using built-in fetch (Node.js 20+).
 * No external dependencies.
 */

import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';

/**
 * Result of TelegramAPI.validateCredentials. Tagged union so callers can
 * key targeted error messages off the `reason` discriminant.
 *
 * ok=false reasons:
 *  - bad_token: 401 from getMe; BOT_TOKEN is invalid or revoked
 *  - chat_not_found: 400 from getChat; CHAT_ID is not reachable by this bot
 *    (most commonly: the user never sent /start to the bot)
 *  - bot_recipient: getChat succeeded but the recipient is a bot (type=private
 *    && is_bot=true), or Telegram returned the 403 "bots can't send messages
 *    to bots" error at probe time. Bots cannot message bots.
 *  - self_chat: CHAT_ID matches the bot's OWN user id (getMe.id). This is the
 *    self-chat trap: someone pasted the BOT_TOKEN prefix into CHAT_ID. Caught without
 *    needing a sendMessage probe — getMe alone is enough.
 *  - network_error: fetch() threw — DNS, timeout, or offline. Callers should
 *    treat as WARNING, not hard-fail.
 *  - rate_limited: 429 from the Telegram API. Callers should treat as WARNING,
 *    not hard-fail (retry later).
 */
export type ValidateCredentialsResult =
  | {
      ok: true;
      botUsername: string;
      botId: number;
      chatType: string;
      chatTitle?: string;
    }
  | {
      ok: false;
      reason:
        | 'bad_token'
        | 'chat_not_found'
        | 'bot_recipient'
        | 'self_chat'
        | 'network_error'
        | 'rate_limited';
      detail: string;
    };

/**
 * Format a human-readable error message for a failed ValidateCredentialsResult.
 * Single source of truth for the CLI-facing error strings so setup.ts and
 * enable-agent.ts stay in sync. Never leaks BOT_TOKEN (not even a prefix).
 */
export function formatValidateError(result: Extract<ValidateCredentialsResult, { ok: false }>): string {
  switch (result.reason) {
    case 'bad_token':
      return 'BOT_TOKEN is invalid or revoked. Telegram returned 401 Unauthorized. Check the token in your .env against @BotFather.';
    case 'chat_not_found':
      return (
        `CHAT_ID ${result.detail} was not found by the bot. ` +
        'The most common cause: the user has never sent /start to the bot. ' +
        'Open Telegram, send /start to your bot, then retry.'
      );
    case 'bot_recipient':
      return (
        `CHAT_ID ${result.detail} resolves to a bot, not a user. ` +
        'A Telegram bot cannot message another bot. ' +
        'Confirm this is a real user chat_id, not a bot user id.'
      );
    case 'self_chat':
      return (
        `CHAT_ID (${result.detail}) matches the bot's own user ID. ` +
        'You likely pasted the BOT_TOKEN prefix instead of your real chat_id. ' +
        'To get your real chat_id: send /start to the bot in Telegram, then visit ' +
        'https://api.telegram.org/bot<TOKEN>/getUpdates and look for result[-1].message.chat.id.'
      );
    case 'network_error':
      return `Could not reach the Telegram API: ${result.detail}. Check connectivity and retry.`;
    case 'rate_limited':
      return `Telegram API rate-limited the validation probe (${result.detail}). Retry in a few seconds.`;
  }
}

export class TelegramAPI {
  private baseUrl: string;
  private lastSendTime: Map<string, number> = new Map();
  // Chat IDs already warned for the self_chat trap. Keeps the runtime
  // diagnostic emitted at most once per chat_id per process lifetime.
  private warnedSelfChat: Set<string> = new Set();

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Convert a Markdown-flavored string to Telegram HTML.
   *
   * Why HTML instead of Markdown v1: Telegram Markdown v1 silently drops
   * content when it encounters an unclosed or unrecognised entity (backtick
   * spans containing `--flags`, `$` before numbers, `_` inside filenames,
   * etc.). HTML parse mode rejects the whole message with an explicit error
   * instead — no silent data loss.
   *
   * Processing order (matters — do not reorder):
   *   1. HTML-escape & < > in raw text (& first, then < >). Backticks, *,
   *      _ are not HTML-special so they survive intact for step 2+.
   *   2. Fenced code blocks (``` ... ```) → <pre><code>...</code></pre>
   *   3. Inline code (`...`) → <code>...</code>
   *   4. Bold (*...*) → <b>...</b>
   *   5. Italic (_..._) — word-boundary aware to avoid snake_case false positives
   *   6. Links ([text](url)) → <a href="url">text</a>
   *
   * Pass `plainText: true` to skip conversion (just HTML-escape and send raw).
   */
  private markdownToHtml(text: string, plainText = false): string {
    // Step 1: HTML-escape (& must be first to avoid double-escaping)
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    if (plainText) return html;

    // Step 2: Fenced code blocks — multiline, processed before inline `
    html = html.replace(/```(?:\w*\n?)?([\s\S]*?)```/g, (_, code) =>
      `<pre><code>${code.trimEnd()}</code></pre>`,
    );

    // Step 3: Inline code — single backtick, no newlines inside
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Step 4: Bold — *text* (no newlines, greedy-avoided)
    html = html.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');

    // Step 5: Italic — _text_ with word-boundary guard (no newlines)
    html = html.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '<i>$1</i>');

    // Step 6: Links — [text](url). URL may contain HTML-escaped & (&amp;) which is fine.
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

    return html;
  }

  /**
   * Split HTML text into chunks at paragraph/newline boundaries to avoid
   * breaking mid-entity. Falls back to hard split only if a single line
   * exceeds maxLen.
   */
  private splitHtml(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      const window = remaining.slice(0, maxLen);
      // Prefer splitting at a paragraph break (\n\n), then a newline
      let splitAt = window.lastIndexOf('\n\n');
      if (splitAt > 0) {
        splitAt += 2; // include the double-newline in the preceding chunk
      } else {
        splitAt = window.lastIndexOf('\n');
        if (splitAt > 0) splitAt += 1;
        else splitAt = maxLen; // no newline — hard split as last resort
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }

  /**
   * Send a text message. Converts Markdown to HTML and sends with
   * `parse_mode: "HTML"`. HTML mode never silently drops content — bad
   * markup produces an explicit API error rather than invisible text.
   *
   * Pass `{ parseMode: null }` to send plain text (no formatting, no
   * conversion). Useful for raw log output or user-supplied text that
   * should not be interpreted as Markdown.
   *
   * Long messages are split at paragraph/newline boundaries (not raw char
   * offsets) so formatting entities are never cut mid-span.
   */
  async sendMessage(
    chatId: string | number,
    text: string,
    replyMarkup?: object,
    opts?: {
      parseMode?: 'HTML' | null;
      onParseFallback?: (reason: string) => void;
    },
  ): Promise<any> {
    const plainText = opts?.parseMode === null;
    const html = this.markdownToHtml(text, plainText);

    await this.rateLimit(String(chatId));

    const chunks = this.splitHtml(html, 4096);

    let lastResult: any;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLastChunk = i === chunks.length - 1;
      lastResult = await this.sendChunk(
        chatId,
        chunk,
        plainText ? null : 'HTML',
        isLastChunk ? replyMarkup : undefined,
      );
    }
    return lastResult;
  }

  /**
   * Send a single chunk with the given parse mode.
   */
  private async sendChunk(
    chatId: string | number,
    text: string,
    parseMode: 'HTML' | null,
    replyMarkup: object | undefined,
  ): Promise<any> {
    const basePayload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    };

    const payload =
      parseMode === null ? basePayload : { ...basePayload, parse_mode: parseMode };

    try {
      return await this.post('sendMessage', payload);
    } catch (err) {
      // self_chat safety net: a 403 "bots can't send messages to bots" at
      // sendMessage time means CHAT_ID likely equals the bot's own user id.
      const msg = err instanceof Error ? err.message : String(err);
      if (/bots can'?t send messages to bots/i.test(msg)) {
        const key = String(chatId);
        if (!this.warnedSelfChat.has(key)) {
          this.warnedSelfChat.add(key);
          console.warn(
            `[telegram] self_chat trap likely: chat_id=${key} resolved to another bot. ` +
            `Check .env — CHAT_ID must be YOUR Telegram user id, not the BOT_TOKEN prefix. ` +
            `Fix by sending /start to the bot from your own account and reading the chat id via getUpdates.`,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Send a photo with optional caption and reply markup.
   * Uses multipart/form-data via built-in Node.js APIs.
   */
  async sendPhoto(
    chatId: string | number,
    imagePath: string,
    caption?: string,
    replyMarkup?: object,
  ): Promise<any> {
    if (!existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }

    await this.rateLimit(String(chatId));

    const fileData = readFileSync(imagePath);
    const fileName = basename(imagePath);

    // Build multipart form data using built-in FormData + Blob
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('photo', new Blob([fileData]), fileName);
    if (caption) {
      formData.append('caption', caption);
    }
    if (replyMarkup) {
      formData.append('reply_markup', JSON.stringify(replyMarkup));
    }

    try {
      const response = await fetch(`${this.baseUrl}/sendPhoto`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(60000),
      });
      const result = await response.json() as any;
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Telegram API error')) {
        throw err;
      }
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`Telegram API request timed out after 60s: sendPhoto`);
      }
      throw new Error(`Telegram API request failed: ${err}`);
    }
  }

  /**
   * Send a document (file) with optional caption. Works for any file type
   * that isn't a photo: PDFs, text files, archives, etc.
   */
  async sendDocument(
    chatId: string | number,
    filePath: string,
    caption?: string,
    replyMarkup?: object,
  ): Promise<any> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    await this.rateLimit(String(chatId));

    const fileData = readFileSync(filePath);
    const fileName = basename(filePath);

    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('document', new Blob([fileData]), fileName);
    if (caption) {
      formData.append('caption', caption);
    }
    if (replyMarkup) {
      formData.append('reply_markup', JSON.stringify(replyMarkup));
    }

    try {
      const response = await fetch(`${this.baseUrl}/sendDocument`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(60000),
      });
      const result = await response.json() as any;
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Telegram API error')) {
        throw err;
      }
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`Telegram API request timed out after 60s: sendDocument`);
      }
      throw new Error(`Telegram API request failed: ${err}`);
    }
  }

  /**
   * Get updates via long polling.
   */
  async getUpdates(offset: number, timeout: number = 1): Promise<any> {
    return this.post('getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'callback_query', 'message_reaction'],
    });
  }

  /**
   * Get info about the bot itself (getMe). Throws on Telegram API error.
   * Primarily used by validateCredentials() to confirm the BOT_TOKEN is
   * valid and to look up the bot's own user id for the self_chat check.
   */
  async getMe(): Promise<any> {
    return this.post('getMe', {});
  }

  /**
   * Get info about a chat (getChat). Throws on Telegram API error.
   * Used by validateCredentials() to confirm the chat_id is reachable
   * and to inspect the chat type + is_bot flag.
   */
  async getChat(chatId: string | number): Promise<any> {
    return this.post('getChat', { chat_id: chatId });
  }

  /**
   * Race a promise against a timeout. Used by validateCredentials() so a
   * network partition cannot hang `cortextos enable` or `cortextos setup`
   * indefinitely. The underlying fetch keeps running in the background
   * after the timeout, but that is acceptable for a one-off probe.
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
        ms,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Probe whether this bot + chat_id combination is actually usable for
   * sending messages, without attempting a send. Catches the classes of
   * silent-broken-config that used to surface only at first real send:
   *
   *   1. bad_token — BOT_TOKEN is invalid or revoked (401 from getMe)
   *   2. chat_not_found — CHAT_ID was never opened with this bot (400)
   *   3. bot_recipient — CHAT_ID resolves to another bot (403 at send time,
   *      or getChat returns type=private is_bot=true)
   *   4. self_chat — CHAT_ID equals getMe.id, meaning someone pasted the
   *      BOT_TOKEN prefix into CHAT_ID (the "self_chat trap")
   *   5. network_error — fetch itself failed; caller should treat as WARN
   *   6. rate_limited — 429 from Telegram; caller should treat as WARN
   *
   * Never sends a real message. Only two API calls: getMe and getChat.
   * Both are free operations on the Telegram side.
   */
  async validateCredentials(chatId: string | number): Promise<ValidateCredentialsResult> {
    // Normalize chatId to a string for comparisons; Telegram accepts either.
    const chatIdStr = String(chatId).trim();
    if (!chatIdStr) {
      return { ok: false, reason: 'chat_not_found', detail: '(empty)' };
    }

    // Validation probes are bounded at 10s per call so a network partition
    // cannot hang `cortextos enable` or `cortextos setup` indefinitely.
    const TIMEOUT_MS = 10_000;

    // Step 1: getMe — validates the token AND gives us the bot's user id
    // for the self_chat check.
    let me: any;
    try {
      me = await this.withTimeout(this.getMe(), TIMEOUT_MS, 'Telegram API request');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Unauthorized|401/i.test(msg)) {
        return { ok: false, reason: 'bad_token', detail: msg };
      }
      if (/Too Many Requests|429/i.test(msg)) {
        return { ok: false, reason: 'rate_limited', detail: msg };
      }
      // Any other error at the getMe step is a network-level failure
      // (fetch threw, DNS died, etc.) rather than a credential problem.
      if (/Telegram API error/.test(msg)) {
        // The API replied but with an unrecognized error shape. Treat as
        // bad_token conservatively — it's the most common cause.
        return { ok: false, reason: 'bad_token', detail: msg };
      }
      return { ok: false, reason: 'network_error', detail: msg };
    }

    const botId: number | undefined = me?.result?.id;
    const botUsername: string = me?.result?.username ?? '(unknown)';

    // Step 2: the self_chat check. If CHAT_ID matches the bot's own user id,
    // no further probing is needed — the config is broken no matter what
    // getChat would return. This catches the self-chat trap before any additional
    // API calls.
    if (botId !== undefined && String(botId) === chatIdStr) {
      return { ok: false, reason: 'self_chat', detail: chatIdStr };
    }

    // Step 3: getChat — confirms the chat is reachable by this bot and
    // lets us inspect type + is_bot.
    let chat: any;
    try {
      chat = await this.withTimeout(this.getChat(chatIdStr), TIMEOUT_MS, 'Telegram API request');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/chat not found|Bad Request/i.test(msg)) {
        return { ok: false, reason: 'chat_not_found', detail: chatIdStr };
      }
      if (/bots can.?t send messages to bots|Forbidden/i.test(msg)) {
        return { ok: false, reason: 'bot_recipient', detail: chatIdStr };
      }
      if (/Too Many Requests|429/i.test(msg)) {
        return { ok: false, reason: 'rate_limited', detail: msg };
      }
      if (/Telegram API error/.test(msg)) {
        return { ok: false, reason: 'chat_not_found', detail: chatIdStr };
      }
      return { ok: false, reason: 'network_error', detail: msg };
    }

    const chatType: string = chat?.result?.type ?? '(unknown)';
    const chatIsBot: boolean = chatType === 'private' && chat?.result?.is_bot === true;
    const chatTitle: string | undefined =
      chat?.result?.title ?? chat?.result?.first_name ?? chat?.result?.username;

    if (chatIsBot) {
      return { ok: false, reason: 'bot_recipient', detail: chatIdStr };
    }

    return {
      ok: true,
      botUsername,
      botId: botId ?? 0,
      chatType,
      chatTitle,
    };
  }

  /**
   * Answer a callback query.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<any> {
    return this.post('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || 'OK',
    });
  }

  /**
   * Edit a message's text.
   */
  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    replyMarkup?: object,
  ): Promise<any> {
    return this.post('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  /**
   * Send typing indicator.
   */
  async sendChatAction(chatId: string | number, action: string = 'typing'): Promise<any> {
    return this.post('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  /**
   * Get file info for downloading.
   */
  async getFile(fileId: string): Promise<any> {
    return this.post('getFile', { file_id: fileId });
  }

  /**
   * Download a file from Telegram servers.
   */
  async downloadFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.getToken()}/${filePath}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Register bot commands for autocomplete.
   */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<any> {
    return this.post('setMyCommands', { commands });
  }

  /**
   * Make a POST request to the Telegram API.
   */
  private async post(method: string, data: object): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json() as any;
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Telegram API error')) {
        throw err;
      }
      // AbortSignal.timeout surfaces as DOMException name=TimeoutError (or AbortError).
      // Surface as a clean retryable error so the poller loop recovers next tick
      // instead of silently hanging on a wedged TCP connection.
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`Telegram API request timed out after 15s: ${method}`);
      }
      throw new Error(`Telegram API request failed: ${err}`);
    }
  }

  /**
   * Simple rate limiter: 1 message per second per chat.
   */
  private async rateLimit(chatId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastSendTime.get(chatId) || 0;
    const elapsed = now - last;
    if (elapsed < 1000) {
      await new Promise(resolve => setTimeout(resolve, 1000 - elapsed));
    }
    this.lastSendTime.set(chatId, Date.now());
  }

  /**
   * Extract token from base URL.
   */
  private getToken(): string {
    return this.baseUrl.replace('https://api.telegram.org/bot', '');
  }
}
