/**
 * Telegram Bot API client using built-in fetch (Node.js 20+).
 * No external dependencies.
 */

import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';

export class TelegramAPI {
  private baseUrl: string;
  private lastSendTime: Map<string, number> = new Map();

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Strip MarkdownV2-style backslash escapes that Telegram Markdown v1 doesn't support.
   * In v1, only *, _, `, [ are special. Everything else should not be backslash-escaped.
   */
  private sanitizeMarkdown(text: string): string {
    // Remove backslash before any char that isn't a Markdown v1 special char or newline
    return text.replace(/\\([^_*`\[\n])/g, '$1');
  }

  /**
   * Send a text message. Splits long messages at 4096 chars.
   */
  async sendMessage(
    chatId: string | number,
    text: string,
    replyMarkup?: object,
  ): Promise<any> {
    const sanitized = this.sanitizeMarkdown(text);
    // Rate limit: 1 message per second per chat
    await this.rateLimit(String(chatId));

    // Split long messages
    const maxLen = 4096;
    if (sanitized.length <= maxLen) {
      return this.post('sendMessage', {
        chat_id: chatId,
        text: sanitized,
        parse_mode: 'Markdown',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }

    // Split into chunks
    const chunks: string[] = [];
    for (let i = 0; i < sanitized.length; i += maxLen) {
      chunks.push(sanitized.slice(i, i + maxLen));
    }

    let result: any;
    for (const chunk of chunks) {
      result = await this.post('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      });
    }
    return result;
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
      allowed_updates: ['message', 'callback_query'],
    });
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
