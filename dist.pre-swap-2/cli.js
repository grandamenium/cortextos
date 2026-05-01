#!/usr/bin/env node
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/tsup/assets/cjs_shims.js
var init_cjs_shims = __esm({
  "node_modules/tsup/assets/cjs_shims.js"() {
    "use strict";
  }
});

// src/utils/atomic.ts
function atomicWriteSync(filePath, data) {
  const dir = (0, import_path.dirname)(filePath);
  (0, import_fs.mkdirSync)(dir, { recursive: true });
  const tmpPath = (0, import_path.join)(dir, `.tmp.${(0, import_crypto.randomBytes)(6).toString("hex")}`);
  try {
    (0, import_fs.writeFileSync)(tmpPath, data + "\n", { encoding: "utf-8", mode: 384 });
    (0, import_fs.renameSync)(tmpPath, filePath);
  } catch (err) {
    try {
      const { unlinkSync: unlinkSync4 } = require("fs");
      unlinkSync4(tmpPath);
    } catch {
    }
    throw err;
  }
}
function ensureDir(dirPath) {
  (0, import_fs.mkdirSync)(dirPath, { recursive: true });
}
var import_fs, import_path, import_crypto;
var init_atomic = __esm({
  "src/utils/atomic.ts"() {
    "use strict";
    init_cjs_shims();
    import_fs = require("fs");
    import_path = require("path");
    import_crypto = require("crypto");
  }
});

// src/types/index.ts
var PRIORITY_MAP, VALID_PRIORITIES;
var init_types = __esm({
  "src/types/index.ts"() {
    "use strict";
    init_cjs_shims();
    PRIORITY_MAP = {
      urgent: 0,
      high: 1,
      normal: 2,
      low: 3
    };
    VALID_PRIORITIES = ["urgent", "high", "normal", "low"];
  }
});

// src/utils/validate.ts
function validateInstanceId(instanceId) {
  if (!instanceId || !AGENT_NAME_REGEX.test(instanceId)) {
    throw new Error(
      `Invalid instance ID '${instanceId}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}
function validateAgentName(name) {
  if (!name || !AGENT_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid agent name '${name}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}
function validatePriority(priority) {
  if (!VALID_PRIORITIES.includes(priority)) {
    throw new Error(
      `Invalid priority '${priority}'. Must be one of: ${VALID_PRIORITIES.join(", ")}`
    );
  }
}
function validateEventCategory(category) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(
      `Invalid event category '${category}'. Must be one of: ${VALID_CATEGORIES.join(", ")}`
    );
  }
}
function validateEventSeverity(severity) {
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new Error(
      `Invalid severity '${severity}'. Must be one of: ${VALID_SEVERITIES.join(", ")}`
    );
  }
}
function validateApprovalCategory(category) {
  if (!VALID_APPROVAL_CATEGORIES.includes(category)) {
    throw new Error(
      `Invalid approval category '${category}'. Must be one of: ${VALID_APPROVAL_CATEGORIES.join(", ")}`
    );
  }
}
function isValidJson(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}
var AGENT_NAME_REGEX, VALID_CATEGORIES, VALID_SEVERITIES, VALID_APPROVAL_CATEGORIES;
var init_validate = __esm({
  "src/utils/validate.ts"() {
    "use strict";
    init_cjs_shims();
    init_types();
    AGENT_NAME_REGEX = /^[a-z0-9_-]+$/;
    VALID_CATEGORIES = [
      "action",
      "error",
      "metric",
      "milestone",
      "heartbeat",
      "message",
      "task",
      "approval"
    ];
    VALID_SEVERITIES = ["info", "warning", "error", "critical"];
    VALID_APPROVAL_CATEGORIES = [
      "external-comms",
      "financial",
      "deployment",
      "data-deletion",
      "other"
    ];
  }
});

// src/utils/lock.ts
function acquireLock(dir) {
  const lockDir = (0, import_path9.join)(dir, ".lock.d");
  const pidFile = (0, import_path9.join)(lockDir, "pid");
  try {
    (0, import_fs8.mkdirSync)(lockDir);
    (0, import_fs8.writeFileSync)(pidFile, String(process.pid));
    return true;
  } catch {
    try {
      const storedPid = parseInt((0, import_fs8.readFileSync)(pidFile, "utf-8").trim(), 10);
      if (isNaN(storedPid)) {
        (0, import_fs8.rmSync)(lockDir, { recursive: true, force: true });
        try {
          (0, import_fs8.mkdirSync)(lockDir);
          (0, import_fs8.writeFileSync)(pidFile, String(process.pid));
          return true;
        } catch {
          return false;
        }
      }
      try {
        process.kill(storedPid, 0);
        return false;
      } catch {
        (0, import_fs8.rmSync)(lockDir, { recursive: true, force: true });
        try {
          (0, import_fs8.mkdirSync)(lockDir);
          (0, import_fs8.writeFileSync)(pidFile, String(process.pid));
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      try {
        (0, import_fs8.rmSync)(lockDir, { recursive: true, force: true });
        (0, import_fs8.mkdirSync)(lockDir);
        (0, import_fs8.writeFileSync)(pidFile, String(process.pid));
        return true;
      } catch {
        return false;
      }
    }
  }
}
function releaseLock(dir) {
  const lockDir = (0, import_path9.join)(dir, ".lock.d");
  try {
    (0, import_fs8.rmSync)(lockDir, { recursive: true, force: true });
  } catch {
  }
}
var import_fs8, import_path9;
var init_lock = __esm({
  "src/utils/lock.ts"() {
    "use strict";
    init_cjs_shims();
    import_fs8 = require("fs");
    import_path9 = require("path");
  }
});

// src/utils/random.ts
function randomString(length) {
  const bytes = (0, import_crypto2.randomBytes)(length * 2);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ALPHA_NUMERIC[bytes[i] % ALPHA_NUMERIC.length];
  }
  return result;
}
function randomDigits(length) {
  const bytes = (0, import_crypto2.randomBytes)(length * 2);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += DIGITS[bytes[i] % DIGITS.length];
  }
  return result;
}
var import_crypto2, ALPHA_NUMERIC, DIGITS;
var init_random = __esm({
  "src/utils/random.ts"() {
    "use strict";
    init_cjs_shims();
    import_crypto2 = require("crypto");
    ALPHA_NUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";
    DIGITS = "0123456789";
  }
});

// src/bus/message.ts
function loadSigningKey(ctxRoot) {
  const keyPath = (0, import_path10.join)(ctxRoot, "config", "bus-signing-key");
  if (!(0, import_fs9.existsSync)(keyPath)) return null;
  try {
    return (0, import_fs9.readFileSync)(keyPath, "utf-8").trim();
  } catch {
    return null;
  }
}
function hmacSign(key, payload) {
  return (0, import_crypto3.createHmac)("sha256", key).update(payload).digest("hex");
}
function hmacVerify(key, payload, sig) {
  const expected = hmacSign(key, payload);
  try {
    return (0, import_crypto3.timingSafeEqual)(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}
function signPayload(msgId, from, to, text) {
  return `${msgId}:${from}:${to}:${text}`;
}
function sendMessage(paths, from, to, priority, text, replyTo) {
  validateAgentName(from);
  validateAgentName(to);
  validatePriority(priority);
  const pnum = PRIORITY_MAP[priority];
  const epochMs = Date.now();
  const rand = randomString(5);
  const msgId = `${epochMs}-${from}-${rand}`;
  const filename = `${pnum}-${epochMs}-from-${from}-${rand}.json`;
  const signingKey = loadSigningKey(paths.ctxRoot);
  const message = {
    id: msgId,
    from,
    to,
    priority,
    timestamp: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    text,
    reply_to: replyTo || null,
    ...signingKey ? { sig: hmacSign(signingKey, signPayload(msgId, from, to, text)) } : {}
  };
  const inboxDir = (0, import_path10.join)(paths.ctxRoot, "inbox", to);
  ensureDir(inboxDir);
  atomicWriteSync((0, import_path10.join)(inboxDir, filename), JSON.stringify(message));
  return msgId;
}
function checkInbox(paths) {
  const { inbox, inflight } = paths;
  ensureDir(inbox);
  ensureDir(inflight);
  if (!acquireLock(inbox)) {
    return [];
  }
  try {
    recoverStaleInflight(inflight, inbox, 300);
    const files = (0, import_fs9.readdirSync)(inbox).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
    if (files.length === 0) {
      return [];
    }
    const signingKey = loadSigningKey(paths.ctxRoot);
    const messages = [];
    for (const file of files) {
      const srcPath = (0, import_path10.join)(inbox, file);
      try {
        const content = (0, import_fs9.readFileSync)(srcPath, "utf-8");
        const msg = JSON.parse(content);
        if (signingKey && msg.sig) {
          const valid = hmacVerify(signingKey, signPayload(msg.id, msg.from, msg.to, msg.text), msg.sig);
          if (!valid) {
            console.error(`[bus/message] SECURITY: Message ${msg.id} from '${msg.from}' failed HMAC verification \u2014 rejecting`);
            const errDir = (0, import_path10.join)(inbox, ".errors");
            ensureDir(errDir);
            try {
              (0, import_fs9.renameSync)(srcPath, (0, import_path10.join)(errDir, file));
            } catch {
            }
            continue;
          }
        } else if (signingKey && !msg.sig) {
          console.warn(`[bus/message] WARNING: Unsigned message ${msg.id} from '${msg.from}' \u2014 accepted (legacy)`);
        }
        const destPath = (0, import_path10.join)(inflight, file);
        (0, import_fs9.renameSync)(srcPath, destPath);
        messages.push(msg);
      } catch {
        const errDir = (0, import_path10.join)(inbox, ".errors");
        ensureDir(errDir);
        try {
          (0, import_fs9.renameSync)(srcPath, (0, import_path10.join)(errDir, file));
        } catch {
        }
      }
    }
    return messages;
  } finally {
    releaseLock(inbox);
  }
}
function ackInbox(paths, messageId) {
  const { inflight, processed } = paths;
  ensureDir(processed);
  let files;
  try {
    files = (0, import_fs9.readdirSync)(inflight).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = (0, import_path10.join)(inflight, file);
    try {
      const content = (0, import_fs9.readFileSync)(filePath, "utf-8");
      const msg = JSON.parse(content);
      if (msg.id === messageId) {
        (0, import_fs9.renameSync)(filePath, (0, import_path10.join)(processed, file));
        return;
      }
    } catch {
    }
  }
}
function recoverStaleInflight(inflightDir, inboxDir, thresholdSeconds) {
  const now = Math.floor(Date.now() / 1e3);
  let files;
  try {
    files = (0, import_fs9.readdirSync)(inflightDir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = (0, import_path10.join)(inflightDir, file);
    try {
      const stat = (0, import_fs9.statSync)(filePath);
      const mtime = Math.floor(stat.mtimeMs / 1e3);
      if (now - mtime > thresholdSeconds) {
        (0, import_fs9.renameSync)(filePath, (0, import_path10.join)(inboxDir, file));
      }
    } catch {
    }
  }
}
var import_fs9, import_path10, import_crypto3;
var init_message = __esm({
  "src/bus/message.ts"() {
    "use strict";
    init_cjs_shims();
    import_fs9 = require("fs");
    import_path10 = require("path");
    import_crypto3 = require("crypto");
    init_types();
    init_atomic();
    init_lock();
    init_random();
    init_validate();
  }
});

// src/telegram/api.ts
var api_exports = {};
__export(api_exports, {
  TelegramAPI: () => TelegramAPI,
  formatValidateError: () => formatValidateError
});
function formatValidateError(result) {
  switch (result.reason) {
    case "bad_token":
      return "BOT_TOKEN is invalid or revoked. Telegram returned 401 Unauthorized. Check the token in your .env against @BotFather.";
    case "chat_not_found":
      return `CHAT_ID ${result.detail} was not found by the bot. The most common cause: the user has never sent /start to the bot. Open Telegram, send /start to your bot, then retry.`;
    case "bot_recipient":
      return `CHAT_ID ${result.detail} resolves to a bot, not a user. A Telegram bot cannot message another bot. Confirm this is a real user chat_id, not a bot user id.`;
    case "self_chat":
      return `CHAT_ID (${result.detail}) matches the bot's own user ID. You likely pasted the BOT_TOKEN prefix instead of your real chat_id. To get your real chat_id: send /start to the bot in Telegram, then visit https://api.telegram.org/bot<TOKEN>/getUpdates and look for result[-1].message.chat.id.`;
    case "network_error":
      return `Could not reach the Telegram API: ${result.detail}. Check connectivity and retry.`;
    case "rate_limited":
      return `Telegram API rate-limited the validation probe (${result.detail}). Retry in a few seconds.`;
  }
}
var import_fs14, import_path15, TelegramAPI;
var init_api = __esm({
  "src/telegram/api.ts"() {
    "use strict";
    init_cjs_shims();
    import_fs14 = require("fs");
    import_path15 = require("path");
    TelegramAPI = class {
      baseUrl;
      lastSendTime = /* @__PURE__ */ new Map();
      // Chat IDs already warned for the self_chat trap. Keeps the runtime
      // diagnostic emitted at most once per chat_id per process lifetime.
      warnedSelfChat = /* @__PURE__ */ new Set();
      constructor(token) {
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
      markdownToHtml(text, plainText = false) {
        let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (plainText) return html;
        html = html.replace(
          /```(?:\w*\n?)?([\s\S]*?)```/g,
          (_, code) => `<pre><code>${code.trimEnd()}</code></pre>`
        );
        html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
        html = html.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");
        html = html.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, "<i>$1</i>");
        html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
        return html;
      }
      /**
       * Split HTML text into chunks at paragraph/newline boundaries to avoid
       * breaking mid-entity. Falls back to hard split only if a single line
       * exceeds maxLen.
       */
      splitHtml(text, maxLen) {
        if (text.length <= maxLen) return [text];
        const chunks = [];
        let remaining = text;
        while (remaining.length > maxLen) {
          const window = remaining.slice(0, maxLen);
          let splitAt = window.lastIndexOf("\n\n");
          if (splitAt > 0) {
            splitAt += 2;
          } else {
            splitAt = window.lastIndexOf("\n");
            if (splitAt > 0) splitAt += 1;
            else splitAt = maxLen;
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
      async sendMessage(chatId, text, replyMarkup, opts) {
        const plainText = opts?.parseMode === null;
        const html = this.markdownToHtml(text, plainText);
        await this.rateLimit(String(chatId));
        const chunks = this.splitHtml(html, 4096);
        let lastResult;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const isLastChunk = i === chunks.length - 1;
          lastResult = await this.sendChunk(
            chatId,
            chunk,
            plainText ? null : "HTML",
            isLastChunk ? replyMarkup : void 0
          );
        }
        return lastResult;
      }
      /**
       * Send a single chunk with the given parse mode.
       */
      async sendChunk(chatId, text, parseMode, replyMarkup) {
        const basePayload = {
          chat_id: chatId,
          text,
          ...replyMarkup ? { reply_markup: replyMarkup } : {}
        };
        const payload = parseMode === null ? basePayload : { ...basePayload, parse_mode: parseMode };
        try {
          return await this.post("sendMessage", payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/bots can'?t send messages to bots/i.test(msg)) {
            const key = String(chatId);
            if (!this.warnedSelfChat.has(key)) {
              this.warnedSelfChat.add(key);
              console.warn(
                `[telegram] self_chat trap likely: chat_id=${key} resolved to another bot. Check .env \u2014 CHAT_ID must be YOUR Telegram user id, not the BOT_TOKEN prefix. Fix by sending /start to the bot from your own account and reading the chat id via getUpdates.`
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
      async sendPhoto(chatId, imagePath, caption, replyMarkup) {
        if (!(0, import_fs14.existsSync)(imagePath)) {
          throw new Error(`Image file not found: ${imagePath}`);
        }
        await this.rateLimit(String(chatId));
        const fileData = (0, import_fs14.readFileSync)(imagePath);
        const fileName = (0, import_path15.basename)(imagePath);
        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("photo", new Blob([fileData]), fileName);
        if (caption) {
          formData.append("caption", caption);
        }
        if (replyMarkup) {
          formData.append("reply_markup", JSON.stringify(replyMarkup));
        }
        try {
          const response = await fetch(`${this.baseUrl}/sendPhoto`, {
            method: "POST",
            body: formData,
            signal: AbortSignal.timeout(6e4)
          });
          const result = await response.json();
          if (!result.ok) {
            throw new Error(`Telegram API error: ${result.description || "Unknown error"}`);
          }
          return result;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Telegram API error")) {
            throw err;
          }
          if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
            throw new Error(`Telegram API request timed out after 60s: sendPhoto`);
          }
          throw new Error(`Telegram API request failed: ${err}`);
        }
      }
      /**
       * Send a document (file) with optional caption. Works for any file type
       * that isn't a photo: PDFs, text files, archives, etc.
       */
      async sendDocument(chatId, filePath, caption, replyMarkup) {
        if (!(0, import_fs14.existsSync)(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }
        await this.rateLimit(String(chatId));
        const fileData = (0, import_fs14.readFileSync)(filePath);
        const fileName = (0, import_path15.basename)(filePath);
        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("document", new Blob([fileData]), fileName);
        if (caption) {
          formData.append("caption", caption);
        }
        if (replyMarkup) {
          formData.append("reply_markup", JSON.stringify(replyMarkup));
        }
        try {
          const response = await fetch(`${this.baseUrl}/sendDocument`, {
            method: "POST",
            body: formData,
            signal: AbortSignal.timeout(6e4)
          });
          const result = await response.json();
          if (!result.ok) {
            throw new Error(`Telegram API error: ${result.description || "Unknown error"}`);
          }
          return result;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Telegram API error")) {
            throw err;
          }
          if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
            throw new Error(`Telegram API request timed out after 60s: sendDocument`);
          }
          throw new Error(`Telegram API request failed: ${err}`);
        }
      }
      /**
       * Get updates via long polling.
       */
      async getUpdates(offset, timeout = 1) {
        return this.post("getUpdates", {
          offset,
          timeout,
          allowed_updates: ["message", "callback_query", "message_reaction"]
        });
      }
      /**
       * Get info about the bot itself (getMe). Throws on Telegram API error.
       * Primarily used by validateCredentials() to confirm the BOT_TOKEN is
       * valid and to look up the bot's own user id for the self_chat check.
       */
      async getMe() {
        return this.post("getMe", {});
      }
      /**
       * Get info about a chat (getChat). Throws on Telegram API error.
       * Used by validateCredentials() to confirm the chat_id is reachable
       * and to inspect the chat type + is_bot flag.
       */
      async getChat(chatId) {
        return this.post("getChat", { chat_id: chatId });
      }
      /**
       * Race a promise against a timeout. Used by validateCredentials() so a
       * network partition cannot hang `cortextos enable` or `cortextos setup`
       * indefinitely. The underlying fetch keeps running in the background
       * after the timeout, but that is acceptable for a one-off probe.
       */
      async withTimeout(promise, ms, label) {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${Math.round(ms / 1e3)}s`)),
            ms
          );
        });
        try {
          return await Promise.race([promise, timeout]);
        } finally {
          if (timer !== void 0) clearTimeout(timer);
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
      async validateCredentials(chatId) {
        const chatIdStr = String(chatId).trim();
        if (!chatIdStr) {
          return { ok: false, reason: "chat_not_found", detail: "(empty)" };
        }
        const TIMEOUT_MS = 1e4;
        let me;
        try {
          me = await this.withTimeout(this.getMe(), TIMEOUT_MS, "Telegram API request");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/Unauthorized|401/i.test(msg)) {
            return { ok: false, reason: "bad_token", detail: msg };
          }
          if (/Too Many Requests|429/i.test(msg)) {
            return { ok: false, reason: "rate_limited", detail: msg };
          }
          if (/Telegram API error/.test(msg)) {
            return { ok: false, reason: "bad_token", detail: msg };
          }
          return { ok: false, reason: "network_error", detail: msg };
        }
        const botId = me?.result?.id;
        const botUsername = me?.result?.username ?? "(unknown)";
        if (botId !== void 0 && String(botId) === chatIdStr) {
          return { ok: false, reason: "self_chat", detail: chatIdStr };
        }
        let chat;
        try {
          chat = await this.withTimeout(this.getChat(chatIdStr), TIMEOUT_MS, "Telegram API request");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/chat not found|Bad Request/i.test(msg)) {
            return { ok: false, reason: "chat_not_found", detail: chatIdStr };
          }
          if (/bots can.?t send messages to bots|Forbidden/i.test(msg)) {
            return { ok: false, reason: "bot_recipient", detail: chatIdStr };
          }
          if (/Too Many Requests|429/i.test(msg)) {
            return { ok: false, reason: "rate_limited", detail: msg };
          }
          if (/Telegram API error/.test(msg)) {
            return { ok: false, reason: "chat_not_found", detail: chatIdStr };
          }
          return { ok: false, reason: "network_error", detail: msg };
        }
        const chatType = chat?.result?.type ?? "(unknown)";
        const chatIsBot = chatType === "private" && chat?.result?.is_bot === true;
        const chatTitle = chat?.result?.title ?? chat?.result?.first_name ?? chat?.result?.username;
        if (chatIsBot) {
          return { ok: false, reason: "bot_recipient", detail: chatIdStr };
        }
        return {
          ok: true,
          botUsername,
          botId: botId ?? 0,
          chatType,
          chatTitle
        };
      }
      /**
       * Answer a callback query.
       */
      async answerCallbackQuery(callbackQueryId, text) {
        return this.post("answerCallbackQuery", {
          callback_query_id: callbackQueryId,
          text: text || "OK"
        });
      }
      /**
       * Edit a message's text.
       */
      async editMessageText(chatId, messageId, text, replyMarkup) {
        return this.post("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
          ...replyMarkup ? { reply_markup: replyMarkup } : {}
        });
      }
      /**
       * Send typing indicator.
       */
      async sendChatAction(chatId, action = "typing") {
        return this.post("sendChatAction", {
          chat_id: chatId,
          action
        });
      }
      /**
       * Get file info for downloading.
       */
      async getFile(fileId) {
        return this.post("getFile", { file_id: fileId });
      }
      /**
       * Download a file from Telegram servers.
       */
      async downloadFile(filePath) {
        const url = `https://api.telegram.org/file/bot${this.getToken()}/${filePath}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(3e4) });
        if (!response.ok) {
          throw new Error(`Failed to download file: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
      /**
       * Register bot commands for autocomplete.
       */
      async setMyCommands(commands) {
        return this.post("setMyCommands", { commands });
      }
      /**
       * Make a POST request to the Telegram API.
       */
      async post(method, data) {
        try {
          const response = await fetch(`${this.baseUrl}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
            signal: AbortSignal.timeout(15e3)
          });
          const result = await response.json();
          if (!result.ok) {
            throw new Error(`Telegram API error: ${result.description || "Unknown error"}`);
          }
          return result;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Telegram API error")) {
            throw err;
          }
          if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
            throw new Error(`Telegram API request timed out after 15s: ${method}`);
          }
          throw new Error(`Telegram API request failed: ${err}`);
        }
      }
      /**
       * Simple rate limiter: 1 message per second per chat.
       */
      async rateLimit(chatId) {
        const now = Date.now();
        const last = this.lastSendTime.get(chatId) || 0;
        const elapsed = now - last;
        if (elapsed < 1e3) {
          await new Promise((resolve4) => setTimeout(resolve4, 1e3 - elapsed));
        }
        this.lastSendTime.set(chatId, Date.now());
      }
      /**
       * Extract token from base URL.
       */
      getToken() {
        return this.baseUrl.replace("https://api.telegram.org/bot", "");
      }
    };
  }
});

// src/bus/system.ts
function selfRestart(paths, agentName, reason) {
  const resolvedReason = reason || "no reason specified";
  ensureDir(paths.stateDir);
  (0, import_fs15.writeFileSync)((0, import_path16.join)(paths.stateDir, ".restart-planned"), resolvedReason + "\n", "utf-8");
  ensureDir(paths.logDir);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const logLine = `[${timestamp}] SELF-RESTART: ${resolvedReason}
`;
  (0, import_fs15.appendFileSync)((0, import_path16.join)(paths.logDir, "restarts.log"), logLine, "utf-8");
}
function hardRestart(paths, agentName, reason) {
  const resolvedReason = reason || "no reason specified";
  ensureDir(paths.stateDir);
  (0, import_fs15.writeFileSync)((0, import_path16.join)(paths.stateDir, ".force-fresh"), resolvedReason + "\n", "utf-8");
  (0, import_fs15.writeFileSync)((0, import_path16.join)(paths.stateDir, ".restart-planned"), resolvedReason + "\n", "utf-8");
  ensureDir(paths.logDir);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const logLine = `[${timestamp}] HARD-RESTART: ${resolvedReason}
`;
  (0, import_fs15.appendFileSync)((0, import_path16.join)(paths.logDir, "restarts.log"), logLine, "utf-8");
}
function autoCommit(projectDir, dryRun = false) {
  try {
    (0, import_child_process3.execSync)("git rev-parse --is-inside-work-tree", { cwd: projectDir, stdio: "pipe" });
  } catch {
    return { status: "clean", staged: [], blocked: [] };
  }
  let porcelainOutput;
  try {
    porcelainOutput = (0, import_child_process3.execSync)("git status --porcelain", { cwd: projectDir, encoding: "utf-8" });
  } catch {
    return { status: "clean", staged: [], blocked: [] };
  }
  if (!porcelainOutput.trim()) {
    return { status: "clean", staged: [], blocked: [] };
  }
  const changedFiles = porcelainOutput.split("\n").filter((line) => line.trim()).map((line) => line.slice(3));
  const staged = [];
  const blocked = [];
  for (const file of changedFiles) {
    if (!file) continue;
    if (file.endsWith(".env") || file.includes("/.env")) {
      blocked.push(`${file}:contains_credentials`);
      continue;
    }
    if (file === ".cortextos-env" || file.endsWith("/.cortextos-env")) {
      blocked.push(`${file}:runtime_env`);
      continue;
    }
    const ext = (0, import_path16.extname)(file);
    if (BINARY_TEMP_EXTENSIONS.has(ext)) {
      blocked.push(`${file}:binary_or_temp`);
      continue;
    }
    if (EXCLUDED_DIR_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      blocked.push(`${file}:excluded_directory`);
      continue;
    }
    const fullPath = (0, import_path16.join)(projectDir, file);
    if ((0, import_fs15.existsSync)(fullPath)) {
      try {
        const stat = (0, import_fs15.statSync)(fullPath);
        if (stat.isFile() && stat.size > MAX_FILE_SIZE) {
          blocked.push(`${file}:over_10MB`);
          continue;
        }
      } catch {
      }
    }
    if ((0, import_fs15.existsSync)(fullPath) && !SCRIPT_EXTENSIONS.has(ext)) {
      try {
        const stat = (0, import_fs15.statSync)(fullPath);
        if (stat.isFile() && stat.size < MAX_FILE_SIZE) {
          const content = (0, import_fs15.readFileSync)(fullPath, "utf-8");
          if (CREDENTIAL_PATTERNS.test(content)) {
            blocked.push(`${file}:credential_pattern_detected`);
            continue;
          }
        }
      } catch {
      }
    }
    staged.push(file);
  }
  if (staged.length === 0) {
    return { status: "nothing_to_stage", staged: [], blocked };
  }
  if (dryRun) {
    return { status: "dry_run", staged, blocked };
  }
  for (const file of staged) {
    try {
      (0, import_child_process3.execFileSync)("git", ["add", file], { cwd: projectDir, stdio: "pipe" });
    } catch {
    }
  }
  let diffStat;
  try {
    const stat = (0, import_child_process3.execSync)("git diff --cached --stat", { cwd: projectDir, encoding: "utf-8" });
    const lines = stat.trim().split("\n");
    diffStat = lines[lines.length - 1]?.trim() || void 0;
  } catch {
  }
  return { status: "staged", staged, blocked, diff_stat: diffStat };
}
function checkGoalStaleness(projectRoot, thresholdDays = 7) {
  const agents = [];
  const thresholdMs = thresholdDays * 86400 * 1e3;
  const now = Date.now();
  const orgsDir = (0, import_path16.join)(projectRoot, "orgs");
  if (!(0, import_fs15.existsSync)(orgsDir)) {
    return {
      summary: { total: 0, stale: 0, fresh: 0, threshold_days: thresholdDays },
      agents: []
    };
  }
  let orgNames;
  try {
    orgNames = (0, import_fs16.readdirSync)(orgsDir).filter((name) => {
      try {
        return (0, import_fs15.statSync)((0, import_path16.join)(orgsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    orgNames = [];
  }
  for (const orgName of orgNames) {
    const agentsDir = (0, import_path16.join)(orgsDir, orgName, "agents");
    if (!(0, import_fs15.existsSync)(agentsDir)) continue;
    let agentNames;
    try {
      agentNames = (0, import_fs16.readdirSync)(agentsDir).filter((name) => {
        if (!/^[a-z0-9_-]+$/.test(name)) return false;
        try {
          return (0, import_fs15.statSync)((0, import_path16.join)(agentsDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }
    for (const agentName of agentNames) {
      const goalsFile = (0, import_path16.join)(agentsDir, agentName, "GOALS.md");
      if (!(0, import_fs15.existsSync)(goalsFile)) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: "missing",
          stale: true,
          reason: "no GOALS.md file"
        });
        continue;
      }
      let content;
      try {
        content = (0, import_fs15.readFileSync)(goalsFile, "utf-8");
      } catch {
        agents.push({
          agent: agentName,
          org: orgName,
          status: "missing",
          stale: true,
          reason: "could not read GOALS.md"
        });
        continue;
      }
      const lines = content.split("\n");
      let updatedLine = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith("## Updated")) {
          for (let j = i + 1; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed && !trimmed.startsWith("##")) {
              updatedLine = trimmed;
              break;
            }
          }
          break;
        }
      }
      if (!updatedLine) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: "no_timestamp",
          stale: true,
          reason: "no Updated timestamp in GOALS.md"
        });
        continue;
      }
      const parsedDate = new Date(updatedLine);
      if (isNaN(parsedDate.getTime())) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: "parse_error",
          updated: updatedLine,
          stale: true,
          reason: "could not parse timestamp"
        });
        continue;
      }
      const ageMs = now - parsedDate.getTime();
      const ageDays = Math.floor(ageMs / 864e5);
      const isStale = ageMs > thresholdMs;
      agents.push({
        agent: agentName,
        org: orgName,
        status: isStale ? "stale" : "fresh",
        updated: updatedLine,
        age_days: ageDays,
        stale: isStale,
        reason: isStale ? `${ageDays} days since last update (threshold: ${thresholdDays})` : void 0
      });
    }
  }
  const total = agents.length;
  const staleCount = agents.filter((a) => a.stale).length;
  const freshCount = agents.filter((a) => !a.stale).length;
  return {
    summary: {
      total,
      stale: staleCount,
      fresh: freshCount,
      threshold_days: thresholdDays
    },
    agents
  };
}
async function postActivity(orgDir, ctxRoot, org, message, replyMarkup) {
  const candidates = [
    (0, import_path16.join)(orgDir, "activity-channel.env"),
    (0, import_path16.join)(ctxRoot, "orgs", org, "activity-channel.env")
  ];
  let configPath = null;
  for (const candidate of candidates) {
    if ((0, import_fs15.existsSync)(candidate)) {
      configPath = candidate;
      break;
    }
  }
  if (!configPath) {
    return false;
  }
  let botToken;
  let chatId;
  try {
    const content = (0, import_fs15.readFileSync)(configPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === "ACTIVITY_BOT_TOKEN") botToken = value;
      if (key === "ACTIVITY_CHAT_ID") chatId = value;
    }
  } catch {
    return false;
  }
  if (!botToken || !chatId) {
    return false;
  }
  try {
    const api = new TelegramAPI(botToken);
    await api.sendMessage(chatId, message, replyMarkup);
    return true;
  } catch {
    return false;
  }
}
var import_child_process3, import_fs15, import_path16, import_fs16, BINARY_TEMP_EXTENSIONS, EXCLUDED_DIR_PREFIXES, CREDENTIAL_PATTERNS, SCRIPT_EXTENSIONS, MAX_FILE_SIZE;
var init_system = __esm({
  "src/bus/system.ts"() {
    "use strict";
    init_cjs_shims();
    import_child_process3 = require("child_process");
    import_fs15 = require("fs");
    import_path16 = require("path");
    import_fs16 = require("fs");
    init_atomic();
    init_api();
    BINARY_TEMP_EXTENSIONS = /* @__PURE__ */ new Set([
      ".log",
      ".tmp",
      ".pid",
      ".pyc",
      ".pyo",
      ".class",
      ".o",
      ".so",
      ".dylib"
    ]);
    EXCLUDED_DIR_PREFIXES = [
      "telegram-images/",
      "node_modules/",
      "__pycache__/",
      ".venv/"
    ];
    CREDENTIAL_PATTERNS = /(?:token=|key=|password=|secret=|sk-|ghp_|xoxb-|AKIA)/;
    SCRIPT_EXTENSIONS = /* @__PURE__ */ new Set([".sh", ".py", ".js"]);
    MAX_FILE_SIZE = 10 * 1024 * 1024;
  }
});

// src/bus/approval.ts
var approval_exports = {};
__export(approval_exports, {
  createApproval: () => createApproval,
  listPendingApprovals: () => listPendingApprovals,
  updateApproval: () => updateApproval
});
function buildApprovalKeyboard(approvalId) {
  return {
    inline_keyboard: [[
      { text: "\u2705 Approve", callback_data: `appr_allow_${approvalId}` },
      { text: "\u274C Deny", callback_data: `appr_deny_${approvalId}` }
    ]]
  };
}
function postApprovalToActivityChannel(paths, org, approvalId, title, category, agentName, context, frameworkRoot) {
  const root = frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT;
  if (!root) {
    console.warn(
      `[approval] No frameworkRoot available for ${approvalId} \u2014 skipping activity-channel post. Set CTX_FRAMEWORK_ROOT env var or pass frameworkRoot explicitly.`
    );
    return Promise.resolve();
  }
  const orgDir = (0, import_path20.join)(root, "orgs", org);
  const lines = [
    `\u{1F514} Approval request: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`
  ];
  if (context) {
    lines.push("", context);
  }
  lines.push("", `id: ${approvalId}`);
  const message = lines.join("\n");
  return postActivity(orgDir, paths.ctxRoot, org, message, buildApprovalKeyboard(approvalId)).then((posted) => {
    if (!posted) {
      console.warn(
        `[approval] Activity-channel post failed for ${approvalId} \u2014 check ${orgDir}/activity-channel.env (must define ACTIVITY_BOT_TOKEN + ACTIVITY_CHAT_ID).`
      );
    }
  }).catch(() => void 0);
}
async function createApproval(paths, agentName, org, title, category, context, frameworkRoot) {
  validateApprovalCategory(category);
  const epoch = Math.floor(Date.now() / 1e3);
  const rand = randomString(5);
  const approvalId = `approval_${epoch}_${rand}`;
  const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const approval = {
    id: approvalId,
    title,
    requesting_agent: agentName,
    org,
    category,
    status: "pending",
    description: context || "",
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null
  };
  const pendingDir = (0, import_path20.join)(paths.approvalDir, "pending");
  ensureDir(pendingDir);
  atomicWriteSync((0, import_path20.join)(pendingDir, `${approvalId}.json`), JSON.stringify(approval));
  await postApprovalToActivityChannel(paths, org, approvalId, title, category, agentName, context, frameworkRoot);
  return approvalId;
}
function updateApproval(paths, approvalId, status, note) {
  const pendingDir = (0, import_path20.join)(paths.approvalDir, "pending");
  const filePath = (0, import_path20.join)(pendingDir, `${approvalId}.json`);
  try {
    const content = (0, import_fs20.readFileSync)(filePath, "utf-8");
    const approval = JSON.parse(content);
    approval.status = status;
    approval.updated_at = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    approval.resolved_at = approval.updated_at;
    approval.resolved_by = note || null;
    const destDir = (0, import_path20.join)(paths.approvalDir, "resolved");
    ensureDir(destDir);
    atomicWriteSync((0, import_path20.join)(destDir, `${approvalId}.json`), JSON.stringify(approval));
    const { unlinkSync: unlinkSync4 } = require("fs");
    unlinkSync4(filePath);
    if (approval.requesting_agent) {
      const noteText = note ? ` Note: ${note}` : "";
      const msg = `Approval decision: ${status.toUpperCase()}
approval_id: ${approvalId}
decision: ${status}${noteText}`;
      sendMessage(paths, "system", approval.requesting_agent, "urgent", msg);
    }
  } catch (err) {
    throw new Error(`Approval ${approvalId} not found: ${err}`);
  }
}
function listPendingApprovals(paths) {
  const pendingDir = (0, import_path20.join)(paths.approvalDir, "pending");
  let files;
  try {
    files = (0, import_fs20.readdirSync)(pendingDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const approvals = [];
  for (const file of files) {
    try {
      const content = (0, import_fs20.readFileSync)((0, import_path20.join)(pendingDir, file), "utf-8");
      approvals.push(JSON.parse(content));
    } catch {
    }
  }
  return approvals.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}
var import_fs20, import_path20;
var init_approval = __esm({
  "src/bus/approval.ts"() {
    "use strict";
    init_cjs_shims();
    import_fs20 = require("fs");
    import_path20 = require("path");
    init_atomic();
    init_random();
    init_validate();
    init_message();
    init_system();
  }
});

// src/cli/index.ts
init_cjs_shims();
var import_commander21 = require("commander");
var import_child_process12 = require("child_process");
var import_path43 = require("path");

// src/cli/init.ts
init_cjs_shims();
var import_commander = require("commander");
var import_fs2 = require("fs");
var import_path2 = require("path");
var import_os = require("os");
init_atomic();
var initCommand = new import_commander.Command("init").argument("<org-name>", "Organization name").option("--instance <id>", "Instance ID", "default").description("Create a new cortextOS organization").action(async (orgName, options) => {
  const instanceId = options.instance;
  const ctxRoot = (0, import_path2.join)((0, import_os.homedir)(), ".cortextos", instanceId);
  const projectRoot = process.cwd();
  const orgDir = (0, import_path2.join)(projectRoot, "orgs", orgName);
  if ((0, import_fs2.existsSync)(orgDir)) {
    console.log(`
  Warning: Organization "${orgName}" already exists at ${orgDir}`);
    console.log("  Existing files will NOT be overwritten. Only missing files will be created.\n");
  }
  console.log(`
Initializing cortextOS organization: ${orgName}`);
  console.log(`  Instance: ${instanceId}`);
  console.log(`  State: ${ctxRoot}`);
  console.log(`  Project: ${projectRoot}
`);
  const stateDirs = [
    (0, import_path2.join)(ctxRoot, "orgs", orgName, "tasks"),
    (0, import_path2.join)(ctxRoot, "orgs", orgName, "approvals"),
    (0, import_path2.join)(ctxRoot, "orgs", orgName, "approvals", "pending"),
    (0, import_path2.join)(ctxRoot, "orgs", orgName, "analytics"),
    (0, import_path2.join)(ctxRoot, "orgs", orgName, "analytics", "events")
  ];
  for (const dir of stateDirs) {
    ensureDir(dir);
  }
  console.log("  Created state directories");
  const agentsDir = (0, import_path2.join)(orgDir, "agents");
  ensureDir(agentsDir);
  const orgTemplateDir = findOrgTemplateDir(projectRoot);
  if (orgTemplateDir) {
    copyOrgTemplateFiles(orgTemplateDir, orgDir, orgName);
    console.log("  Copied org template files");
  }
  const contextPath = (0, import_path2.join)(orgDir, "context.json");
  if (!(0, import_fs2.existsSync)(contextPath)) {
    (0, import_fs2.writeFileSync)(contextPath, JSON.stringify({
      name: orgName,
      description: "",
      industry: "",
      icp: "",
      value_prop: "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      orchestrator: "",
      day_mode_start: "08:00",
      day_mode_end: "00:00",
      default_approval_categories: ["external-comms", "financial", "deployment", "data-deletion"],
      communication_style: "direct and casual"
    }, null, 2) + "\n", "utf-8");
    console.log("  Created org context.json");
  } else {
    try {
      const ctx = JSON.parse((0, import_fs2.readFileSync)(contextPath, "utf-8"));
      if (!ctx.timezone) ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!ctx.name) ctx.name = orgName;
      if (!ctx.day_mode_start) ctx.day_mode_start = "08:00";
      if (!ctx.day_mode_end) ctx.day_mode_end = "00:00";
      if (!ctx.default_approval_categories) ctx.default_approval_categories = ["external-comms", "financial", "deployment", "data-deletion"];
      if (!ctx.communication_style) ctx.communication_style = "direct and casual";
      (0, import_fs2.writeFileSync)(contextPath, JSON.stringify(ctx, null, 2) + "\n", "utf-8");
    } catch {
    }
  }
  const goalsPath = (0, import_path2.join)(orgDir, "goals.json");
  if (!(0, import_fs2.existsSync)(goalsPath)) {
    (0, import_fs2.writeFileSync)(goalsPath, JSON.stringify({
      north_star: "",
      daily_focus: "",
      daily_focus_set_at: "",
      goals: [],
      bottleneck: "",
      updated_at: ""
    }, null, 2) + "\n", "utf-8");
  }
  const secretsPath = (0, import_path2.join)(orgDir, "secrets.env");
  if (!(0, import_fs2.existsSync)(secretsPath)) {
    (0, import_fs2.writeFileSync)(secretsPath, [
      "# cortextOS secrets for " + orgName,
      "# Add your Telegram bot token and other secrets here",
      "BOT_TOKEN=",
      "CHAT_ID=",
      "ACTIVITY_CHAT_ID=",
      "",
      "# Knowledge Base (RAG) \u2014 enables semantic search across agent memory and documents",
      "# Get your API key from https://aistudio.google.com/app/apikey (free tier available)",
      "GEMINI_API_KEY=",
      ""
    ].join("\n"), "utf-8");
    (0, import_fs2.chmodSync)(secretsPath, 384);
    console.log("  Created secrets.env");
  }
  const envPath = (0, import_path2.join)(projectRoot, ".env");
  if (!(0, import_fs2.existsSync)(envPath)) {
    (0, import_fs2.writeFileSync)(envPath, `CTX_INSTANCE_ID=${instanceId}
`, "utf-8");
    console.log("  Created .env");
  }
  const knowledgePath = (0, import_path2.join)(orgDir, "knowledge.md");
  if (!(0, import_fs2.existsSync)(knowledgePath)) {
    (0, import_fs2.writeFileSync)(knowledgePath, `# ${orgName} - Shared Knowledge

Shared facts, metrics, and corrections for all agents.
`, "utf-8");
  }
  if ((0, import_fs2.existsSync)(agentsDir)) {
    let ctx = null;
    try {
      const contextPath2 = (0, import_path2.join)(orgDir, "context.json");
      ctx = JSON.parse((0, import_fs2.readFileSync)(contextPath2, "utf-8"));
    } catch {
    }
    if (ctx) {
      let regenerated = 0;
      for (const entry of (0, import_fs2.readdirSync)(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const agentDir = (0, import_path2.join)(agentsDir, entry.name);
        const systemMdPath = (0, import_path2.join)(agentDir, "SYSTEM.md");
        if (!(0, import_fs2.existsSync)(systemMdPath)) continue;
        try {
          const systemMd = [
            "# System Context",
            "",
            `**Organization:** ${ctx.name || orgName}`,
            `**Description:** ${ctx.description || "(not set)"}`,
            `**Timezone:** ${ctx.timezone || "UTC"}`,
            `**Orchestrator:** ${ctx.orchestrator || "(not set)"}`,
            `**Dashboard:** ${ctx.dashboard_url || "(not configured)"}`,
            `**Communication Style:** ${ctx.communication_style || "casual"}`,
            `**Day Mode:** ${ctx.day_mode_start || "08:00"} - ${ctx.day_mode_end || "00:00"}`,
            "**Framework:** cortextOS Node.js",
            "",
            "---",
            "",
            "## Team Roster",
            "",
            "> This section is populated during onboarding. For the live roster:",
            "```bash",
            "cortextos list-agents",
            "```",
            "",
            "## Agent Health",
            "",
            "```bash",
            "cortextos bus read-all-heartbeats",
            "```",
            "",
            "## Communication",
            "",
            '- Agent-to-agent: `cortextos bus send-message <agent> <priority> "<text>"`',
            '- Telegram to user: `cortextos bus send-telegram <chat_id> "<text>"`',
            "- Check inbox: `cortextos bus check-inbox`",
            ""
          ].join("\n");
          (0, import_fs2.writeFileSync)(systemMdPath, systemMd, "utf-8");
          regenerated++;
        } catch {
        }
      }
      if (regenerated > 0) {
        console.log(`  Regenerated SYSTEM.md for ${regenerated} agent(s)`);
      }
    }
  }
  console.log(`
  Organization "${orgName}" initialized.`);
  console.log(`
  Next steps:`);
  console.log(`    1. Add your Telegram bot token to orgs/${orgName}/secrets.env`);
  console.log(`    2. Add an agent: cortextos add-agent <name> --template orchestrator`);
  console.log(`    3. Start: cortextos start
`);
});
function findOrgTemplateDir(projectRoot) {
  const candidates = [
    (0, import_path2.join)(projectRoot, "templates", "org"),
    (0, import_path2.join)(projectRoot, "node_modules", "cortextos", "templates", "org"),
    (0, import_path2.join)(__dirname, "..", "..", "templates", "org")
  ];
  for (const dir of candidates) {
    if ((0, import_fs2.existsSync)(dir)) return dir;
  }
  return null;
}
function copyOrgTemplateFiles(templateDir, orgDir, orgName) {
  try {
    const files = (0, import_fs2.readdirSync)(templateDir);
    for (const file of files) {
      const srcPath = (0, import_path2.join)(templateDir, file);
      const destPath = (0, import_path2.join)(orgDir, file);
      if ((0, import_fs2.existsSync)(destPath)) continue;
      try {
        const stat = require("fs").statSync(srcPath);
        if (stat.isFile()) {
          let content = (0, import_fs2.readFileSync)(srcPath, "utf-8");
          content = content.replace(/\{\{org_name\}\}/g, orgName);
          (0, import_fs2.writeFileSync)(destPath, content, "utf-8");
        }
      } catch {
      }
    }
  } catch {
  }
}

// src/cli/add-agent.ts
init_cjs_shims();
var import_commander2 = require("commander");
var import_fs3 = require("fs");
var import_path3 = require("path");
var import_os2 = require("os");
init_validate();
var addAgentCommand = new import_commander2.Command("add-agent").argument("<name>", "Agent name").option("--template <type>", "Agent template (orchestrator, analyst, agent)", "agent").option("--org <org>", "Organization name").option("--instance <id>", "Instance ID", "default").description("Add a new agent to the organization").action(async (name, options) => {
  try {
    validateAgentName(name);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error(`Agent names must match /^[a-z0-9_-]+$/ (lowercase letters, numbers, underscores, hyphens).`);
    console.error(`Examples of valid names: paul, sentinel, cortext-designer, m2c1-worker, agent_1`);
    process.exit(1);
  }
  const projectRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
  let org = options.org;
  if (!org) {
    const orgsDir = (0, import_path3.join)(projectRoot, "orgs");
    if ((0, import_fs3.existsSync)(orgsDir)) {
      const orgs = (0, import_fs3.readdirSync)(orgsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      if (orgs.length === 1) {
        org = orgs[0];
      } else if (orgs.length > 1) {
        console.error("Multiple organizations found. Specify one with --org <name>");
        process.exit(1);
      }
    }
  }
  if (!org) {
    console.error('No organization found. Run "cortextos init <org>" first.');
    process.exit(1);
  }
  const agentDir = (0, import_path3.join)(projectRoot, "orgs", org, "agents", name);
  if ((0, import_fs3.existsSync)(agentDir)) {
    console.error(`Agent "${name}" already exists at ${agentDir}`);
    process.exit(1);
  }
  console.log(`
Adding agent: ${name}`);
  console.log(`  Template: ${options.template}`);
  console.log(`  Organization: ${org}`);
  console.log(`  Directory: ${agentDir}
`);
  (0, import_fs3.mkdirSync)(agentDir, { recursive: true });
  (0, import_fs3.mkdirSync)((0, import_path3.join)(agentDir, "memory"), { recursive: true });
  (0, import_fs3.mkdirSync)((0, import_path3.join)(agentDir, ".claude", "skills"), { recursive: true });
  const templateDir = findTemplateDir(projectRoot, options.template);
  if (templateDir) {
    copyTemplateFiles(templateDir, agentDir, name, org);
    console.log(`  Copied template files from ${options.template}`);
  } else {
    createMinimalAgent(agentDir, name, org, options.template);
    console.log("  Created minimal agent files");
  }
  const goalsJsonPath = (0, import_path3.join)(agentDir, "goals.json");
  if (!(0, import_fs3.existsSync)(goalsJsonPath)) {
    (0, import_fs3.writeFileSync)(goalsJsonPath, JSON.stringify({
      focus: "",
      goals: [],
      bottleneck: "",
      updated_at: "",
      updated_by: ""
    }, null, 2) + "\n", "utf-8");
  }
  const configPath = (0, import_path3.join)(agentDir, "config.json");
  if (!(0, import_fs3.existsSync)(configPath)) {
    (0, import_fs3.writeFileSync)(configPath, JSON.stringify({
      agent_name: name,
      startup_delay: 0,
      max_session_seconds: 255600,
      enabled: true,
      crons: []
    }, null, 2) + "\n", "utf-8");
  }
  const envPath = (0, import_path3.join)(agentDir, ".env");
  if (!(0, import_fs3.existsSync)(envPath)) {
    (0, import_fs3.writeFileSync)(envPath, [
      `# Agent environment for ${name}`,
      "#",
      "# BOT_TOKEN: Create a Telegram bot with @BotFather and paste the token here",
      "# CHAT_ID: Send a message to your bot, then run:",
      `#   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | jq '.result[-1].message.chat.id'`,
      "#",
      "BOT_TOKEN=",
      "CHAT_ID=",
      "",
      "# Claude Code v2.1.111+ gives Sonnet 4.6 a 1M context window by default.",
      '# Without "extra usage" billing enabled, compaction fails at 100% ctx.',
      "# Keep this for Sonnet and Haiku agents. Remove it for Opus agents on Max/Team/Enterprise",
      "# (Opus 1M context is included in those plans and does not need the billing gate).",
      "CLAUDE_CODE_DISABLE_1M_CONTEXT=true",
      ""
    ].join("\n"), "utf-8");
    (0, import_fs3.chmodSync)(envPath, 384);
  }
  const contextPath = (0, import_path3.join)(projectRoot, "orgs", org, "context.json");
  if ((0, import_fs3.existsSync)(contextPath)) {
    let ctx = null;
    try {
      ctx = JSON.parse((0, import_fs3.readFileSync)(contextPath, "utf-8"));
    } catch {
    }
    if (ctx) {
      try {
        const orgName = ctx.name || org;
        const timezone = ctx.timezone || "UTC";
        const orchestrator = ctx.orchestrator || "(not set)";
        const dashboardUrl = ctx.dashboard_url || "(not configured)";
        const systemMd = [
          "# System Context",
          "",
          `**Organization:** ${orgName}`,
          `**Description:** ${ctx.description || "(not set)"}`,
          `**Timezone:** ${timezone}`,
          `**Orchestrator:** ${orchestrator}`,
          `**Dashboard:** ${dashboardUrl}`,
          `**Communication Style:** ${ctx.communication_style || "casual"}`,
          `**Day Mode:** ${ctx.day_mode_start || "08:00"} - ${ctx.day_mode_end || "00:00"}`,
          "**Framework:** cortextOS Node.js",
          "",
          "---",
          "",
          "## Team Roster",
          "",
          "> This section is populated during onboarding. For the live roster:",
          "```bash",
          "cortextos list-agents",
          "```",
          "",
          "## Agent Health",
          "",
          "```bash",
          "cortextos bus read-all-heartbeats",
          "```",
          "",
          "## Communication",
          "",
          '- Agent-to-agent: `cortextos bus send-message <agent> <priority> "<text>"`',
          '- Telegram to user: `cortextos bus send-telegram <chat_id> "<text>"`',
          "- Check inbox: `cortextos bus check-inbox`",
          ""
        ].join("\n");
        (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "SYSTEM.md"), systemMd, "utf-8");
      } catch {
      }
      try {
        const agentConfigPath = (0, import_path3.join)(agentDir, "config.json");
        if ((0, import_fs3.existsSync)(agentConfigPath)) {
          const agentCfg = JSON.parse((0, import_fs3.readFileSync)(agentConfigPath, "utf-8"));
          agentCfg.timezone = ctx.timezone || "UTC";
          const timeRegex = /^\d{2}:\d{2}$/;
          agentCfg.day_mode_start = typeof ctx.day_mode_start === "string" && timeRegex.test(ctx.day_mode_start) ? ctx.day_mode_start : "08:00";
          agentCfg.day_mode_end = typeof ctx.day_mode_end === "string" && timeRegex.test(ctx.day_mode_end) ? ctx.day_mode_end : "00:00";
          agentCfg.communication_style = ctx.communication_style || "direct and casual";
          agentCfg.approval_rules = {
            always_ask: Array.isArray(ctx.default_approval_categories) ? ctx.default_approval_categories : ["external-comms", "financial", "deployment", "data-deletion"],
            never_ask: []
          };
          (0, import_fs3.writeFileSync)(agentConfigPath, JSON.stringify(agentCfg, null, 2) + "\n", "utf-8");
        }
      } catch {
      }
    }
  }
  if (options.template === "orchestrator") {
    const contextPath2 = (0, import_path3.join)(projectRoot, "orgs", org, "context.json");
    if ((0, import_fs3.existsSync)(contextPath2)) {
      try {
        const context = JSON.parse((0, import_fs3.readFileSync)(contextPath2, "utf-8"));
        if (!context.orchestrator) {
          context.orchestrator = name;
          (0, import_fs3.writeFileSync)(contextPath2, JSON.stringify(context, null, 2) + "\n", "utf-8");
        }
      } catch {
      }
    }
  }
  const instanceId = options.instance;
  const ctxRoot = (0, import_path3.join)((0, import_os2.homedir)(), ".cortextos", instanceId);
  const enabledPath = (0, import_path3.join)(ctxRoot, "config", "enabled-agents.json");
  const configDir = (0, import_path3.join)(ctxRoot, "config");
  (0, import_fs3.mkdirSync)(configDir, { recursive: true });
  let enabledAgents = {};
  try {
    if ((0, import_fs3.existsSync)(enabledPath)) {
      enabledAgents = JSON.parse((0, import_fs3.readFileSync)(enabledPath, "utf-8"));
    }
  } catch {
  }
  if (!enabledAgents[name]) {
    enabledAgents[name] = {
      enabled: true,
      status: "configured",
      ...org ? { org } : {}
    };
    (0, import_fs3.writeFileSync)(enabledPath, JSON.stringify(enabledAgents, null, 2) + "\n", "utf-8");
    console.log(`  Registered in enabled-agents.json`);
  }
  console.log(`
  Agent "${name}" created.`);
  console.log(`
  Next steps:`);
  console.log(`    1. Edit ${(0, import_path3.join)("orgs", org, "agents", name, ".env")} with your Telegram settings`);
  console.log(`    2. Customize identity files (IDENTITY.md, SOUL.md, GOALS.md)`);
  console.log(`    3. Start: cortextos start ${name}
`);
});
function findTemplateDir(projectRoot, template) {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || projectRoot;
  const candidates = [
    (0, import_path3.join)(projectRoot, "templates", template),
    (0, import_path3.join)(frameworkRoot, "templates", template),
    (0, import_path3.join)(projectRoot, "node_modules", "cortextos", "templates", template),
    // Relative to this file for development
    (0, import_path3.join)(__dirname, "..", "..", "templates", template)
  ];
  for (const dir of candidates) {
    if ((0, import_fs3.existsSync)(dir)) return dir;
  }
  return null;
}
function copyTemplateFiles(templateDir, agentDir, name, org) {
  const files = (0, import_fs3.readdirSync)(templateDir);
  for (const file of files) {
    const srcPath = (0, import_path3.join)(templateDir, file);
    const destPath = (0, import_path3.join)(agentDir, file);
    try {
      const stat = require("fs").statSync(srcPath);
      if (stat.isFile()) {
        let content = (0, import_fs3.readFileSync)(srcPath, "utf-8");
        content = content.replace(/\{\{agent_name\}\}/g, name);
        content = content.replace(/\{\{org\}\}/g, org);
        content = content.replace(/\{\{current_timestamp\}\}/g, (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"));
        (0, import_fs3.writeFileSync)(destPath, content, "utf-8");
      } else if (stat.isDirectory() && file !== "node_modules") {
        (0, import_fs3.mkdirSync)(destPath, { recursive: true });
        copyTemplateFiles(srcPath, destPath, name, org);
      }
    } catch {
    }
  }
}
function createMinimalAgent(agentDir, name, org, template) {
  const role = template === "orchestrator" ? "Orchestrator" : template === "analyst" ? "Analyst" : "Agent";
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "IDENTITY.md"), `# ${name}

You are ${name}, a ${role} for ${org}.
`);
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "SOUL.md"), `# Soul

You are helpful, precise, and proactive.
`);
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "GOALS.md"), `# Goals

- Awaiting goal configuration
`);
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "HEARTBEAT.md"), `# Heartbeat Checklist

- [ ] Check inbox
- [ ] Update heartbeat
`);
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "MEMORY.md"), `# Long-Term Memory

Nothing recorded yet.
`);
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "USER.md"), `# User Profile

Not configured yet.
`);
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "SYSTEM.md"), `# System Context

Organization: ${org}
`);
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "TOOLS.md"), `# Available Tools

Use \`cortextos bus <command>\` for bus operations.
`);
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "CLAUDE.md"), "@AGENTS.md\n");
  (0, import_fs3.writeFileSync)((0, import_path3.join)(agentDir, "AGENTS.md"), createAgentsMd(name, org, template));
}
function createAgentsMd(name, org, template) {
  return `# cortextOS ${template.charAt(0).toUpperCase() + template.slice(1)}

## BOOTSTRAP PROTOCOL - READ EVERY FILE BEFORE DOING ANYTHING

Read these files at the start of EVERY session:
1. IDENTITY.md
2. SOUL.md
3. GOALS.md
4. HEARTBEAT.md
5. MEMORY.md
6. memory/$(date -u +%Y-%m-%d).md (today's session state)
7. TOOLS.md
8. SYSTEM.md
9. config.json
10. USER.md

## Bus Commands

Send messages: \`cortextos bus send-message <agent> <priority> "<text>"\`
Check inbox: \`cortextos bus check-inbox\`
ACK messages: \`cortextos bus ack-inbox <id>\`
Create tasks: \`cortextos bus create-task "<title>" --assignee <agent> --priority <p>\`
Update tasks: \`cortextos bus update-task <id> <status>\`
Complete tasks: \`cortextos bus complete-task <id> --result "<text>"\`
Log events: \`cortextos bus log-event <category> <event> <severity>\`
Update heartbeat: \`cortextos bus update-heartbeat "<status>"\`
Send Telegram: \`cortextos bus send-telegram <chat_id> "<text>"\`
`;
}

// src/cli/start.ts
init_cjs_shims();
var import_commander3 = require("commander");
var import_fs4 = require("fs");
var import_path5 = require("path");
var import_os4 = require("os");
var import_child_process = require("child_process");

// src/daemon/ipc-server.ts
init_cjs_shims();

// src/utils/paths.ts
init_cjs_shims();
var import_os3 = require("os");
var import_path4 = require("path");
init_validate();
function resolvePaths(agentName, instanceId = "default", org) {
  validateInstanceId(instanceId);
  const ctxRoot = (0, import_path4.join)((0, import_os3.homedir)(), ".cortextos", instanceId);
  const orgBase = org ? (0, import_path4.join)(ctxRoot, "orgs", org) : ctxRoot;
  return {
    ctxRoot,
    inbox: (0, import_path4.join)(ctxRoot, "inbox", agentName),
    inflight: (0, import_path4.join)(ctxRoot, "inflight", agentName),
    processed: (0, import_path4.join)(ctxRoot, "processed", agentName),
    logDir: (0, import_path4.join)(ctxRoot, "logs", agentName),
    stateDir: (0, import_path4.join)(ctxRoot, "state", agentName),
    taskDir: (0, import_path4.join)(orgBase, "tasks"),
    approvalDir: (0, import_path4.join)(orgBase, "approvals"),
    analyticsDir: (0, import_path4.join)(orgBase, "analytics"),
    deliverablesDir: (0, import_path4.join)(orgBase, "deliverables")
  };
}
function getIpcPath(instanceId = "default") {
  validateInstanceId(instanceId);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return (0, import_path4.join)((0, import_os3.homedir)(), ".cortextos", instanceId, "daemon.sock");
}

// src/daemon/ipc-server.ts
var IPCClient = class {
  socketPath;
  constructor(instanceId = "default") {
    this.socketPath = getIpcPath(instanceId);
  }
  /**
   * Send a command to the daemon and get the response.
   */
  async send(request) {
    const { createConnection } = require("net");
    return new Promise((resolve4, reject) => {
      const socket = createConnection(this.socketPath, () => {
        socket.write(JSON.stringify(request));
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => {
        try {
          resolve4(JSON.parse(data));
        } catch {
          reject(new Error("Invalid response from daemon"));
        }
      });
      socket.on("error", (err) => {
        if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
          resolve4({
            success: false,
            error: "Daemon is not running. Start it with: cortextos start"
          });
        } else {
          reject(err);
        }
      });
      socket.setTimeout(5e3, () => {
        socket.destroy();
        reject(new Error("IPC request timed out"));
      });
    });
  }
  /**
   * Check if the daemon is running.
   */
  async isDaemonRunning() {
    try {
      const response = await this.send({ type: "status" });
      return response.success;
    } catch {
      return false;
    }
  }
};

// src/cli/start.ts
var IS_WINDOWS = (0, import_os4.platform)() === "win32";
var SAFE_CMD = /^[@a-z0-9._/-]+$/i;
function commandExists(cmd) {
  if (!SAFE_CMD.test(cmd)) return false;
  const which = IS_WINDOWS ? "where" : "which";
  const result = (0, import_child_process.spawnSync)(which, [cmd], { stdio: "pipe" });
  return result.status === 0;
}
var startCommand = new import_commander3.Command("start").argument("[agent]", "Specific agent to start (starts all if omitted)").option("--instance <id>", "Instance ID", "default").option("--foreground", "Run daemon in foreground (no PM2, for debugging)").description("Start the cortextOS daemon and agents").action(async (agent, options) => {
  const ipc = new IPCClient(options.instance);
  const daemonRunning = await ipc.isDaemonRunning();
  if (!daemonRunning) {
    const projectRoot = process.cwd();
    const daemonScript = (0, import_path5.join)(projectRoot, "dist", "daemon.js");
    if (!(0, import_fs4.existsSync)(daemonScript)) {
      console.error("Daemon not built. Run: npm run build");
      process.exit(1);
    }
    const ctxRoot = (0, import_path5.join)((0, import_os4.homedir)(), ".cortextos", options.instance);
    let org = "";
    const enabledPath = (0, import_path5.join)(ctxRoot, "config", "enabled-agents.json");
    if ((0, import_fs4.existsSync)(enabledPath)) {
      try {
        const agents = JSON.parse((0, import_fs4.readFileSync)(enabledPath, "utf-8"));
        const first = Object.values(agents)[0];
        if (first?.org) org = first.org;
      } catch {
      }
    }
    const daemonEnv = {
      ...process.env,
      CTX_INSTANCE_ID: options.instance,
      CTX_ROOT: ctxRoot,
      CTX_FRAMEWORK_ROOT: projectRoot,
      CTX_PROJECT_ROOT: projectRoot,
      ...org ? { CTX_ORG: org } : {}
    };
    if (options.foreground) {
      console.log("Starting cortextOS daemon in foreground...");
      console.log("(Press Ctrl+C to stop)\n");
      const child = (0, import_child_process.spawn)(process.execPath, [daemonScript, "--instance", options.instance], {
        stdio: "inherit",
        env: daemonEnv
      });
      child.on("exit", (code) => process.exit(code || 0));
      process.on("SIGINT", () => child.kill("SIGTERM"));
      process.on("SIGTERM", () => child.kill("SIGTERM"));
      process.on("exit", () => {
        try {
          child.kill();
        } catch {
        }
      });
      return;
    }
    if (commandExists("pm2")) {
      const ecosystemPath = (0, import_path5.join)(projectRoot, "ecosystem.config.js");
      if ((0, import_fs4.existsSync)(ecosystemPath)) {
        console.log("Starting cortextOS daemon via PM2...");
        try {
          (0, import_child_process.execSync)("pm2 start ecosystem.config.js", { stdio: "inherit", cwd: projectRoot });
          (0, import_child_process.execSync)("pm2 save", { stdio: "inherit", cwd: projectRoot });
          console.log("\nDaemon started. Use `cortextos status` to check agents.");
          if (IS_WINDOWS) {
            console.log("\nFor auto-start on Windows boot:");
            console.log("  npm install -g pm2-windows-startup");
            console.log("  pm2-windows-startup install");
          }
        } catch {
          console.error("PM2 start failed. Try: pm2 start ecosystem.config.js");
        }
      } else {
        console.log("Generating ecosystem.config.js and starting...");
        try {
          (0, import_child_process.execSync)(`node ${JSON.stringify((0, import_path5.join)(projectRoot, "dist", "cli.js"))} ecosystem`, {
            stdio: "inherit",
            cwd: projectRoot,
            env: daemonEnv
          });
          (0, import_child_process.execSync)("pm2 start ecosystem.config.js", { stdio: "inherit", cwd: projectRoot });
          (0, import_child_process.execSync)("pm2 save", { stdio: "inherit", cwd: projectRoot });
          console.log("\nDaemon started. Use `cortextos status` to check agents.");
          if (IS_WINDOWS) {
            console.log("\nFor auto-start on Windows boot:");
            console.log("  npm install -g pm2-windows-startup");
            console.log("  pm2-windows-startup install");
          }
        } catch {
          console.error("Failed to generate ecosystem and start. Try manually:");
          console.error("  cortextos ecosystem && pm2 start ecosystem.config.js");
        }
      }
    } else {
      console.log("PM2 not found. Starting daemon directly (background)...");
      console.log("(Install PM2 for persistence across reboots: npm install -g pm2)\n");
      const logDir = (0, import_path5.join)(ctxRoot, "logs");
      const logFile = (0, import_path5.join)(logDir, "daemon.log");
      const child = (0, import_child_process.spawn)(process.execPath, [daemonScript, "--instance", options.instance], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: daemonEnv,
        cwd: projectRoot,
        windowsHide: true
      });
      child.unref();
      await new Promise((r) => setTimeout(r, 1500));
      const ipc2 = new IPCClient(options.instance);
      const running = await ipc2.isDaemonRunning();
      if (running) {
        console.log("Daemon started successfully (background process).");
        console.log("Note: daemon will stop if you close this terminal session.");
        console.log("Install PM2 for persistence: npm install -g pm2");
      } else {
        console.log("Daemon spawned. Check logs if agents do not appear:");
        console.log(`  ${logFile}`);
      }
    }
    return;
  }
  if (agent) {
    const ctxRoot = (0, import_path5.join)((0, import_os4.homedir)(), ".cortextos", options.instance);
    const enabledPath = (0, import_path5.join)(ctxRoot, "config", "enabled-agents.json");
    let enabledAgents = {};
    try {
      if ((0, import_fs4.existsSync)(enabledPath)) {
        enabledAgents = JSON.parse((0, import_fs4.readFileSync)(enabledPath, "utf-8"));
      }
    } catch {
    }
    if (!enabledAgents[agent]) {
      const existingOrg = Object.values(enabledAgents).find((e) => e.org)?.org;
      enabledAgents[agent] = {
        enabled: true,
        status: "configured",
        ...existingOrg ? { org: existingOrg } : {}
      };
      (0, import_fs4.mkdirSync)((0, import_path5.join)(ctxRoot, "config"), { recursive: true });
      (0, import_fs4.writeFileSync)(enabledPath, JSON.stringify(enabledAgents, null, 2) + "\n", "utf-8");
      console.log(`  Registered ${agent} in enabled-agents.json`);
    }
    console.log(`Starting agent: ${agent}`);
    const response = await ipc.send({ type: "start-agent", agent, source: "cortextos start" });
    if (response.success) {
      console.log(`  ${response.data}`);
    } else {
      console.error(`  Error: ${response.error}`);
    }
  } else {
    const response = await ipc.send({ type: "status", source: "cortextos start" });
    if (response.success) {
      const statuses = response.data;
      if (statuses.length === 0) {
        console.log("No agents configured. Add one with: cortextos add-agent <name>");
      } else {
        console.log("Agent statuses:");
        for (const s of statuses) {
          console.log(`  ${s.name}: ${s.status} (pid: ${s.pid || "-"})`);
        }
      }
    }
  }
});

// src/cli/stop.ts
init_cjs_shims();
var import_commander4 = require("commander");
var import_fs5 = require("fs");
var import_path6 = require("path");
var import_os5 = require("os");
function writeStopMarker(instanceId, agent, reason) {
  try {
    const ctxRoot = (0, import_path6.join)((0, import_os5.homedir)(), ".cortextos", instanceId);
    const stateDir = (0, import_path6.join)(ctxRoot, "state", agent);
    (0, import_fs5.mkdirSync)(stateDir, { recursive: true });
    (0, import_fs5.writeFileSync)((0, import_path6.join)(stateDir, ".user-stop"), reason);
  } catch {
  }
}
var stopCommand = new import_commander4.Command("stop").argument("[agent]", "Agent name to stop. Omit and pass --all to stop every running agent.").option("--instance <id>", "Instance ID", "default").option("--all", "Stop every running agent (required when no agent name is given)").description("Stop a running agent. Use --all to stop every agent. Does NOT stop the daemon process itself \u2014 use `pm2 stop cortextos-daemon` for that.").action(async (agent, options) => {
  if (!agent && !options.all) {
    console.error("Refusing to stop all agents without an explicit target.");
    console.error("");
    console.error("  To stop one agent:    cortextos stop <agent>");
    console.error("  To stop every agent:  cortextos stop --all");
    console.error("  To stop the daemon:   pm2 stop cortextos-daemon");
    console.error("");
    console.error("(Previously `cortextos stop` with no argument silently stopped every running agent. That behavior was a foot-gun and now requires --all.)");
    process.exit(2);
  }
  if (agent && options.all) {
    console.error("Error: pass either an agent name or --all, not both.");
    process.exit(2);
  }
  const ipc = new IPCClient(options.instance);
  const daemonRunning = await ipc.isDaemonRunning();
  if (!daemonRunning) {
    console.log("Daemon is not running.");
    return;
  }
  if (agent) {
    console.log(`Stopping agent: ${agent}`);
    writeStopMarker(options.instance, agent, "stopped via cortextos stop");
    const response = await ipc.send({ type: "stop-agent", agent, source: "cortextos stop" });
    if (response.success) {
      console.log(`  ${response.data}`);
    } else {
      console.error(`  Error: ${response.error}`);
      process.exit(1);
    }
    return;
  }
  console.log("Stopping all agents...");
  const listResponse = await ipc.send({ type: "list-agents", source: "cortextos stop --all" });
  if (!listResponse.success) {
    console.error(`  Error listing agents: ${listResponse.error}`);
    process.exit(1);
  }
  const agents = listResponse.data;
  if (agents.length === 0) {
    console.log("  No agents are running.");
    return;
  }
  for (const a of agents) {
    writeStopMarker(options.instance, a, "stopped via cortextos stop --all");
    const response = await ipc.send({ type: "stop-agent", agent: a, source: "cortextos stop --all" });
    console.log(`  ${a}: ${response.success ? "stopped" : response.error}`);
  }
  console.log("\nAll agents stopped. The daemon is still running. To stop it: pm2 stop cortextos-daemon");
});

// src/cli/status.ts
init_cjs_shims();
var import_commander5 = require("commander");
var import_fs6 = require("fs");
var import_path7 = require("path");
var import_os6 = require("os");
var statusCommand = new import_commander5.Command("status").option("--instance <id>", "Instance ID").description("Show agent health and status").action(async (options) => {
  const instanceId = options.instance || process.env.CTX_INSTANCE_ID || "default";
  const ipc = new IPCClient(instanceId);
  const daemonRunning = await ipc.isDaemonRunning();
  if (daemonRunning) {
    const response = await ipc.send({ type: "status", source: "cortextos status" });
    if (response.success) {
      const statuses = response.data;
      displayStatuses(statuses);
    }
  } else {
    console.log("Daemon is not running. Showing last known heartbeats:\n");
    const ctxRoot = (0, import_path7.join)((0, import_os6.homedir)(), ".cortextos", instanceId);
    const stateDir = (0, import_path7.join)(ctxRoot, "state");
    if (!(0, import_fs6.existsSync)(stateDir)) {
      console.log("  No heartbeat data found.");
      console.log("  Start with: cortextos start");
      return;
    }
    const agentDirs = (0, import_fs6.readdirSync)(stateDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    if (agentDirs.length === 0) {
      console.log("  No agents have reported heartbeats.");
      return;
    }
    const rows = [];
    for (const agent of agentDirs) {
      const hbPath = (0, import_path7.join)(stateDir, agent, "heartbeat.json");
      try {
        const hb = JSON.parse((0, import_fs6.readFileSync)(hbPath, "utf-8"));
        const ts = hb.last_heartbeat || hb.timestamp || (/* @__PURE__ */ new Date()).toISOString();
        const age = Math.floor((Date.now() - new Date(ts).getTime()) / 1e3);
        const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
        rows.push({
          agent: hb.agent || agent,
          status: hb.status || "unknown",
          age: ageStr,
          task: hb.current_task ? hb.current_task.substring(0, 30) : "-"
        });
      } catch {
      }
    }
    if (rows.length === 0) {
      console.log("  No agents have reported heartbeats.");
    } else {
      console.log("\n  Last Known Heartbeats\n");
      const header = "  Name              Status      Last Seen    Current Task";
      const separator = "  " + "-".repeat(header.length - 2);
      console.log(header);
      console.log(separator);
      for (const r of rows) {
        const name = r.agent.padEnd(18);
        const status = r.status.padEnd(12);
        const age = r.age.padEnd(13);
        console.log(`  ${name}${status}${age}${r.task}`);
      }
      console.log("");
    }
  }
});
function displayStatuses(statuses) {
  if (statuses.length === 0) {
    console.log("No agents running.");
    console.log("Add one with: cortextos add-agent <name>");
    return;
  }
  console.log("\n  Agent Status\n");
  const header = "  Name              Status      PID       Uptime      Model";
  const separator = "  " + "-".repeat(header.length - 2);
  console.log(header);
  console.log(separator);
  for (const s of statuses) {
    const name = s.name.padEnd(18);
    const status = s.status.padEnd(12);
    const pid = (s.pid?.toString() || "-").padEnd(10);
    const uptime = s.uptime ? formatUptime(s.uptime).padEnd(12) : "-".padEnd(12);
    const model = s.model || "-";
    console.log(`  ${name}${status}${pid}${uptime}${model}`);
  }
  console.log("");
}
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

// src/cli/doctor.ts
init_cjs_shims();
var import_commander6 = require("commander");
var import_child_process2 = require("child_process");
var import_fs7 = require("fs");
var import_path8 = require("path");
var import_os7 = require("os");
var doctorCommand = new import_commander6.Command("doctor").option("--instance <id>", "Instance ID", "default").description("Diagnose common issues").action(async (options) => {
  console.log("\ncortextOS Doctor\n");
  const checks = [];
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  checks.push({
    name: "Node.js version",
    status: major >= 20 ? "pass" : "fail",
    message: `${nodeVersion} ${major >= 20 ? "(OK)" : "(requires 20+)"}`,
    fix: major < 20 ? "Install Node.js 20+ from https://nodejs.org" : void 0
  });
  try {
    const pm2Version = (0, import_child_process2.execSync)("pm2 --version", { encoding: "utf-8" }).trim();
    checks.push({
      name: "PM2",
      status: "pass",
      message: `v${pm2Version}`
    });
  } catch {
    checks.push({
      name: "PM2",
      status: "warn",
      message: "Not installed",
      fix: "Install with: npm install -g pm2"
    });
  }
  try {
    const claudeVersion = (0, import_child_process2.execSync)("claude --version", { encoding: "utf-8", timeout: 5e3 }).trim();
    checks.push({
      name: "Claude Code CLI",
      status: "pass",
      message: claudeVersion
    });
  } catch {
    checks.push({
      name: "Claude Code CLI",
      status: "fail",
      message: "Not found",
      fix: "Install Claude Code: npm install -g @anthropic-ai/claude-code"
    });
  }
  try {
    require("node-pty");
    checks.push({
      name: "node-pty",
      status: "pass",
      message: "Native module loaded"
    });
  } catch {
    checks.push({
      name: "node-pty",
      status: "fail",
      message: "Failed to load native module",
      fix: process.platform === "win32" ? 'Install "Desktop development with C++" workload from Visual Studio Build Tools (https://visualstudio.microsoft.com/visual-cpp-build-tools/), then run: npm rebuild node-pty' : "Install build tools: xcode-select --install (macOS) or apt install build-essential (Linux)"
    });
  }
  if (process.platform !== "win32") {
    const prebuildsDir = (0, import_path8.join)(process.cwd(), "node_modules", "node-pty", "prebuilds");
    const buildRelease = (0, import_path8.join)(process.cwd(), "node_modules", "node-pty", "build", "Release");
    let permFixed = false;
    for (const dir of [prebuildsDir, buildRelease]) {
      if (!(0, import_fs7.existsSync)(dir)) continue;
      try {
        const entries = dir === prebuildsDir ? (0, import_fs7.readdirSync)(dir) : ["."];
        for (const entry of entries) {
          const helperPath = dir === prebuildsDir ? (0, import_path8.join)(dir, entry, "spawn-helper") : (0, import_path8.join)(dir, "spawn-helper");
          if ((0, import_fs7.existsSync)(helperPath)) {
            const mode = (0, import_fs7.statSync)(helperPath).mode;
            if ((mode & 73) === 0) {
              (0, import_fs7.chmodSync)(helperPath, 493);
              permFixed = true;
            }
          }
        }
      } catch {
      }
    }
    if (permFixed) {
      checks.push({
        name: "node-pty spawn-helper",
        status: "warn",
        message: "Permissions were missing - fixed automatically"
      });
    }
  }
  try {
    const pty = require("node-pty");
    let output = "";
    const isWin = process.platform === "win32";
    const smokeCmd = isWin ? "cmd.exe" : "/bin/echo";
    const smokeArgs = isWin ? ["/c", "echo", "pty-ok"] : ["pty-ok"];
    const p = pty.spawn(smokeCmd, smokeArgs, { name: "xterm-256color", cols: 80, rows: 24 });
    await new Promise((resolve4, reject) => {
      p.onData((data) => {
        output += data;
      });
      p.onExit(({ exitCode }) => {
        if (exitCode === 0 && output.includes("pty-ok")) resolve4();
        else reject(new Error(`exit ${exitCode}`));
      });
      setTimeout(() => reject(new Error("timed out")), 5e3);
    });
    checks.push({
      name: "node-pty spawn test",
      status: "pass",
      message: "Can spawn processes"
    });
  } catch (err) {
    checks.push({
      name: "node-pty spawn test",
      status: "fail",
      message: `Cannot spawn processes: ${err.message}`,
      fix: "Try: npm rebuild node-pty"
    });
  }
  const ctxRoot = (0, import_path8.join)((0, import_os7.homedir)(), ".cortextos", options.instance);
  checks.push({
    name: "State directory",
    status: (0, import_fs7.existsSync)(ctxRoot) ? "pass" : "warn",
    message: (0, import_fs7.existsSync)(ctxRoot) ? ctxRoot : "Not found",
    fix: !(0, import_fs7.existsSync)(ctxRoot) ? "Run: cortextos init <org-name>" : void 0
  });
  try {
    (0, import_child_process2.execSync)("claude --version", { encoding: "utf8", stdio: "pipe" });
    checks.push({ name: "Claude Code auth", status: "pass", message: "Authenticated" });
  } catch {
    checks.push({
      name: "Claude Code auth",
      status: "warn",
      message: "Not authenticated",
      fix: "Run: claude login"
    });
  }
  if (process.platform === "darwin") {
    try {
      const cfVer = (0, import_child_process2.execSync)("cloudflared --version", { encoding: "utf-8", stdio: "pipe", timeout: 5e3 }).trim();
      checks.push({ name: "cloudflared", status: "pass", message: cfVer });
    } catch {
      checks.push({
        name: "cloudflared",
        status: "warn",
        message: "Not installed",
        fix: "Install with: brew install cloudflared"
      });
    }
    const cfCert = (0, import_path8.join)((0, import_os7.homedir)(), ".cloudflared", "cert.pem");
    checks.push({
      name: "Cloudflare auth",
      status: (0, import_fs7.existsSync)(cfCert) ? "pass" : "warn",
      message: (0, import_fs7.existsSync)(cfCert) ? "Authenticated (cert.pem found)" : "Not authenticated",
      fix: !(0, import_fs7.existsSync)(cfCert) ? "Run: cloudflared login" : void 0
    });
    let tunnelExists = false;
    try {
      const listOut = (0, import_child_process2.execSync)("cloudflared tunnel list --output json", {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 1e4
      });
      const tunnels = JSON.parse(listOut);
      tunnelExists = tunnels.some((t) => t.name === "cortextos");
    } catch {
    }
    checks.push({
      name: "Tunnel 'cortextos'",
      status: tunnelExists ? "pass" : "warn",
      message: tunnelExists ? "Exists" : "Not created",
      fix: !tunnelExists ? "Run: cortextos tunnel start" : void 0
    });
    let serviceRunning = false;
    try {
      const launchctlOut = (0, import_child_process2.execSync)("launchctl list", { encoding: "utf-8", stdio: "pipe" });
      serviceRunning = launchctlOut.includes("com.cortextos.tunnel");
    } catch {
    }
    checks.push({
      name: "Tunnel service (launchd)",
      status: serviceRunning ? "pass" : "warn",
      message: serviceRunning ? "Running" : "Not running",
      fix: !serviceRunning ? "Run: cortextos tunnel start" : void 0
    });
    const tunnelConfigPath = (0, import_path8.join)((0, import_os7.homedir)(), ".cortextos", options.instance, "tunnel.json");
    let tunnelUrl;
    try {
      const tc = JSON.parse((0, import_fs7.readFileSync)(tunnelConfigPath, "utf-8"));
      tunnelUrl = tc.tunnelUrl;
    } catch {
    }
    checks.push({
      name: "Tunnel URL",
      status: tunnelUrl ? "pass" : "warn",
      message: tunnelUrl ?? "Not set",
      fix: !tunnelUrl ? "Run: cortextos tunnel start" : void 0
    });
  }
  try {
    const ghVersion = (0, import_child_process2.execSync)("gh --version", { encoding: "utf-8", stdio: "pipe", timeout: 5e3 }).trim().split("\n")[0];
    checks.push({ name: "gh CLI", status: "pass", message: ghVersion });
  } catch {
    checks.push({
      name: "gh CLI",
      status: "warn",
      message: "Not installed",
      fix: "Install with: brew install gh (macOS) or https://cli.github.com"
    });
  }
  const frameworkRoot = process.cwd();
  if ((0, import_fs7.existsSync)((0, import_path8.join)(frameworkRoot, ".git"))) {
    try {
      (0, import_child_process2.execSync)("git remote get-url upstream", { encoding: "utf-8", stdio: "pipe", cwd: frameworkRoot });
      checks.push({ name: "upstream remote", status: "pass", message: "Configured" });
    } catch {
      checks.push({
        name: "upstream remote",
        status: "warn",
        message: "Not configured",
        fix: "Run: git remote add upstream <canonical-cortextos-repo-url>"
      });
    }
  }
  const catalogPath = (0, import_path8.join)(frameworkRoot, "community", "catalog.json");
  checks.push({
    name: "community/catalog.json",
    status: (0, import_fs7.existsSync)(catalogPath) ? "pass" : "warn",
    message: (0, import_fs7.existsSync)(catalogPath) ? "Found" : "Not found",
    fix: !(0, import_fs7.existsSync)(catalogPath) ? "Run: cortextos bus check-upstream --apply to fetch the latest catalog" : void 0
  });
  const orgsDir = (0, import_path8.join)(frameworkRoot, "orgs");
  let geminiConfigured = false;
  let geminiOrgFound = false;
  if ((0, import_fs7.existsSync)(orgsDir)) {
    try {
      for (const org of (0, import_fs7.readdirSync)(orgsDir)) {
        const secretsPath = (0, import_path8.join)(orgsDir, org, "secrets.env");
        if ((0, import_fs7.existsSync)(secretsPath)) {
          geminiOrgFound = true;
          const content = (0, import_fs7.readFileSync)(secretsPath, "utf-8");
          if (/^GEMINI_API_KEY=.+/m.test(content)) {
            geminiConfigured = true;
            break;
          }
        }
      }
    } catch {
    }
  }
  if (geminiOrgFound) {
    checks.push({
      name: "Knowledge Base (GEMINI_API_KEY)",
      status: geminiConfigured ? "pass" : "warn",
      message: geminiConfigured ? "Configured" : "Not set \u2014 semantic search and RAG disabled",
      fix: !geminiConfigured ? "Add GEMINI_API_KEY to orgs/<org>/secrets.env \u2014 get a free key at https://aistudio.google.com/app/apikey" : void 0
    });
  }
  let hasFailures = false;
  for (const check of checks) {
    const icon = check.status === "pass" ? "OK" : check.status === "warn" ? "WARN" : "FAIL";
    const prefix = `  [${icon}]`;
    console.log(`${prefix.padEnd(10)} ${check.name}: ${check.message}`);
    if (check.fix) {
      console.log(`           Fix: ${check.fix}`);
    }
    if (check.status === "fail") hasFailures = true;
  }
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const failCount = checks.filter((c) => c.status === "fail").length;
  console.log("");
  if (failCount > 0) {
    console.log(`  ${failCount} check(s) failed. Fix the issues above and run doctor again.
`);
    process.exit(1);
  } else if (warnCount > 0) {
    console.log(`  All critical checks passed, ${warnCount} warning(s). See above for details.
`);
  } else {
    console.log("  All checks passed.\n");
  }
});

// src/cli/bus.ts
init_cjs_shims();
var import_commander7 = require("commander");
var import_child_process7 = require("child_process");
var import_fs28 = require("fs");
var import_path28 = require("path");
init_message();
init_validate();

// src/bus/task.ts
init_cjs_shims();
var import_fs10 = require("fs");
var import_path11 = require("path");
init_atomic();
init_random();
init_validate();
function createTask(paths, agentName, org, title, options = {}) {
  const {
    description = "",
    assignee = agentName,
    priority = "normal",
    project = "",
    needsApproval = false,
    dueDate = "",
    blockedBy = [],
    blocks = []
  } = options;
  validatePriority(priority);
  const epoch = Date.now();
  const rand = randomDigits(3);
  const taskId = `task_${epoch}_${rand}`;
  const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const virtualTask = { id: taskId, blocked_by: blockedBy };
  if (blockedBy.length) detectCycleOrThrow(paths, taskId, blockedBy, virtualTask);
  if (blocks.length) {
    for (const downId of blocks) detectCycleOrThrow(paths, downId, [taskId], virtualTask);
  }
  const task = {
    id: taskId,
    title,
    description,
    type: "agent",
    needs_approval: needsApproval,
    status: "pending",
    assigned_to: assignee,
    created_by: agentName,
    org,
    priority,
    project,
    kpi_key: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    due_date: dueDate || null,
    archived: false,
    ...blockedBy.length ? { blocked_by: [...blockedBy] } : {},
    ...blocks.length ? { blocks: [...blocks] } : {}
  };
  ensureDir(paths.taskDir);
  atomicWriteSync((0, import_path11.join)(paths.taskDir, `${taskId}.json`), JSON.stringify(task));
  for (const depId of blockedBy) addSymmetricEdge(paths, depId, "blocks", taskId);
  for (const downId of blocks) addSymmetricEdge(paths, downId, "blocked_by", taskId);
  appendTaskAudit(paths, taskId, { event: "create", agent: agentName, to: "pending", note: title });
  return taskId;
}
function addSymmetricEdge(paths, taskId, field, peerId) {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return;
  try {
    const task = JSON.parse((0, import_fs10.readFileSync)(filePath, "utf-8"));
    const list = task[field] ?? [];
    if (!list.includes(peerId)) {
      task[field] = [...list, peerId];
      atomicWriteSync(filePath, JSON.stringify(task));
    }
  } catch {
  }
}
function detectCycleOrThrow(paths, newTaskId, initialBlockers, virtual) {
  const seen = /* @__PURE__ */ new Set();
  const stack = [...initialBlockers];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === newTaskId) {
      throw new Error(`Dependency cycle: ${newTaskId} ultimately blocks itself via ${cur}`);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (virtual && cur === virtual.id) {
      if (virtual.blocked_by.length) stack.push(...virtual.blocked_by);
      continue;
    }
    const filePath = findTaskFile(paths, cur);
    if (!filePath) continue;
    try {
      const task = JSON.parse((0, import_fs10.readFileSync)(filePath, "utf-8"));
      if (task.blocked_by?.length) stack.push(...task.blocked_by);
    } catch {
    }
  }
}
function checkTaskDependencies(paths, taskId) {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return [];
  let task;
  try {
    task = JSON.parse((0, import_fs10.readFileSync)(filePath, "utf-8"));
  } catch {
    return [];
  }
  const deps = task.blocked_by ?? [];
  const open = [];
  for (const depId of deps) {
    const depPath = findTaskFile(paths, depId);
    if (!depPath) {
      open.push({ id: depId, status: "missing" });
      continue;
    }
    try {
      const dep = JSON.parse((0, import_fs10.readFileSync)(depPath, "utf-8"));
      if (dep.status !== "completed") open.push({ id: depId, status: dep.status });
    } catch {
      open.push({ id: depId, status: "missing" });
    }
  }
  return open;
}
function findTaskFile(paths, taskId) {
  const sameOrg = (0, import_path11.join)(paths.taskDir, `${taskId}.json`);
  if ((0, import_fs10.existsSync)(sameOrg)) return sameOrg;
  const orgsRoot = (0, import_path11.join)(paths.ctxRoot, "orgs");
  const matches = [];
  try {
    for (const entry of (0, import_fs10.readdirSync)(orgsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = (0, import_path11.join)(orgsRoot, entry.name, "tasks", `${taskId}.json`);
      if ((0, import_fs10.existsSync)(candidate)) {
        matches.push({ path: candidate, org: entry.name });
      }
    }
  } catch {
    return null;
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const orgList = matches.map((m) => m.org).join(", ");
    console.warn(
      `[task] Ambiguous task id ${taskId}: found in ${matches.length} orgs (${orgList}). Operating on the first match in org '${matches[0].org}'. Review task ID generation if this recurs.`
    );
  }
  return matches[0].path;
}
function updateTask(paths, taskId, status) {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`
    );
  }
  let prevStatus;
  let assignee;
  try {
    const content = (0, import_fs10.readFileSync)(filePath, "utf-8");
    const task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    task.status = status;
    task.updated_at = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} update failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: "update", agent: assignee || "unknown", from: prevStatus, to: status });
}
function appendTaskAudit(paths, taskId, entry) {
  try {
    const auditDir = (0, import_path11.join)(paths.taskDir, "audit");
    ensureDir(auditDir);
    const line = {
      ts: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ...entry
    };
    (0, import_fs10.appendFileSync)((0, import_path11.join)(auditDir, `${taskId}.jsonl`), JSON.stringify(line) + "\n", { encoding: "utf-8", mode: 384 });
  } catch {
  }
}
function readTaskAudit(paths, taskId) {
  const path = (0, import_path11.join)(paths.taskDir, "audit", `${taskId}.jsonl`);
  if (!(0, import_fs10.existsSync)(path)) return [];
  const entries = [];
  for (const line of (0, import_fs10.readFileSync)(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return entries;
}
function claimTask(paths, taskId, agent) {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`
    );
  }
  let task;
  try {
    task = JSON.parse((0, import_fs10.readFileSync)(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Task ${taskId} claim failed (unreadable): ${err}`);
  }
  const claimsDir = (0, import_path11.join)(paths.taskDir, ".claims");
  ensureDir(claimsDir);
  const claimPath = (0, import_path11.join)(claimsDir, `${taskId}.claim`);
  const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  if ((0, import_fs10.existsSync)(claimPath)) {
    try {
      const owner = (0, import_fs10.readFileSync)(claimPath, "utf-8").split("	")[0];
      if (owner === agent) {
        return task;
      }
      throw new Error(
        `Task ${taskId} already claimed by ${owner} (current status=${task.status})`
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`Task ${taskId} already claimed`)) throw err;
    }
  }
  if (task.status !== "pending") {
    throw new Error(
      `Task ${taskId} is not pending (status=${task.status}); cannot claim`
    );
  }
  try {
    (0, import_fs10.writeFileSync)(claimPath, `${agent}	${now}
`, { flag: "wx", encoding: "utf-8", mode: 384 });
  } catch (err) {
    let owner = "unknown";
    try {
      owner = (0, import_fs10.readFileSync)(claimPath, "utf-8").split("	")[0];
    } catch {
    }
    if (owner === agent) return task;
    throw new Error(`Task ${taskId} already claimed by ${owner}`);
  }
  const prevStatus = task.status;
  task.status = "in_progress";
  task.assigned_to = agent;
  task.updated_at = now;
  try {
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    try {
      (0, import_fs10.unlinkSync)(claimPath);
    } catch {
    }
    throw new Error(`Task ${taskId} claim commit failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: "claim", agent, from: prevStatus, to: "in_progress" });
  return task;
}
function completeTask(paths, taskId, result) {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`
    );
  }
  let prevStatus;
  let assignee;
  try {
    const content = (0, import_fs10.readFileSync)(filePath, "utf-8");
    const task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    task.status = "completed";
    task.updated_at = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    task.completed_at = task.updated_at;
    if (result) {
      task.result = result;
    }
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} complete failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: "complete", agent: assignee || "unknown", from: prevStatus, to: "completed", note: result });
}
function listTasks(paths, filters) {
  const { taskDir } = paths;
  let files;
  try {
    files = (0, import_fs10.readdirSync)(taskDir).filter(
      (f) => f.startsWith("task_") && f.endsWith(".json")
    );
  } catch {
    return [];
  }
  const tasks = [];
  for (const file of files) {
    try {
      const content = (0, import_fs10.readFileSync)((0, import_path11.join)(taskDir, file), "utf-8");
      const task = JSON.parse(content);
      if (filters?.agent && task.assigned_to !== filters.agent) continue;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.priority && task.priority !== filters.priority) continue;
      if (task.archived) continue;
      tasks.push(task);
    } catch {
    }
  }
  const sorted = tasks.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  if (!filters?.respectDeps) return sorted;
  const byId = /* @__PURE__ */ new Map();
  for (const t of sorted) byId.set(t.id, t);
  const isBlocked = (t) => {
    for (const depId of t.blocked_by ?? []) {
      const dep = byId.get(depId);
      if (!dep) continue;
      if (dep.status !== "completed") return true;
    }
    return false;
  };
  const unblocked = [];
  const blocked = [];
  for (const t of sorted) (isBlocked(t) ? blocked : unblocked).push(t);
  return [...unblocked, ...blocked];
}
function readAllTasks(taskDir) {
  let files;
  try {
    files = (0, import_fs10.readdirSync)(taskDir).filter(
      (f) => f.startsWith("task_") && f.endsWith(".json")
    );
  } catch {
    return [];
  }
  const tasks = [];
  for (const file of files) {
    try {
      const content = (0, import_fs10.readFileSync)((0, import_path11.join)(taskDir, file), "utf-8");
      tasks.push(JSON.parse(content));
    } catch {
    }
  }
  return tasks;
}
function checkStaleTasks(paths) {
  const nowEpoch = Math.floor(Date.now() / 1e3);
  const STALE_IN_PROGRESS = 7200;
  const STALE_PENDING = 86400;
  const STALE_HUMAN = 86400;
  const report = {
    stale_in_progress: [],
    stale_pending: [],
    stale_human: [],
    overdue: []
  };
  const tasks = readAllTasks(paths.taskDir);
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "cancelled") continue;
    const updatedEpoch = Math.floor(new Date(task.updated_at).getTime() / 1e3);
    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1e3);
    const age = nowEpoch - updatedEpoch;
    const createdAge = nowEpoch - createdEpoch;
    if (task.status === "in_progress" && age > STALE_IN_PROGRESS) {
      report.stale_in_progress.push(task);
    }
    if (task.status === "pending" && createdAge > STALE_PENDING) {
      report.stale_pending.push(task);
    }
    if ((["human", "user"].includes(task.assigned_to ?? "") || task.project === "human-tasks") && createdAge > STALE_HUMAN) {
      report.stale_human.push(task);
    }
    if (task.due_date) {
      const dueEpoch = Math.floor(new Date(task.due_date).getTime() / 1e3);
      if (dueEpoch > 0 && nowEpoch > dueEpoch) {
        report.overdue.push(task);
      }
    }
  }
  return report;
}
function archiveTasks(paths, dryRun = false) {
  const nowEpoch = Math.floor(Date.now() / 1e3);
  const ARCHIVE_AGE = 604800;
  let archived = 0;
  let skipped = 0;
  const tasks = readAllTasks(paths.taskDir);
  for (const task of tasks) {
    if (task.status !== "completed") continue;
    if (!task.completed_at) {
      skipped++;
      continue;
    }
    const completedEpoch = Math.floor(new Date(task.completed_at).getTime() / 1e3);
    const age = nowEpoch - completedEpoch;
    if (age > ARCHIVE_AGE) {
      if (!dryRun) {
        const archiveDir = (0, import_path11.join)(paths.taskDir, "archive");
        ensureDir(archiveDir);
        task.archived = true;
        const srcPath = (0, import_path11.join)(paths.taskDir, `${task.id}.json`);
        atomicWriteSync(srcPath, JSON.stringify(task));
        (0, import_fs10.renameSync)(srcPath, (0, import_path11.join)(archiveDir, `${task.id}.json`));
      }
      archived++;
    }
  }
  return { archived, skipped, dry_run: dryRun };
}
function compactTasks(paths, options = {}) {
  const { olderThanDays = 30, dryRun = false } = options;
  const report = { archived: [], skipped: [], dry_run: dryRun };
  const cutoffMs = Date.now() - olderThanDays * 864e5;
  const { taskDir } = paths;
  let files;
  try {
    files = (0, import_fs10.readdirSync)(taskDir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
  } catch {
    return report;
  }
  const tasks = [];
  for (const f of files) {
    try {
      tasks.push(JSON.parse((0, import_fs10.readFileSync)((0, import_path11.join)(taskDir, f), "utf-8")));
    } catch {
    }
  }
  const byId = /* @__PURE__ */ new Map();
  for (const t of tasks) byId.set(t.id, t);
  const stillNeededAsBlocker = /* @__PURE__ */ new Set();
  const stack = [];
  for (const t of tasks) {
    if (t.status === "completed") continue;
    for (const blockerId of t.blocked_by ?? []) stack.push(blockerId);
  }
  while (stack.length) {
    const cur = stack.pop();
    if (stillNeededAsBlocker.has(cur)) continue;
    stillNeededAsBlocker.add(cur);
    const parent = byId.get(cur);
    if (parent?.blocked_by?.length) stack.push(...parent.blocked_by);
  }
  for (const task of tasks) {
    if (task.status !== "completed") continue;
    if (!task.completed_at) {
      report.skipped.push({ id: task.id, reason: "no completed_at timestamp" });
      continue;
    }
    const completedMs = new Date(task.completed_at).getTime();
    if (isNaN(completedMs) || completedMs > cutoffMs) {
      report.skipped.push({ id: task.id, reason: "completed_at within cutoff" });
      continue;
    }
    if (stillNeededAsBlocker.has(task.id)) {
      report.skipped.push({ id: task.id, reason: "still referenced by an open task's blocked_by chain" });
      continue;
    }
    const yyyymm = task.completed_at.substring(0, 7);
    const archiveFile = `archive-${yyyymm}.jsonl`;
    const archivePath = (0, import_path11.join)(taskDir, archiveFile);
    const entry = {
      id: task.id,
      title: task.title,
      org: task.org,
      assigned_to: task.assigned_to,
      completed_at: task.completed_at,
      archived_at: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      result: task.result ?? ""
    };
    if (!dryRun) {
      try {
        (0, import_fs10.appendFileSync)(archivePath, JSON.stringify(entry) + "\n", { encoding: "utf-8", mode: 384 });
        (0, import_fs10.unlinkSync)((0, import_path11.join)(taskDir, `${task.id}.json`));
      } catch (err) {
        report.skipped.push({ id: task.id, reason: `archive write failed: ${err}` });
        continue;
      }
    }
    report.archived.push({ id: task.id, archive_file: archiveFile });
  }
  return report;
}
function checkHumanTasks(paths) {
  const nowEpoch = Math.floor(Date.now() / 1e3);
  const STALE_THRESHOLD = 86400;
  const tasks = readAllTasks(paths.taskDir);
  const result = [];
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "cancelled") continue;
    if (task.assigned_to !== "human" && task.assigned_to !== "user") continue;
    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1e3);
    const age = nowEpoch - createdEpoch;
    if (age > STALE_THRESHOLD) {
      result.push(task);
    }
  }
  return result;
}

// src/bus/save-output.ts
init_cjs_shims();
var import_fs11 = require("fs");
var import_path12 = require("path");
init_atomic();
function saveOutput(paths, options) {
  const { sourcePath, taskId, label, move = false, noLink = false } = options;
  if (!(0, import_fs11.existsSync)(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  const taskFile = (0, import_path12.join)(paths.taskDir, `${taskId}.json`);
  if (!(0, import_fs11.existsSync)(taskFile)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const task = JSON.parse((0, import_fs11.readFileSync)(taskFile, "utf-8"));
  const taskDir = (0, import_path12.join)(paths.deliverablesDir, task.assigned_to, taskId);
  ensureDir(taskDir);
  const sourceName = (0, import_path12.basename)(sourcePath);
  const targetPath = resolveCollision(taskDir, sourceName);
  (0, import_fs11.copyFileSync)(sourcePath, targetPath);
  if (move) {
    try {
      (0, import_fs11.unlinkSync)(sourcePath);
    } catch (err) {
      throw new Error(
        `Copied to ${targetPath} but failed to remove source ${sourcePath}: ${err.message}`
      );
    }
  }
  const storedPath = toPosixRelative(paths.ctxRoot, targetPath);
  if (noLink) {
    return { targetPath, storedPath, linked: false };
  }
  const entry = {
    type: "file",
    value: storedPath,
    label: label ?? (0, import_path12.basename)(targetPath)
  };
  task.outputs = [...task.outputs ?? [], entry];
  task.updated_at = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  atomicWriteSync(taskFile, JSON.stringify(task, null, 2));
  return { targetPath, storedPath, linked: true };
}
function resolveCollision(dir, desiredName) {
  const candidate = (0, import_path12.join)(dir, desiredName);
  if (!(0, import_fs11.existsSync)(candidate)) return candidate;
  const ext = (0, import_path12.extname)(desiredName);
  const stem = ext ? desiredName.slice(0, -ext.length) : desiredName;
  for (let i = 1; i < 1e4; i++) {
    const next = (0, import_path12.join)(dir, `${stem}-${i}${ext}`);
    if (!(0, import_fs11.existsSync)(next)) return next;
  }
  throw new Error(`Could not resolve unique filename in ${dir} for ${desiredName}`);
}
function toPosixRelative(root, abs) {
  const rel = (0, import_path12.relative)(root, abs);
  return rel.split(import_path12.sep).join(import_path12.posix.sep);
}

// src/bus/event.ts
init_cjs_shims();
var import_fs12 = require("fs");
var import_path13 = require("path");
init_atomic();
init_random();
init_validate();
function logEvent(paths, agentName, org, category, eventName, severity, metadata) {
  validateEventCategory(category);
  validateEventSeverity(severity);
  let meta = {};
  if (typeof metadata === "string") {
    if (isValidJson(metadata)) {
      meta = JSON.parse(metadata);
    }
  } else if (metadata) {
    meta = metadata;
  }
  const epoch = Math.floor(Date.now() / 1e3);
  const rand = randomString(5);
  const eventId = `${epoch}-${agentName}-${rand}`;
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const eventsDir = (0, import_path13.join)(paths.analyticsDir, "events", agentName);
  ensureDir(eventsDir);
  const eventLine = JSON.stringify({
    id: eventId,
    agent: agentName,
    org,
    timestamp,
    category,
    event: eventName,
    severity,
    metadata: meta
  });
  (0, import_fs12.appendFileSync)((0, import_path13.join)(eventsDir, `${today}.jsonl`), eventLine + "\n", "utf-8");
}

// src/bus/heartbeat.ts
init_cjs_shims();
var import_fs13 = require("fs");
var import_path14 = require("path");
init_atomic();
function updateHeartbeat(paths, agentName, status, options) {
  ensureDir(paths.stateDir);
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const mode = options?.timezone ? detectDayNightMode(options.timezone) : detectDayNightMode("UTC");
  const heartbeat = {
    agent: agentName,
    org: options?.org ?? "",
    ...options?.displayName ? { display_name: options.displayName } : {},
    status,
    current_task: options?.currentTask ?? "",
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? ""
  };
  atomicWriteSync(
    (0, import_path14.join)(paths.stateDir, "heartbeat.json"),
    JSON.stringify(heartbeat)
  );
}
function detectDayNightMode(timezone) {
  try {
    const now = /* @__PURE__ */ new Date();
    const formatted = now.toLocaleString("en-US", { timeZone: timezone, hour12: false, hour: "2-digit" });
    const hour = parseInt(formatted, 10);
    return hour >= 8 && hour < 22 ? "day" : "night";
  } catch {
    const hour = (/* @__PURE__ */ new Date()).getUTCHours();
    return hour >= 8 && hour < 22 ? "day" : "night";
  }
}
function readAllHeartbeats(paths) {
  const heartbeats = [];
  const stateDir = (0, import_path14.join)(paths.ctxRoot, "state");
  let agentDirs;
  try {
    agentDirs = (0, import_fs13.readdirSync)(stateDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  for (const agent of agentDirs) {
    const hbPath = (0, import_path14.join)(stateDir, agent, "heartbeat.json");
    try {
      const content = (0, import_fs13.readFileSync)(hbPath, "utf-8");
      heartbeats.push(JSON.parse(content));
    } catch {
    }
  }
  return heartbeats;
}

// src/cli/bus.ts
init_system();

// src/bus/experiment.ts
init_cjs_shims();
var import_fs17 = require("fs");
var import_path17 = require("path");
init_atomic();
init_random();
function nowISO() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function historyDir(agentDir) {
  return (0, import_path17.join)(agentDir, "experiments", "history");
}
function loadExperiment(agentDir, experimentId) {
  const filePath = (0, import_path17.join)(historyDir(agentDir), `${experimentId}.json`);
  if (!(0, import_fs17.existsSync)(filePath)) {
    throw new Error(`Experiment ${experimentId} not found`);
  }
  return JSON.parse((0, import_fs17.readFileSync)(filePath, "utf-8").trim());
}
function saveExperiment(agentDir, experiment) {
  const dir = historyDir(agentDir);
  ensureDir(dir);
  atomicWriteSync((0, import_path17.join)(dir, `${experiment.id}.json`), JSON.stringify(experiment, null, 2));
}
function loadExperimentConfig(agentDir) {
  return loadConfig(agentDir);
}
function loadConfig(agentDir) {
  const configPath = (0, import_path17.join)(agentDir, "experiments", "config.json");
  if (!(0, import_fs17.existsSync)(configPath)) {
    return {};
  }
  return JSON.parse((0, import_fs17.readFileSync)(configPath, "utf-8").trim());
}
function saveConfig(agentDir, config) {
  const dir = (0, import_path17.join)(agentDir, "experiments");
  ensureDir(dir);
  atomicWriteSync((0, import_path17.join)(dir, "config.json"), JSON.stringify(config, null, 2));
}
function createExperiment(agentDir, agentName, metric, hypothesis, options) {
  const epoch = Math.floor(Date.now() / 1e3);
  const rand = randomString(5);
  const id = `exp_${epoch}_${rand}`;
  const experiment = {
    id,
    agent: agentName,
    metric,
    hypothesis,
    surface: options?.surface || "",
    direction: options?.direction || "higher",
    window: options?.window || "24h",
    measurement: options?.measurement || "",
    status: "proposed",
    baseline_value: 0,
    result_value: null,
    decision: null,
    learning: "",
    experiment_commit: null,
    tracking_commit: null,
    created_at: nowISO(),
    started_at: null,
    completed_at: null,
    changes_description: null
  };
  saveExperiment(agentDir, experiment);
  return id;
}
function runExperiment(agentDir, experimentId, changesDescription) {
  const experiment = loadExperiment(agentDir, experimentId);
  if (experiment.status !== "proposed") {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'proposed'`);
  }
  experiment.status = "running";
  experiment.started_at = nowISO();
  if (changesDescription) {
    experiment.changes_description = changesDescription;
  }
  saveExperiment(agentDir, experiment);
  const activeDir = (0, import_path17.join)(agentDir, "experiments");
  ensureDir(activeDir);
  atomicWriteSync((0, import_path17.join)(activeDir, "active.json"), JSON.stringify(experiment, null, 2));
  return experiment;
}
function evaluateExperiment(agentDir, experimentId, measuredValue, options) {
  const experiment = loadExperiment(agentDir, experimentId);
  if (experiment.status !== "running") {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'running'`);
  }
  let decision;
  if (experiment.direction === "higher") {
    decision = measuredValue > experiment.baseline_value ? "keep" : "discard";
  } else {
    decision = measuredValue < experiment.baseline_value ? "keep" : "discard";
  }
  experiment.status = "completed";
  experiment.completed_at = nowISO();
  experiment.result_value = measuredValue;
  experiment.decision = decision;
  if (options?.score !== void 0) {
    measuredValue = options.score;
    if (experiment.direction === "higher") {
      decision = measuredValue > experiment.baseline_value ? "keep" : "discard";
    } else {
      decision = measuredValue < experiment.baseline_value ? "keep" : "discard";
    }
    experiment.result_value = measuredValue;
    experiment.decision = decision;
  }
  const learningParts = [];
  if (options?.learning) learningParts.push(options.learning);
  if (options?.justification) learningParts.push(options.justification);
  if (learningParts.length > 0) {
    experiment.learning = learningParts.join(" \u2014 ");
  }
  if (decision === "keep") {
    experiment.baseline_value = measuredValue;
  }
  saveExperiment(agentDir, experiment);
  const expDir = (0, import_path17.join)(agentDir, "experiments");
  ensureDir(expDir);
  const tsvPath = (0, import_path17.join)(expDir, "results.tsv");
  if (!(0, import_fs17.existsSync)(tsvPath)) {
    (0, import_fs17.appendFileSync)(
      tsvPath,
      "experiment_id	agent	metric	measured_value	baseline	decision	hypothesis	timestamp\n",
      "utf-8"
    );
  }
  const tsvLine = [
    experiment.id,
    experiment.agent,
    experiment.metric,
    String(measuredValue),
    String(decision === "keep" ? measuredValue : experiment.baseline_value),
    decision,
    experiment.hypothesis,
    experiment.completed_at
  ].join("	");
  (0, import_fs17.appendFileSync)(tsvPath, tsvLine + "\n", "utf-8");
  const learningsPath = (0, import_path17.join)(expDir, "learnings.md");
  if (!(0, import_fs17.existsSync)(learningsPath)) {
    (0, import_fs17.appendFileSync)(learningsPath, "# Experiment Learnings\n\n", "utf-8");
  }
  const learningEntry = [
    `## ${experiment.id} (${decision})`,
    `- **Metric:** ${experiment.metric}`,
    `- **Hypothesis:** ${experiment.hypothesis}`,
    `- **Result:** ${measuredValue} (baseline: ${decision === "keep" ? measuredValue : experiment.baseline_value})`,
    experiment.learning ? `- **Learning:** ${experiment.learning}` : "",
    ""
  ].filter(Boolean).join("\n");
  (0, import_fs17.appendFileSync)(learningsPath, learningEntry + "\n", "utf-8");
  const activePath = (0, import_path17.join)(expDir, "active.json");
  if ((0, import_fs17.existsSync)(activePath)) {
    try {
      (0, import_fs17.unlinkSync)(activePath);
    } catch {
    }
  }
  return experiment;
}
function listExperiments(agentDir, filters) {
  const dir = historyDir(agentDir);
  let files;
  try {
    files = (0, import_fs17.readdirSync)(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  let experiments = [];
  for (const file of files) {
    try {
      const content = (0, import_fs17.readFileSync)((0, import_path17.join)(dir, file), "utf-8").trim();
      experiments.push(JSON.parse(content));
    } catch {
    }
  }
  if (filters?.status) {
    experiments = experiments.filter((e) => e.status === filters.status);
  }
  if (filters?.metric) {
    experiments = experiments.filter((e) => e.metric === filters.metric);
  }
  if (filters?.agent) {
    experiments = experiments.filter((e) => e.agent === filters.agent);
  }
  experiments.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return experiments;
}
function gatherContext(agentDir, agentName, _options) {
  const expDir = (0, import_path17.join)(agentDir, "experiments");
  const learningsPath = (0, import_path17.join)(expDir, "learnings.md");
  const learnings = (0, import_fs17.existsSync)(learningsPath) ? (0, import_fs17.readFileSync)(learningsPath, "utf-8") : "";
  const tsvPath = (0, import_path17.join)(expDir, "results.tsv");
  const resultsTsv = (0, import_fs17.existsSync)(tsvPath) ? (0, import_fs17.readFileSync)(tsvPath, "utf-8") : "";
  const all = listExperiments(agentDir);
  const completed = all.filter((e) => e.status === "completed");
  const keeps = completed.filter((e) => e.decision === "keep").length;
  const discards = completed.filter((e) => e.decision === "discard").length;
  const total = all.length;
  const keepRate = completed.length > 0 ? keeps / completed.length : 0;
  const identityPath = (0, import_path17.join)(agentDir, "IDENTITY.md");
  const identity = (0, import_fs17.existsSync)(identityPath) ? (0, import_fs17.readFileSync)(identityPath, "utf-8") : "";
  const goalsPath = (0, import_path17.join)(agentDir, "GOALS.md");
  const goals = (0, import_fs17.existsSync)(goalsPath) ? (0, import_fs17.readFileSync)(goalsPath, "utf-8") : "";
  return {
    agent: agentName,
    total_experiments: total,
    keeps,
    discards,
    keep_rate: keepRate,
    learnings,
    results_tsv: resultsTsv,
    identity,
    goals
  };
}
function manageCycle(agentDir, action, options) {
  const config = loadConfig(agentDir);
  if (!config.cycles) {
    config.cycles = [];
  }
  switch (action) {
    case "create": {
      if (!options.name || !options.agent || !options.metric) {
        throw new Error("Cycle create requires name, agent, and metric");
      }
      const cycle = {
        name: options.name,
        agent: options.agent,
        metric: options.metric,
        metric_type: options.metric_type || "qualitative",
        surface: options.surface || "",
        direction: options.direction || "higher",
        window: options.window || "24h",
        measurement: options.measurement || "",
        loop_interval: options.loop_interval || options.window || "24h",
        enabled: true,
        created_by: options.agent,
        created_at: nowISO()
      };
      config.cycles.push(cycle);
      saveConfig(agentDir, config);
      return config.cycles;
    }
    case "modify": {
      if (!options.name) {
        throw new Error("Cycle modify requires name");
      }
      const idx = config.cycles.findIndex((c) => c.name === options.name);
      if (idx === -1) {
        throw new Error(`Cycle '${options.name}' not found`);
      }
      if (options.metric) config.cycles[idx].metric = options.metric;
      if (options.metric_type) config.cycles[idx].metric_type = options.metric_type;
      if (options.surface) config.cycles[idx].surface = options.surface;
      if (options.direction) config.cycles[idx].direction = options.direction;
      if (options.enabled !== void 0) config.cycles[idx].enabled = options.enabled;
      if (options.window) config.cycles[idx].window = options.window;
      if (options.measurement) config.cycles[idx].measurement = options.measurement;
      if (options.loop_interval) config.cycles[idx].loop_interval = options.loop_interval;
      if (options.agent) config.cycles[idx].agent = options.agent;
      saveConfig(agentDir, config);
      return config.cycles;
    }
    case "remove": {
      if (!options.name) {
        throw new Error("Cycle remove requires name");
      }
      const removeIdx = config.cycles.findIndex((c) => c.name === options.name);
      if (removeIdx === -1) {
        throw new Error(`Cycle '${options.name}' not found`);
      }
      config.cycles.splice(removeIdx, 1);
      saveConfig(agentDir, config);
      return config.cycles;
    }
    case "list": {
      if (options.agent) {
        return config.cycles.filter((c) => c.agent === options.agent);
      }
      return config.cycles;
    }
    default:
      throw new Error(`Unknown cycle action: ${action}`);
  }
}

// src/bus/catalog.ts
init_cjs_shims();
var import_fs18 = require("fs");
var import_path18 = require("path");
var import_child_process4 = require("child_process");
init_atomic();
var PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  phone: /\+?[0-9]{1,3}[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/,
  credential: /(sk-|ghp_|xoxb-|AKIA|token=|key=|password=|secret=)/,
  telegram_chat_id: /chat_id[:\s]*[0-9]{6,}/,
  deployment_url: /https?:\/\/[a-z0-9.-]+\.(railway\.app|vercel\.app|herokuapp\.com|netlify\.app)/
};
function isValidItemName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
function lockdownPermissions(targetDir) {
  if (process.platform === "win32") return;
  try {
    const walk = (dir) => {
      const entries = (0, import_fs18.readdirSync)(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = (0, import_path18.join)(dir, entry.name);
        if (entry.isDirectory()) {
          (0, import_fs18.chmodSync)(full, 448);
          walk(full);
        } else if (entry.isFile()) {
          const isExec = entry.name.endsWith(".sh") || entry.name.endsWith(".mjs") || entry.name.endsWith(".py");
          (0, import_fs18.chmodSync)(full, isExec ? 448 : 384);
        }
      }
    };
    (0, import_fs18.chmodSync)(targetDir, 448);
    walk(targetDir);
  } catch {
  }
}
function findCatalogPath(frameworkRoot) {
  return (0, import_path18.join)(frameworkRoot, "community", "catalog.json");
}
function getInstalledPath(ctxRoot) {
  return (0, import_path18.join)(ctxRoot, ".installed-community.json");
}
function readInstalled(ctxRoot) {
  const p = getInstalledPath(ctxRoot);
  if (!(0, import_fs18.existsSync)(p)) return {};
  try {
    return JSON.parse((0, import_fs18.readFileSync)(p, "utf-8"));
  } catch {
    return {};
  }
}
function writeInstalled(ctxRoot, data) {
  const p = getInstalledPath(ctxRoot);
  ensureDir(ctxRoot);
  (0, import_fs18.writeFileSync)(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
function browseCatalog(frameworkRoot, ctxRoot, options = {}) {
  const catalogPath = findCatalogPath(frameworkRoot);
  if (!(0, import_fs18.existsSync)(catalogPath)) {
    return { status: "error", count: 0, items: [], error: "catalog.json not found", hint: "Run check-upstream to fetch the latest catalog" };
  }
  let catalog;
  try {
    catalog = JSON.parse((0, import_fs18.readFileSync)(catalogPath, "utf-8"));
  } catch {
    return { status: "error", count: 0, items: [], error: "Failed to parse catalog.json" };
  }
  if (!catalog.items || catalog.items.length === 0) {
    return { status: "empty", count: 0, items: [], message: "No items in catalog yet" };
  }
  let items = [...catalog.items];
  if (options.type) {
    items = items.filter((i) => i.type === options.type);
  }
  if (options.tag) {
    items = items.filter((i) => i.tags && i.tags.includes(options.tag));
  }
  if (options.search) {
    const q = options.search.toLowerCase();
    items = items.filter(
      (i) => i.name.toLowerCase().includes(q) || i.description && i.description.toLowerCase().includes(q)
    );
  }
  const installed = readInstalled(ctxRoot);
  items = items.map((i) => ({
    ...i,
    installed: installed[i.name] != null
  }));
  return { status: "ok", count: items.length, items };
}
function installCommunityItem(frameworkRoot, ctxRoot, itemName, options = {}) {
  if (!itemName) {
    return { status: "error", name: "", error: "item name required" };
  }
  if (!isValidItemName(itemName)) {
    return { status: "error", name: itemName, error: "invalid item name (allowed: a-zA-Z0-9 _ -)" };
  }
  const catalogPath = findCatalogPath(frameworkRoot);
  if (!(0, import_fs18.existsSync)(catalogPath)) {
    return { status: "error", name: itemName, error: "catalog.json not found" };
  }
  let catalog;
  try {
    catalog = JSON.parse((0, import_fs18.readFileSync)(catalogPath, "utf-8"));
  } catch {
    return { status: "error", name: itemName, error: "Failed to parse catalog.json" };
  }
  const item = catalog.items.find((i) => i.name === itemName);
  if (!item) {
    return { status: "error", name: itemName, error: "item not found in catalog" };
  }
  const installPath = item.install_path.replace(/^community\//, "");
  if (installPath.includes("..") || installPath.startsWith("/")) {
    return { status: "error", name: itemName, error: "install_path contains path traversal" };
  }
  const communityBase = (0, import_path18.join)(frameworkRoot, "community");
  const sourceDir = (0, import_path18.join)(communityBase, installPath);
  const resolvedSource = (0, import_path18.resolve)(sourceDir);
  const resolvedBase = (0, import_path18.resolve)(communityBase);
  if (!resolvedSource.startsWith(resolvedBase + "/") && resolvedSource !== resolvedBase) {
    return { status: "error", name: itemName, error: "install_path resolves outside community directory" };
  }
  if (!(0, import_fs18.existsSync)(sourceDir)) {
    return { status: "error", name: itemName, error: "source directory not found", hint: "Run check-upstream to fetch latest catalog" };
  }
  let targetDir;
  switch (item.type) {
    case "skill":
      targetDir = (0, import_path18.join)(options.agentDir || frameworkRoot, ".claude", "skills", itemName);
      break;
    case "agent":
      targetDir = (0, import_path18.join)(frameworkRoot, "templates", "personas", itemName);
      break;
    case "org":
      targetDir = (0, import_path18.join)(frameworkRoot, "templates", "orgs", itemName);
      break;
    default:
      return { status: "error", name: itemName, error: `unknown item type: ${item.type}` };
  }
  if ((0, import_fs18.existsSync)(targetDir)) {
    return { status: "already_exists", name: itemName, path: targetDir, hint: "Remove existing directory first or merge manually" };
  }
  const files = listFilesRecursive(sourceDir, sourceDir);
  if (options.dryRun) {
    return {
      status: "dry_run",
      name: itemName,
      version: item.version,
      target: targetDir,
      file_count: files.length,
      files
    };
  }
  ensureDir(targetDir);
  (0, import_fs18.cpSync)(sourceDir, targetDir, { recursive: true });
  lockdownPermissions(targetDir);
  const installed = readInstalled(ctxRoot);
  installed[itemName] = {
    version: item.version,
    type: item.type,
    installed_at: (/* @__PURE__ */ new Date()).toISOString(),
    path: targetDir
  };
  writeInstalled(ctxRoot, installed);
  return {
    status: "installed",
    name: itemName,
    version: item.version,
    target: targetDir,
    file_count: files.length
  };
}
function prepareSubmission(ctxRoot, itemType, sourcePath, itemName, options = {}) {
  if (!itemType || !sourcePath || !itemName) {
    return { status: "error", name: itemName || "", type: itemType || "", staging_dir: "", file_count: 0, files: [], pii_detected: ["usage: prepare-submission <skill|agent|org> <source-path> <item-name>"] };
  }
  if (!isValidItemName(itemName)) {
    return { status: "error", name: itemName, type: itemType, staging_dir: "", file_count: 0, files: [], pii_detected: ["invalid item name (allowed: a-zA-Z0-9 _ -)"] };
  }
  if (!(0, import_fs18.existsSync)(sourcePath)) {
    return { status: "error", name: itemName, type: itemType, staging_dir: "", file_count: 0, files: [], pii_detected: ["source path not found"] };
  }
  const stagingDir = (0, import_path18.join)(ctxRoot, "community-staging", itemName);
  const resolvedStaging = (0, import_path18.resolve)(stagingDir);
  const resolvedStagingBase = (0, import_path18.resolve)((0, import_path18.join)(ctxRoot, "community-staging"));
  if (!resolvedStaging.startsWith(resolvedStagingBase + "/") && resolvedStaging !== resolvedStagingBase) {
    return { status: "error", name: itemName, type: itemType, staging_dir: "", file_count: 0, files: [], pii_detected: ["staging directory resolves outside expected path"] };
  }
  if ((0, import_fs18.existsSync)(stagingDir)) {
    (0, import_fs18.rmSync)(stagingDir, { recursive: true, force: true });
  }
  ensureDir(stagingDir);
  (0, import_fs18.cpSync)(sourcePath, stagingDir, { recursive: true });
  lockdownPermissions(stagingDir);
  const piiFound = [];
  const files = listFilesRecursive(stagingDir, stagingDir);
  for (const relPath of files) {
    const fullPath = (0, import_path18.join)(stagingDir, relPath);
    let content;
    try {
      content = (0, import_fs18.readFileSync)(fullPath, "utf-8");
    } catch {
      continue;
    }
    if (PII_PATTERNS.email.test(content)) {
      piiFound.push(`${relPath}:email_address`);
    }
    if (PII_PATTERNS.phone.test(content)) {
      piiFound.push(`${relPath}:phone_number`);
    }
    if (PII_PATTERNS.credential.test(content)) {
      piiFound.push(`${relPath}:credential_pattern`);
    }
    if (PII_PATTERNS.telegram_chat_id.test(content)) {
      piiFound.push(`${relPath}:telegram_chat_id`);
    }
    if (PII_PATTERNS.deployment_url.test(content)) {
      piiFound.push(`${relPath}:deployment_url`);
    }
    if (options.userNames) {
      for (const name of options.userNames) {
        if (content.toLowerCase().includes(name.toLowerCase())) {
          piiFound.push(`${relPath}:user_name:${name}`);
        }
      }
    }
    if (options.orgContext?.name) {
      if (content.toLowerCase().includes(options.orgContext.name.toLowerCase())) {
        piiFound.push(`${relPath}:company_name:${options.orgContext.name}`);
      }
    }
  }
  if (options.dryRun) {
    (0, import_fs18.rmSync)(stagingDir, { recursive: true, force: true });
  }
  return {
    status: piiFound.length > 0 ? "pii_detected" : "clean",
    name: itemName,
    type: itemType,
    staging_dir: stagingDir,
    file_count: files.length,
    files,
    pii_detected: piiFound
  };
}
function submitCommunityItem(frameworkRoot, ctxRoot, itemName, itemType, description, options = {}) {
  if (!itemName || !itemType || !description) {
    return { status: "error", name: itemName || "", error: "usage: submit-community-item <item-name> <item-type> <description>" };
  }
  if (!isValidItemName(itemName)) {
    return { status: "error", name: itemName, error: "invalid item name (allowed: a-zA-Z0-9 _ -)" };
  }
  if (!["skill", "agent", "org"].includes(itemType)) {
    return { status: "error", name: itemName, error: "invalid type, must be: skill, agent, org" };
  }
  const stagingDir = (0, import_path18.join)(ctxRoot, "community-staging", itemName);
  if (!(0, import_fs18.existsSync)(stagingDir)) {
    return { status: "error", name: itemName, error: "staged submission not found", hint: "Run prepare-submission first" };
  }
  let installPath;
  switch (itemType) {
    case "skill":
      installPath = `skills/${itemName}`;
      break;
    case "agent":
      installPath = `agents/${itemName}`;
      break;
    case "org":
      installPath = `orgs/${itemName}`;
      break;
    default:
      return { status: "error", name: itemName, error: "invalid type" };
  }
  const targetDir = (0, import_path18.join)(frameworkRoot, "community", installPath);
  const files = listFilesRecursive(stagingDir, stagingDir);
  const branch = `community/${itemName}`;
  const author = options.author || "anonymous";
  if (options.dryRun) {
    return {
      status: "dry_run",
      name: itemName,
      target: `community/${installPath}`,
      description,
      file_count: files.length,
      branch
    };
  }
  ensureDir(targetDir);
  (0, import_fs18.cpSync)(stagingDir, targetDir, { recursive: true });
  lockdownPermissions(targetDir);
  const catalogPath = (0, import_path18.join)(frameworkRoot, "community", "catalog.json");
  let catalog;
  try {
    catalog = JSON.parse((0, import_fs18.readFileSync)(catalogPath, "utf-8"));
  } catch {
    catalog = { version: "1.0.0", updated_at: (/* @__PURE__ */ new Date()).toISOString(), items: [] };
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  catalog.items.push({
    name: itemName,
    description,
    author,
    type: itemType,
    version: "1.0.0",
    tags: [],
    review_status: "community",
    dependencies: [],
    install_path: installPath,
    submitted_at: timestamp
  });
  (0, import_fs18.writeFileSync)(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf-8");
  (0, import_fs18.rmSync)(stagingDir, { recursive: true, force: true });
  if (options.contribute) {
    const execOpts = { cwd: frameworkRoot, encoding: "utf-8", timeout: 6e4 };
    try {
      let upstreamUrl;
      try {
        upstreamUrl = (0, import_child_process4.execSync)("git remote get-url upstream", { ...execOpts, stdio: "pipe" }).trim();
      } catch {
        return {
          status: "error",
          name: itemName,
          error: "no upstream remote configured",
          hint: "Run: git remote add upstream <canonical-repo-url>"
        };
      }
      try {
        (0, import_child_process4.execSync)("git remote get-url origin", { ...execOpts, stdio: "pipe" });
      } catch {
        return {
          status: "error",
          name: itemName,
          error: "no origin remote configured",
          hint: "Add your fork as origin: git remote add origin <your-fork-url>"
        };
      }
      try {
        (0, import_child_process4.execFileSync)("git", ["checkout", "-b", branch], { ...execOpts, stdio: "pipe" });
      } catch {
        (0, import_child_process4.execFileSync)("git", ["checkout", branch], { ...execOpts, stdio: "pipe" });
      }
      (0, import_child_process4.execSync)("git add community/", { ...execOpts, stdio: "pipe" });
      const commitMsg = `community: add ${itemType} ${itemName}

${description}

Submitted-by: ${author}`;
      (0, import_child_process4.execFileSync)("git", ["commit", "-m", commitMsg], { ...execOpts, stdio: "pipe" });
      (0, import_child_process4.execFileSync)("git", ["push", "origin", branch], { ...execOpts, stdio: "pipe" });
      const upstreamRepo = extractRepoPath(upstreamUrl);
      let prUrl = "";
      try {
        const prTitle = `Community ${itemType}: ${itemName}`;
        const prBody = `## ${itemName}

${description}

**Type:** ${itemType}
**Author:** ${author}

---
*Submitted via cortextOS community publishing*`;
        const ghOut = (0, import_child_process4.execFileSync)(
          "gh",
          ["pr", "create", "--repo", upstreamRepo, "--title", prTitle, "--body", prBody],
          { ...execOpts, stdio: "pipe", encoding: "utf-8" }
        ).trim();
        prUrl = ghOut.split("\n").find((l) => l.startsWith("https://")) || ghOut;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          status: "contributed",
          name: itemName,
          branch,
          file_count: files.length,
          hint: `Branch pushed to origin/${branch} but gh pr create failed: ${msg.split("\n")[0]}. Open the PR manually.`
        };
      }
      return {
        status: "contributed",
        name: itemName,
        branch,
        pr_url: prUrl,
        file_count: files.length
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: "error", name: itemName, error: `contribution failed: ${msg.split("\n")[0]}` };
    }
  }
  return {
    status: "submitted",
    name: itemName,
    file_count: files.length
  };
}
function extractRepoPath(remoteUrl) {
  const match = remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : remoteUrl;
}
function listFilesRecursive(dir, baseDir) {
  const results = [];
  if (!(0, import_fs18.existsSync)(dir)) return results;
  try {
    const entries = (0, import_fs18.readdirSync)(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = (0, import_path18.join)(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(fullPath, baseDir));
      } else {
        results.push((0, import_path18.relative)(baseDir, fullPath));
      }
    }
  } catch {
  }
  return results.sort();
}

// src/bus/metrics.ts
init_cjs_shims();
var import_fs19 = require("fs");
var import_path19 = require("path");
var import_child_process5 = require("child_process");
init_atomic();
function collectMetrics(ctxRoot, org) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const today = timestamp.split("T")[0];
  const enabledFile = (0, import_path19.join)(ctxRoot, "config", "enabled-agents.json");
  let agentNames = [];
  if ((0, import_fs19.existsSync)(enabledFile)) {
    try {
      agentNames = Object.keys(JSON.parse((0, import_fs19.readFileSync)(enabledFile, "utf-8")));
    } catch {
    }
  }
  const agents = {};
  let totalCompleted = 0;
  let agentsHealthy = 0;
  const agentsTotal = agentNames.length;
  const taskDirs = [];
  const tasksDir = (0, import_path19.join)(ctxRoot, "tasks");
  if ((0, import_fs19.existsSync)(tasksDir)) taskDirs.push(tasksDir);
  const orgsDir = (0, import_path19.join)(ctxRoot, "orgs");
  if ((0, import_fs19.existsSync)(orgsDir)) {
    try {
      for (const orgEntry of (0, import_fs19.readdirSync)(orgsDir, { withFileTypes: true })) {
        if (orgEntry.isDirectory()) {
          const orgTasks = (0, import_path19.join)(orgsDir, orgEntry.name, "tasks");
          if ((0, import_fs19.existsSync)(orgTasks)) taskDirs.push(orgTasks);
        }
      }
    } catch {
    }
  }
  for (const agent of agentNames) {
    let completed = 0, pending = 0, inProgress = 0;
    for (const taskDir of taskDirs) {
      try {
        for (const file of (0, import_fs19.readdirSync)(taskDir)) {
          if (!file.endsWith(".json")) continue;
          try {
            const task = JSON.parse((0, import_fs19.readFileSync)((0, import_path19.join)(taskDir, file), "utf-8"));
            if (task.assigned_to !== agent) continue;
            switch (task.status) {
              case "completed":
                completed++;
                break;
              case "pending":
                pending++;
                break;
              case "in_progress":
                inProgress++;
                break;
            }
          } catch {
          }
        }
      } catch {
      }
    }
    totalCompleted += completed;
    let errorsToday = 0;
    const eventPaths = [
      (0, import_path19.join)(ctxRoot, "analytics", "events", agent, `${today}.jsonl`)
    ];
    if (org) {
      eventPaths.push((0, import_path19.join)(ctxRoot, "orgs", org, "analytics", "events", agent, `${today}.jsonl`));
    }
    for (const eventFile of eventPaths) {
      if ((0, import_fs19.existsSync)(eventFile)) {
        try {
          const lines = (0, import_fs19.readFileSync)(eventFile, "utf-8").split("\n").filter(Boolean);
          errorsToday += lines.filter((l) => l.includes('"category":"error"')).length;
        } catch {
        }
      }
    }
    let heartbeatStale = true;
    const hbFile = (0, import_path19.join)(ctxRoot, "state", agent, "heartbeat.json");
    if ((0, import_fs19.existsSync)(hbFile)) {
      try {
        const hb = JSON.parse((0, import_fs19.readFileSync)(hbFile, "utf-8"));
        if (hb.last_heartbeat) {
          const hbTime = new Date(hb.last_heartbeat).getTime();
          const age = Date.now() - hbTime;
          if (age < 5 * 60 * 60 * 1e3) {
            heartbeatStale = false;
            agentsHealthy++;
          }
        }
      } catch {
      }
    }
    agents[agent] = {
      tasks_completed: completed,
      tasks_pending: pending,
      tasks_in_progress: inProgress,
      errors_today: errorsToday,
      heartbeat_stale: heartbeatStale
    };
  }
  let approvalsPending = 0;
  const approvalPaths = [(0, import_path19.join)(ctxRoot, "approvals", "pending")];
  if ((0, import_fs19.existsSync)(orgsDir)) {
    try {
      for (const orgEntry of (0, import_fs19.readdirSync)(orgsDir, { withFileTypes: true })) {
        if (orgEntry.isDirectory()) {
          const p = (0, import_path19.join)(orgsDir, orgEntry.name, "approvals", "pending");
          if ((0, import_fs19.existsSync)(p)) approvalPaths.push(p);
        }
      }
    } catch {
    }
  }
  for (const apDir of approvalPaths) {
    if ((0, import_fs19.existsSync)(apDir)) {
      try {
        approvalsPending += (0, import_fs19.readdirSync)(apDir).filter((f) => f.endsWith(".json")).length;
      } catch {
      }
    }
  }
  const report = {
    timestamp,
    agents,
    system: {
      total_tasks_completed: totalCompleted,
      agents_healthy: agentsHealthy,
      agents_total: agentsTotal,
      approvals_pending: approvalsPending
    }
  };
  const orgBase = org ? (0, import_path19.join)(ctxRoot, "orgs", org) : ctxRoot;
  const reportsDir = (0, import_path19.join)(orgBase, "analytics", "reports");
  ensureDir(reportsDir);
  (0, import_fs19.writeFileSync)((0, import_path19.join)(reportsDir, "latest.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
  if (org) {
    const systemReports = (0, import_path19.join)(ctxRoot, "analytics", "reports");
    ensureDir(systemReports);
    (0, import_fs19.writeFileSync)((0, import_path19.join)(systemReports, "latest.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
  }
  return report;
}
function parseUsageOutput(output, agentName) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const sessionMatch = output.match(/Current session[\s\S]*?(\d+)%/);
  const sessionPct = sessionMatch ? parseInt(sessionMatch[1], 10) : 0;
  const weekMatch = output.match(/Current week.*all[\s\S]*?(\d+)%/i);
  const weekPct = weekMatch ? parseInt(weekMatch[1], 10) : 0;
  const sonnetMatch = output.match(/Current week.*Sonnet[\s\S]*?(\d+)%/i);
  const sonnetPct = sonnetMatch ? parseInt(sonnetMatch[1], 10) : 0;
  const sessionResetMatch = output.match(/Current session[\s\S]*?Resets\s+(.*)/);
  const sessionReset = sessionResetMatch ? sessionResetMatch[1].trim() : "";
  const weekResetMatch = output.match(/Current week.*all[\s\S]*?Resets\s+(.*)/i);
  const weekReset = weekResetMatch ? weekResetMatch[1].trim() : "";
  return {
    agent: agentName,
    timestamp,
    session: { used_pct: sessionPct, resets: sessionReset },
    week_all_models: { used_pct: weekPct, resets: weekReset },
    week_sonnet: { used_pct: sonnetPct }
  };
}
function storeUsageData(ctxRoot, data) {
  const usageDir2 = (0, import_path19.join)(ctxRoot, "state", "usage");
  ensureDir(usageDir2);
  (0, import_fs19.writeFileSync)((0, import_path19.join)(usageDir2, "latest.json"), JSON.stringify(data, null, 2) + "\n", "utf-8");
  const today = data.timestamp.split("T")[0];
  const dailyPath = (0, import_path19.join)(usageDir2, `${today}.jsonl`);
  const line = JSON.stringify(data) + "\n";
  try {
    (0, import_fs19.appendFileSync)(dailyPath, line, "utf-8");
  } catch {
    (0, import_fs19.writeFileSync)(dailyPath, line, "utf-8");
  }
}
function checkUpstream(frameworkRoot, options = {}) {
  const execOpts = { cwd: frameworkRoot, encoding: "utf-8", timeout: 3e4 };
  try {
    (0, import_child_process5.execSync)("git rev-parse --is-inside-work-tree", { ...execOpts, stdio: "pipe" });
  } catch {
    return { status: "error", error: "not a git repository" };
  }
  try {
    (0, import_child_process5.execSync)("git remote get-url upstream", { ...execOpts, stdio: "pipe" });
  } catch {
    return { status: "error", error: "no upstream remote configured", hint: "Run: git remote add upstream <canonical-repo-url>" };
  }
  try {
    (0, import_child_process5.execSync)("git fetch upstream main", { ...execOpts, stdio: "pipe" });
  } catch {
    return { status: "error", error: "failed to fetch upstream", hint: "Check network and repo access" };
  }
  let localHead, upstreamHead;
  try {
    localHead = (0, import_child_process5.execSync)("git rev-parse HEAD", { ...execOpts, stdio: "pipe" }).trim();
    upstreamHead = (0, import_child_process5.execSync)("git rev-parse upstream/main", { ...execOpts, stdio: "pipe" }).trim();
  } catch {
    return { status: "error", error: "failed to resolve HEAD or upstream/main" };
  }
  if (localHead === upstreamHead) {
    return { status: "up_to_date", message: "No upstream changes available" };
  }
  let commitCount = 0;
  try {
    commitCount = parseInt((0, import_child_process5.execSync)("git rev-list HEAD..upstream/main --count", { ...execOpts, stdio: "pipe" }).trim(), 10);
  } catch {
  }
  let diffStat = "";
  try {
    const stat = (0, import_child_process5.execSync)("git diff HEAD..upstream/main --stat", { ...execOpts, stdio: "pipe" });
    const lines = stat.trim().split("\n");
    diffStat = lines[lines.length - 1] || "";
  } catch {
  }
  let changedFiles = [];
  try {
    changedFiles = (0, import_child_process5.execSync)("git diff HEAD..upstream/main --name-only", { ...execOpts, stdio: "pipe" }).trim().split("\n").filter(Boolean);
  } catch {
  }
  const changes = {
    bus: [],
    scripts: [],
    templates: [],
    skills: [],
    community: [],
    other: []
  };
  for (const file of changedFiles) {
    if (file.startsWith("bus/")) changes.bus.push(file);
    else if (file.startsWith("scripts/")) changes.scripts.push(file);
    else if (file.startsWith("templates/")) changes.templates.push(file);
    else if (file.startsWith("skills/")) changes.skills.push(file);
    else if (file.startsWith("community/")) changes.community.push(file);
    else changes.other.push(file);
  }
  let commitLog = "";
  try {
    commitLog = (0, import_child_process5.execSync)("git log HEAD..upstream/main --oneline", { ...execOpts, stdio: "pipe" }).trim();
  } catch {
  }
  function getCatalogItems(source) {
    try {
      let raw;
      if (source === "upstream") {
        raw = (0, import_child_process5.execSync)("git show upstream/main:community/catalog.json", { ...execOpts, stdio: "pipe" });
      } else {
        const localPath = (0, import_path19.join)(frameworkRoot, "community", "catalog.json");
        if (!(0, import_fs19.existsSync)(localPath)) return [];
        raw = (0, import_fs19.readFileSync)(localPath, "utf-8");
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  }
  if (options.apply) {
    if (process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE !== "yes") {
      return {
        status: "error",
        error: "Refusing to auto-merge upstream. Review the diff first (run without --apply), then re-run with CORTEXTOS_CONFIRM_UPSTREAM_MERGE=yes if you trust the changes."
      };
    }
    const localItems2 = getCatalogItems("local");
    const localNames2 = new Set(localItems2.map((i) => i.name));
    try {
      (0, import_child_process5.execSync)("git merge upstream/main --no-edit", { ...execOpts, stdio: "pipe" });
      const mergedItems = getCatalogItems("local");
      const catalog_additions2 = mergedItems.filter((i) => !localNames2.has(i.name));
      return {
        status: "merged",
        commits: commitCount,
        message: "Upstream changes applied successfully",
        ...catalog_additions2.length > 0 ? { catalog_additions: catalog_additions2 } : {}
      };
    } catch {
      try {
        (0, import_child_process5.execSync)("git merge --abort", { ...execOpts, stdio: "pipe" });
      } catch {
      }
      return { status: "conflict", message: "Merge conflicts detected. Resolve conversationally with user." };
    }
  }
  const localItems = getCatalogItems("local");
  const localNames = new Set(localItems.map((i) => i.name));
  const upstreamItems = getCatalogItems("upstream");
  const catalog_additions = upstreamItems.filter((i) => !localNames.has(i.name));
  return {
    status: "updates_available",
    commits: commitCount,
    diff_stat: diffStat,
    commit_log: commitLog,
    changes,
    ...catalog_additions.length > 0 ? { catalog_additions } : {}
  };
}
function collectTelegramCommands(scanDirs) {
  const seen = /* @__PURE__ */ new Set();
  const commands = [];
  for (const dir of scanDirs) {
    if (!(0, import_fs19.existsSync)(dir)) continue;
    const skillFiles = collectSkillFiles(dir);
    for (const file of skillFiles) {
      const parsed = parseSkillFrontmatter(file);
      if (!parsed) continue;
      if (parsed.userInvocable === false) continue;
      let name = parsed.name || deriveNameFromPath(file);
      if (!name) continue;
      const cmd = sanitizeCommand(name);
      if (!cmd || seen.has(cmd)) continue;
      seen.add(cmd);
      const description = (parsed.description || `Skill: ${name}`).slice(0, 256);
      commands.push({ command: cmd, description });
    }
  }
  return commands;
}
async function registerTelegramCommands(botToken, commands) {
  if (commands.length === 0) {
    return { status: "empty", count: 0, commands: [], error: "No commands found to register" };
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands, scope: { type: "all_private_chats" } })
    });
    const data = await response.json();
    if (data.ok) {
      return { status: "ok", count: commands.length, commands };
    } else {
      return { status: "error", count: 0, commands, error: data.description || "Failed to register commands with Telegram" };
    }
  } catch (err) {
    return { status: "error", count: 0, commands, error: String(err) };
  }
}
function collectSkillFiles(dir) {
  const files = [];
  const cmdDir = (0, import_path19.join)(dir, ".claude", "commands");
  if ((0, import_fs19.existsSync)(cmdDir)) {
    try {
      for (const f of (0, import_fs19.readdirSync)(cmdDir)) {
        if (f.endsWith(".md")) files.push((0, import_path19.join)(cmdDir, f));
      }
    } catch {
    }
  }
  const claudeSkillsDir = (0, import_path19.join)(dir, ".claude", "skills");
  if ((0, import_fs19.existsSync)(claudeSkillsDir)) {
    try {
      for (const entry of (0, import_fs19.readdirSync)(claudeSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = (0, import_path19.join)(claudeSkillsDir, entry.name, "SKILL.md");
          if ((0, import_fs19.existsSync)(skillFile)) files.push(skillFile);
        }
      }
    } catch {
    }
  }
  const skillsDir = (0, import_path19.join)(dir, "skills");
  if ((0, import_fs19.existsSync)(skillsDir)) {
    try {
      for (const entry of (0, import_fs19.readdirSync)(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = (0, import_path19.join)(skillsDir, entry.name, "SKILL.md");
          if ((0, import_fs19.existsSync)(skillFile)) files.push(skillFile);
        }
      }
    } catch {
    }
  }
  return files;
}
function parseSkillFrontmatter(filePath) {
  try {
    const content = (0, import_fs19.readFileSync)(filePath, "utf-8");
    const lines = content.split("\n");
    let inFrontmatter = false;
    let name;
    let description;
    let userInvocable;
    let readingMultiline = "";
    let multilineValue = "";
    for (const line of lines) {
      if (line.trim() === "---") {
        if (inFrontmatter) {
          if (readingMultiline === "description") description = multilineValue.trim();
          else if (readingMultiline === "name") name = multilineValue.trim();
          break;
        }
        inFrontmatter = true;
        continue;
      }
      if (!inFrontmatter) continue;
      if (readingMultiline && /^\s/.test(line)) {
        multilineValue += " " + line.trim();
        continue;
      } else if (readingMultiline) {
        if (readingMultiline === "description") description = multilineValue.trim();
        else if (readingMultiline === "name") name = multilineValue.trim();
        readingMultiline = "";
        multilineValue = "";
      }
      const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
      if (nameMatch) {
        name = nameMatch[1];
        continue;
      }
      const descMatch = line.match(/^description:\s*(.+)$/);
      if (descMatch) {
        const val = descMatch[1].trim().replace(/^["']|["']$/g, "");
        if (/^[>|]-?$/.test(val)) {
          readingMultiline = "description";
          multilineValue = "";
        } else {
          description = val;
        }
        continue;
      }
      const invMatch = line.match(/^user-invocable:\s*(.+)$/);
      if (invMatch) {
        userInvocable = invMatch[1].trim() !== "false";
      }
    }
    return { name, description, userInvocable };
  } catch {
    return null;
  }
}
function deriveNameFromPath(filePath) {
  const base = (0, import_path19.basename)(filePath);
  if (base === "SKILL.md") {
    return (0, import_path19.basename)((0, import_path19.dirname)(filePath));
  }
  return base.replace(/\.md$/, "");
}
function sanitizeCommand(name) {
  return name.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 32);
}

// src/cli/bus.ts
init_approval();

// src/bus/reminders.ts
init_cjs_shims();
var import_fs21 = require("fs");
var import_path21 = require("path");
var import_crypto4 = require("crypto");
init_atomic();
function remindersPath(paths) {
  return (0, import_path21.join)(paths.stateDir, "pending-reminders.json");
}
function readReminders(paths) {
  const filePath = remindersPath(paths);
  if (!(0, import_fs21.existsSync)(filePath)) return [];
  try {
    const raw = (0, import_fs21.readFileSync)(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeReminders(paths, reminders) {
  ensureDir(paths.stateDir);
  (0, import_fs21.writeFileSync)(remindersPath(paths), JSON.stringify(reminders, null, 2) + "\n", "utf-8");
}
function createReminder(paths, fireAt, prompt) {
  const ts = Date.parse(fireAt);
  if (isNaN(ts)) {
    throw new Error(`Invalid fire_at date: "${fireAt}". Use ISO 8601 format, e.g. 2026-04-05T08:00:00Z`);
  }
  const id = `${Date.now()}-reminder-${(0, import_crypto4.randomBytes)(3).toString("hex")}`;
  const reminder = {
    id,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    fire_at: new Date(ts).toISOString(),
    prompt,
    status: "pending"
  };
  const reminders = readReminders(paths);
  reminders.push(reminder);
  writeReminders(paths, reminders);
  return reminder;
}
function listReminders(paths, opts = {}) {
  const reminders = readReminders(paths);
  if (opts.all) return reminders;
  return reminders.filter((r) => r.status === "pending");
}
function ackReminder(paths, id) {
  const reminders = readReminders(paths);
  const idx = reminders.findIndex((r) => r.id === id);
  if (idx === -1) {
    throw new Error(`Reminder ${id} not found`);
  }
  reminders[idx] = {
    ...reminders[idx],
    status: "acked",
    acked_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeReminders(paths, reminders);
}
function pruneReminders(paths, retainDays = 7) {
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1e3;
  const reminders = readReminders(paths);
  const kept = reminders.filter((r) => {
    if (r.status !== "acked") return true;
    const ackedAt = r.acked_at ? Date.parse(r.acked_at) : 0;
    return ackedAt > cutoff;
  });
  const pruned = reminders.length - kept.length;
  if (pruned > 0) writeReminders(paths, kept);
  return pruned;
}

// src/bus/cron-state.ts
init_cjs_shims();
var import_fs22 = require("fs");
var import_path22 = require("path");
init_atomic();
function cronStatePath(stateDir) {
  return (0, import_path22.join)(stateDir, "cron-state.json");
}
function readCronState(stateDir) {
  const filePath = cronStatePath(stateDir);
  if (!(0, import_fs22.existsSync)(filePath)) {
    return { updated_at: (/* @__PURE__ */ new Date()).toISOString(), crons: [] };
  }
  try {
    const raw = (0, import_fs22.readFileSync)(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.crons) ? parsed : { updated_at: (/* @__PURE__ */ new Date()).toISOString(), crons: [] };
  } catch {
    return { updated_at: (/* @__PURE__ */ new Date()).toISOString(), crons: [] };
  }
}
function updateCronFire(stateDir, cronName, interval) {
  ensureDir(stateDir);
  const state = readCronState(stateDir);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const idx = state.crons.findIndex((r) => r.name === cronName);
  const record = { name: cronName, last_fire: now, ...interval ? { interval } : {} };
  if (idx === -1) {
    state.crons.push(record);
  } else {
    state.crons[idx] = record;
  }
  state.updated_at = now;
  (0, import_fs22.writeFileSync)(cronStatePath(stateDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// src/bus/knowledge-base.ts
init_cjs_shims();
var import_child_process6 = require("child_process");
var import_fs24 = require("fs");
var import_path24 = require("path");
var import_os8 = require("os");

// src/utils/org.ts
init_cjs_shims();
var import_fs23 = require("fs");
var import_path23 = require("path");
function normalizeOrgName(frameworkRoot, org) {
  if (!org) return org;
  const orgsDir = (0, import_path23.join)(frameworkRoot, "orgs");
  let entries;
  try {
    entries = (0, import_fs23.readdirSync)(orgsDir);
  } catch {
    return org;
  }
  if (entries.includes(org)) {
    try {
      if ((0, import_fs23.statSync)((0, import_path23.join)(orgsDir, org)).isDirectory()) return org;
    } catch {
    }
  }
  const orgLower = org.toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase() === orgLower) {
      try {
        if ((0, import_fs23.statSync)((0, import_path23.join)(orgsDir, entry)).isDirectory()) return entry;
      } catch {
      }
    }
  }
  return org;
}

// src/bus/knowledge-base.ts
function getVenvPython(frameworkRoot) {
  const isWin = process.platform === "win32";
  const venvBin = isWin ? "Scripts" : "bin";
  const pythonExe = isWin ? "python.exe" : "python3";
  return (0, import_path24.join)(frameworkRoot, "knowledge-base", "venv", venvBin, pythonExe);
}
function loadSecretsEnv(frameworkRoot, org) {
  const secretsPath = (0, import_path24.join)(frameworkRoot, "orgs", org, "secrets.env");
  const dotenvPath = (0, import_path24.join)(frameworkRoot, ".env");
  const vars = {};
  for (const p of [dotenvPath, secretsPath]) {
    if ((0, import_fs24.existsSync)(p)) {
      for (const line of (0, import_fs24.readFileSync)(p, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
            val = val.slice(1, -1);
          }
          vars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  return vars;
}
function kbConfigured(env) {
  return (0, import_fs24.existsSync)(env.MMRAG_CONFIG);
}
function buildKBEnv(frameworkRoot, org, instanceId, agent) {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = (0, import_path24.join)((0, import_os8.homedir)(), ".cortextos", instanceId, "orgs", canonicalOrg, "knowledge-base");
  const secrets = loadSecretsEnv(frameworkRoot, canonicalOrg);
  return {
    ...process.env,
    ...secrets,
    CTX_ORG: canonicalOrg,
    CTX_AGENT_NAME: agent || "",
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: (0, import_path24.join)(kbRoot, "chromadb"),
    MMRAG_CONFIG: (0, import_path24.join)(kbRoot, "config.json")
  };
}
function queryKnowledgeBase(paths, question, options) {
  const { agent, scope = "all", topK = 5, threshold = 0.5, frameworkRoot, instanceId } = options;
  const org = normalizeOrgName(frameworkRoot, options.org);
  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Returning empty results \u2014 run setup to enable.`
    );
    return { results: [], total: 0, query: question, collection: `shared-${org}` };
  }
  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = (0, import_path24.join)(frameworkRoot, "knowledge-base", "scripts", "mmrag.py");
  const collections = [];
  switch (scope) {
    case "shared":
      collections.push(`shared-${org}`);
      break;
    case "private":
      collections.push(agent ? `agent-${agent}` : `shared-${org}`);
      break;
    case "all":
      collections.push(`shared-${org}`);
      if (agent) collections.push(`agent-${agent}`);
      break;
  }
  const runQuery = (col) => {
    try {
      return (0, import_child_process6.execFileSync)(pythonPath, [
        mmragPath,
        "query",
        question,
        "--collection",
        col,
        "--top-k",
        String(topK),
        "--threshold",
        String(threshold),
        "--json"
      ], {
        encoding: "utf-8",
        timeout: 3e4,
        env
      });
    } catch {
      return null;
    }
  };
  const parseOutput = (output) => {
    if (!output) return [];
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf("{");
    if (jsonStart === -1) return [];
    try {
      const raw = JSON.parse(trimmed.slice(jsonStart));
      return (raw.results || []).map((r) => ({
        content: r.content || r.result || "",
        source_file: r.source || "",
        org,
        agent_name: agent,
        score: r.similarity ?? 0,
        doc_type: r.type || "markdown"
      }));
    } catch {
      return [];
    }
  };
  try {
    let allResults = [];
    let lastCollection = `shared-${org}`;
    for (const col of collections) {
      const output = runQuery(col);
      allResults = allResults.concat(parseOutput(output));
      lastCollection = col;
    }
    if (allResults.length > 0) {
      return {
        results: allResults,
        total: allResults.length,
        query: question,
        collection: collections.length === 1 ? lastCollection : `shared-${org}`
      };
    }
  } catch {
  }
  return { results: [], total: 0, query: question, collection: `shared-${org}` };
}
function ingestKnowledgeBase(paths, options) {
  const { agent, scope = "shared", force, frameworkRoot, instanceId } = options;
  const org = normalizeOrgName(frameworkRoot, options.org);
  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping ingest \u2014 run setup to enable (see HEARTBEAT.md step 10 for the config path).`
    );
    return;
  }
  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = (0, import_path24.join)(frameworkRoot, "knowledge-base", "scripts", "mmrag.py");
  let collection;
  if (scope === "private") {
    if (!agent) throw new Error("--agent or CTX_AGENT_NAME required for --scope private");
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }
  const kbRoot = (0, import_path24.join)((0, import_os8.homedir)(), ".cortextos", instanceId, "orgs", org, "knowledge-base");
  const chromaDir = (0, import_path24.join)(kbRoot, "chromadb");
  if (!(0, import_fs24.existsSync)(chromaDir)) {
    (0, import_fs24.mkdirSync)(chromaDir, { recursive: true });
  }
  console.log(`Ingesting into collection: ${collection}`);
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }
  const args = [mmragPath, "ingest", ...paths, "--collection", collection];
  if (force) args.push("--force");
  (0, import_child_process6.execFileSync)(pythonPath, args, {
    encoding: "utf-8",
    timeout: 12e4,
    env,
    stdio: "inherit"
  });
  console.log(`
Ingest complete \u2192 collection: ${collection}`);
}
function ensureKBDirs(instanceId, frameworkRoot, org) {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = (0, import_path24.join)((0, import_os8.homedir)(), ".cortextos", instanceId, "orgs", canonicalOrg, "knowledge-base");
  const chromaDir = (0, import_path24.join)(kbRoot, "chromadb");
  if (!(0, import_fs24.existsSync)(chromaDir)) {
    (0, import_fs24.mkdirSync)(chromaDir, { recursive: true });
  }
}

// src/bus/oauth.ts
init_cjs_shims();
var import_fs25 = require("fs");
var import_path25 = require("path");
init_atomic();
var CACHE_TTL_MS = 3 * 60 * 1e3;
var ROTATION_LOG_MAX = 50;
var THRESHOLD_5H = 0.85;
var THRESHOLD_7D = 0.8;
var ALERT_5H = 0.8;
var ALERT_7D = 0.7;
function oauthDir(ctxRoot) {
  return (0, import_path25.join)(ctxRoot, "state", "oauth");
}
function accountsPath(ctxRoot) {
  return (0, import_path25.join)(oauthDir(ctxRoot), "accounts.json");
}
function usageDir(ctxRoot) {
  return (0, import_path25.join)(ctxRoot, "state", "usage");
}
function usageCachePath(ctxRoot) {
  return (0, import_path25.join)(usageDir(ctxRoot), "cache.json");
}
function usageLatestPath(ctxRoot) {
  return (0, import_path25.join)(usageDir(ctxRoot), "latest.json");
}
function usageDailyPath(ctxRoot) {
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  return (0, import_path25.join)(usageDir(ctxRoot), `${today}.jsonl`);
}
function loadAccounts(ctxRoot) {
  const path = accountsPath(ctxRoot);
  if (!(0, import_fs25.existsSync)(path)) return null;
  try {
    return JSON.parse((0, import_fs25.readFileSync)(path, "utf-8"));
  } catch {
    return null;
  }
}
function saveAccounts(ctxRoot, store) {
  ensureDir(oauthDir(ctxRoot));
  const path = accountsPath(ctxRoot);
  atomicWriteSync(path, JSON.stringify(store, null, 2));
  try {
    (0, import_fs25.chmodSync)(path, 384);
  } catch {
  }
}
function getActiveAccount(ctxRoot) {
  const store = loadAccounts(ctxRoot);
  if (!store) return null;
  const account = store.accounts[store.active];
  if (!account) return null;
  return { name: store.active, account };
}
function loadCache(ctxRoot) {
  const path = usageCachePath(ctxRoot);
  if (!(0, import_fs25.existsSync)(path)) return null;
  try {
    const cache = JSON.parse((0, import_fs25.readFileSync)(path, "utf-8"));
    return cache;
  } catch {
    return null;
  }
}
function saveCache(ctxRoot, snapshot) {
  ensureDir(usageDir(ctxRoot));
  const cache = {
    snapshot,
    expires_at: Date.now() + CACHE_TTL_MS
  };
  atomicWriteSync(usageCachePath(ctxRoot), JSON.stringify(cache, null, 2));
  atomicWriteSync(usageLatestPath(ctxRoot), JSON.stringify(snapshot, null, 2));
  const { appendFileSync: appendFileSync7 } = require("fs");
  try {
    appendFileSync7(usageDailyPath(ctxRoot), JSON.stringify(snapshot) + "\n");
  } catch {
  }
}
async function checkUsageApi(ctxRoot, opts = {}) {
  if (!opts.force) {
    const cache = loadCache(ctxRoot);
    if (cache && cache.expires_at > Date.now()) {
      return { ...cache.snapshot, cached: true };
    }
  }
  let accessToken;
  let accountName;
  if (opts.account) {
    const store2 = loadAccounts(ctxRoot);
    const acct = store2?.accounts[opts.account];
    if (!acct) throw new Error(`Account "${opts.account}" not found in accounts.json`);
    accessToken = acct.access_token;
    accountName = opts.account;
  } else {
    const active = getActiveAccount(ctxRoot);
    if (active) {
      accessToken = active.account.access_token;
      accountName = active.name;
    } else {
      accessToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      accountName = "env";
      if (!accessToken) throw new Error("No OAuth token available (no accounts.json and CLAUDE_CODE_OAUTH_TOKEN not set)");
    }
  }
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20"
    }
  });
  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  const normalize = (v) => {
    if (v === void 0) return 0;
    return v > 1 ? v / 100 : v;
  };
  const fiveHour = normalize(data.five_hour_utilization ?? data.fiveHourUtilization);
  const sevenDay = normalize(data.seven_day_utilization ?? data.sevenDayUtilization);
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  const snapshot = {
    account: accountName,
    five_hour_utilization: fiveHour,
    seven_day_utilization: sevenDay,
    fetched_at: fetchedAt
  };
  saveCache(ctxRoot, snapshot);
  const store = loadAccounts(ctxRoot);
  if (store && store.accounts[accountName]) {
    store.accounts[accountName].five_hour_utilization = fiveHour;
    store.accounts[accountName].seven_day_utilization = sevenDay;
    saveAccounts(ctxRoot, store);
  }
  return { ...snapshot, cached: false };
}
async function refreshOAuthToken(ctxRoot, accountName) {
  const store = loadAccounts(ctxRoot);
  if (!store) throw new Error("No accounts.json found. Cannot refresh.");
  const name = accountName || store.active;
  const account = store.accounts[name];
  if (!account) throw new Error(`Account "${name}" not found in accounts.json`);
  if (!account.refresh_token) throw new Error(`Account "${name}" has no refresh_token`);
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: account.refresh_token
    })
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }
  const tokens = await response.json();
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Token refresh response missing access_token or refresh_token");
  }
  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1e3;
  store.accounts[name] = {
    ...account,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    last_refreshed: (/* @__PURE__ */ new Date()).toISOString()
  };
  saveAccounts(ctxRoot, store);
  return { account: name, expires_at: expiresAt };
}
async function rotateOAuth(ctxRoot, frameworkRoot, org, opts = {}) {
  const store = loadAccounts(ctxRoot);
  if (!store) return { rotated: false, reason: "No accounts.json found" };
  const currentName = store.active;
  const current = store.accounts[currentName];
  if (!current) return { rotated: false, reason: `Active account "${currentName}" not found` };
  const needsRotation = opts.force || current.five_hour_utilization >= THRESHOLD_5H || current.seven_day_utilization >= THRESHOLD_7D;
  if (!needsRotation) {
    return {
      rotated: false,
      reason: `Utilization within limits (5h: ${pct(current.five_hour_utilization)}, 7d: ${pct(current.seven_day_utilization)})`
    };
  }
  const candidates = Object.entries(store.accounts).filter(([name]) => name !== currentName).sort(([, a], [, b]) => a.five_hour_utilization - b.five_hour_utilization);
  if (candidates.length === 0) {
    return { rotated: false, reason: "No alternate accounts available for rotation" };
  }
  let [nextName, nextAccount] = candidates[0];
  if (nextAccount.expires_at - Date.now() < 2 * 60 * 60 * 1e3) {
    await refreshOAuthToken(ctxRoot, nextName);
    const refreshed = loadAccounts(ctxRoot);
    nextAccount = refreshed.accounts[nextName];
  }
  let preflight;
  try {
    preflight = await checkUsageApi(ctxRoot, { force: true, account: nextName });
  } catch (err) {
    return {
      rotated: false,
      reason: `Preflight failed for account "${nextName}": ${err}`
    };
  }
  const reloaded = loadAccounts(ctxRoot);
  reloaded.active = nextName;
  reloaded.accounts[nextName].five_hour_utilization = preflight.five_hour_utilization;
  reloaded.accounts[nextName].seven_day_utilization = preflight.seven_day_utilization;
  const logEntry = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    from: currentName,
    to: nextName,
    reason: opts.reason || buildRotationReason(current),
    five_hour_util: current.five_hour_utilization,
    seven_day_util: current.seven_day_utilization
  };
  reloaded.rotation_log = [logEntry, ...reloaded.rotation_log].slice(0, ROTATION_LOG_MAX);
  saveAccounts(ctxRoot, reloaded);
  const finalStore = loadAccounts(ctxRoot);
  const newToken = finalStore.accounts[nextName].access_token;
  writeTokenToAgents(frameworkRoot, org, newToken, opts.agent);
  return {
    rotated: true,
    reason: logEntry.reason,
    from: currentName,
    to: nextName
  };
}
function buildRotationReason(account) {
  if (account.five_hour_utilization >= THRESHOLD_5H) {
    return `5h utilization at ${pct(account.five_hour_utilization)} (threshold: ${pct(THRESHOLD_5H)})`;
  }
  return `7d utilization at ${pct(account.seven_day_utilization)} (threshold: ${pct(THRESHOLD_7D)})`;
}
function pct(v) {
  return `${Math.round(v * 100)}%`;
}
function writeTokenToAgents(frameworkRoot, org, token, targetAgent) {
  const agentsBase = (0, import_path25.join)(frameworkRoot, "orgs", org, "agents");
  if (!(0, import_fs25.existsSync)(agentsBase)) return;
  const { readdirSync: readdirSync18, writeFileSync: writeFileSync22 } = require("fs");
  let agentNames;
  if (targetAgent) {
    agentNames = [targetAgent];
  } else {
    try {
      agentNames = readdirSync18(agentsBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return;
    }
  }
  for (const name of agentNames) {
    const envPath = (0, import_path25.join)(agentsBase, name, ".env");
    if (!(0, import_fs25.existsSync)(envPath)) continue;
    try {
      let content = (0, import_fs25.readFileSync)(envPath, "utf-8");
      if (content.includes("CLAUDE_CODE_OAUTH_TOKEN=")) {
        content = content.replace(
          /^CLAUDE_CODE_OAUTH_TOKEN=.*$/m,
          `CLAUDE_CODE_OAUTH_TOKEN=${token}`
        );
      } else {
        content = content.trimEnd() + `
CLAUDE_CODE_OAUTH_TOKEN=${token}
`;
      }
      atomicWriteSync(envPath, content);
      try {
        (0, import_fs25.chmodSync)(envPath, 384);
      } catch {
      }
    } catch {
    }
  }
}

// src/utils/env.ts
init_cjs_shims();
var import_fs26 = require("fs");
var import_path26 = require("path");
var import_os9 = require("os");
init_atomic();
init_validate();
function resolveEnv(overrides) {
  let envFile = {};
  const cortextosEnvPath = (0, import_path26.join)(process.cwd(), ".cortextos-env");
  if ((0, import_fs26.existsSync)(cortextosEnvPath)) {
    envFile = parseEnvFile(cortextosEnvPath);
  }
  const instanceId = overrides?.instanceId || process.env.CTX_INSTANCE_ID || envFile.CTX_INSTANCE_ID || "default";
  const ctxRoot = overrides?.ctxRoot || process.env.CTX_ROOT || envFile.CTX_ROOT || (0, import_path26.join)((0, import_os9.homedir)(), ".cortextos", instanceId);
  const frameworkRoot = overrides?.frameworkRoot || process.env.CTX_FRAMEWORK_ROOT || envFile.CTX_FRAMEWORK_ROOT || "";
  const agentName = overrides?.agentName || process.env.CTX_AGENT_NAME || envFile.CTX_AGENT_NAME || (0, import_path26.basename)(process.cwd());
  const org = overrides?.org || process.env.CTX_ORG || envFile.CTX_ORG || "";
  const projectRoot = overrides?.projectRoot || process.env.CTX_PROJECT_ROOT || envFile.CTX_PROJECT_ROOT || "";
  let agentDir = overrides?.agentDir || process.env.CTX_AGENT_DIR || envFile.CTX_AGENT_DIR || "";
  if (!agentDir && org && projectRoot) {
    agentDir = (0, import_path26.join)(projectRoot, "orgs", org, "agents", agentName);
  } else if (!agentDir && projectRoot) {
    agentDir = (0, import_path26.join)(projectRoot, "agents", agentName);
  }
  let timezone = overrides?.timezone || process.env.CTX_TIMEZONE || "";
  let orchestrator = overrides?.orchestrator || process.env.CTX_ORCHESTRATOR || "";
  if ((!timezone || !orchestrator) && org && projectRoot) {
    try {
      const contextPath = (0, import_path26.join)(projectRoot, "orgs", org, "context.json");
      if ((0, import_fs26.existsSync)(contextPath)) {
        const ctx = JSON.parse((0, import_fs26.readFileSync)(contextPath, "utf-8"));
        if (!timezone && ctx.timezone) timezone = ctx.timezone;
        if (!orchestrator && ctx.orchestrator) orchestrator = ctx.orchestrator;
      }
    } catch {
    }
  }
  if (agentName) {
    try {
      validateAgentName(agentName);
    } catch (err) {
      throw new Error(`CTX_AGENT_NAME is invalid: ${err.message}`);
    }
  }
  if (org) {
    if (/[./\\<>|;'"(){}[\] ]/.test(org) || org.includes("..")) {
      throw new Error(`CTX_ORG is invalid: contains unsafe characters`);
    }
  }
  return { instanceId, ctxRoot, frameworkRoot, agentName, agentDir, org, projectRoot, timezone, orchestrator };
}
function parseEnvFile(filePath) {
  const result = {};
  try {
    const content = (0, import_fs26.readFileSync)(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      } else {
        const hashIdx = value.indexOf(" #");
        if (hashIdx >= 0) {
          value = value.slice(0, hashIdx).trim();
        }
      }
      result[key] = value;
    }
  } catch {
  }
  return result;
}

// src/cli/bus.ts
init_api();

// src/telegram/logging.ts
init_cjs_shims();
var import_fs27 = require("fs");
var import_path27 = require("path");
function logOutboundMessage(ctxRoot, agentName, chatId, text, messageId, metadata) {
  const logDir = (0, import_path27.join)(ctxRoot, "logs", agentName);
  (0, import_fs27.mkdirSync)(logDir, { recursive: true });
  const meta = {};
  if (metadata?.parseMode !== void 0) meta.parse_mode = metadata.parseMode;
  const entry = JSON.stringify({
    timestamp: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    agent: agentName,
    chat_id: String(chatId),
    text,
    message_id: messageId,
    ...meta
  });
  (0, import_fs27.appendFileSync)((0, import_path27.join)(logDir, "outbound-messages.jsonl"), entry + "\n", "utf-8");
}
function cacheLastSent(ctxRoot, agentName, chatId, text) {
  const stateDir = (0, import_path27.join)(ctxRoot, "state", agentName);
  (0, import_fs27.mkdirSync)(stateDir, { recursive: true });
  (0, import_fs27.writeFileSync)((0, import_path27.join)(stateDir, `last-telegram-${chatId}.txt`), text, "utf-8");
}

// src/cli/bus.ts
function checkDeliverableRequirement(taskId, frameworkRoot, org, taskDir) {
  const contextPath = (0, import_path28.join)(frameworkRoot, "orgs", org, "context.json");
  if (!(0, import_fs28.existsSync)(contextPath)) return null;
  let ctx;
  try {
    ctx = JSON.parse((0, import_fs28.readFileSync)(contextPath, "utf-8"));
  } catch {
    return null;
  }
  if (!ctx.require_deliverables) return null;
  const taskFile = (0, import_path28.join)(taskDir, `${taskId}.json`);
  if (!(0, import_fs28.existsSync)(taskFile)) return null;
  let task;
  try {
    task = JSON.parse((0, import_fs28.readFileSync)(taskFile, "utf-8"));
  } catch {
    return null;
  }
  if (!task.outputs || task.outputs.length === 0) {
    return `Cannot submit task ${taskId}: require_deliverables is enabled but this task has no file deliverables attached. Use "cortextos bus save-output ${taskId} <file>" to attach a deliverable first.`;
  }
  return null;
}
var busCommand = new import_commander7.Command("bus").description("Bus commands for agent messaging, tasks, and events");
busCommand.command("send-message").argument("<to>", "Target agent").argument("<priority>", "Message priority (urgent, high, normal, low)").argument("<text>", "Message text").argument("[reply-to]", "Reply to message ID (optional positional form)").option("--reply-to <id>", "Reply to message ID").action((to, priority, text, replyToArg, opts) => {
  const effectiveReplyTo = opts.replyTo ?? replyToArg;
  const validPriorities = ["urgent", "high", "normal", "low"];
  if (!validPriorities.includes(priority)) {
    console.error(`Invalid priority '${priority}'. Must be one of: ${validPriorities.join(", ")}`);
    process.exit(1);
  }
  try {
    validateAgentName(to);
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const { existsSync: existsSync33 } = require("fs");
  const { join: join42 } = require("path");
  const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
  const orgsDir = join42(projectRoot, "orgs");
  let agentExists = false;
  if (existsSync33(orgsDir)) {
    const { readdirSync: readdirSync18 } = require("fs");
    try {
      for (const org of readdirSync18(orgsDir)) {
        if (existsSync33(join42(orgsDir, org, "agents", to))) {
          agentExists = true;
          break;
        }
      }
    } catch {
    }
  }
  if (!agentExists) {
    console.error(`Warning: agent '${to}' not found in project. Message will be queued but may never be read.`);
  }
  const msgId = sendMessage(paths, env.agentName, to, priority, text, effectiveReplyTo);
  try {
    logEvent(paths, env.agentName, env.org, "message", "agent_message_sent", "info", JSON.stringify({ to, priority, msg_id: msgId, reply_to: effectiveReplyTo ?? null }));
  } catch {
  }
  console.log(msgId);
});
busCommand.command("check-inbox").action(() => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const messages = checkInbox(paths);
  console.log(JSON.stringify(messages));
});
busCommand.command("ack-inbox").argument("<id>", "Message ID to acknowledge").action((id) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  ackInbox(paths, id);
  try {
    logEvent(paths, env.agentName, env.org, "message", "inbox_ack", "info", JSON.stringify({ msg_id: id }));
  } catch {
  }
  console.log(`ACK'd ${id}`);
});
busCommand.command("create-task").argument("<title>", "Task title").option("--desc <description>", "Task description").option("--assignee <agent>", "Assigned agent").option("--priority <p>", "Priority (urgent, high, normal, low)", "normal").option("--project <name>", "Project name").option("--needs-approval", "Require human approval before execution").option("--blocked-by <ids>", "Comma-separated task IDs that must complete before this task can progress").option("--blocks <ids>", "Comma-separated task IDs that this new task will block (symmetric reverse edge)").action((title, opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const parseList = (raw) => raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const taskId = createTask(paths, env.agentName, env.org, title, {
    description: opts.desc,
    assignee: opts.assignee,
    priority: opts.priority,
    project: opts.project,
    needsApproval: opts.needsApproval ?? false,
    blockedBy: parseList(opts.blockedBy),
    blocks: parseList(opts.blocks)
  });
  console.log(taskId);
  if (opts.assignee && opts.assignee !== env.agentName) {
    const assigneePaths = resolvePaths(opts.assignee, env.instanceId, env.org);
    const desc = opts.desc ? ` \u2014 ${opts.desc.slice(0, 120)}` : "";
    sendMessage(
      assigneePaths,
      env.agentName,
      opts.assignee,
      "normal",
      `Task assigned: [${opts.priority}] ${title}${desc} (id: ${taskId})`
    );
  }
});
busCommand.command("update-task").argument("<id>", "Task ID").argument("<status>", "New status (pending, in_progress, completed, blocked, cancelled)").action((id, status) => {
  const validStatuses = ["pending", "in_progress", "completed", "blocked", "cancelled"];
  if (!validStatuses.includes(status)) {
    console.error(`Invalid status '${status}'. Must be one of: ${validStatuses.join(", ")}`);
    process.exit(1);
  }
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  if ((status === "ready_for_review" || status === "completed") && env.org) {
    const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths.taskDir);
    if (err) {
      console.error(err);
      process.exit(1);
    }
  }
  updateTask(paths, id, status);
  console.log(`Updated ${id} -> ${status}`);
});
busCommand.command("compact-tasks").description("Archive completed tasks older than N days into a per-month archive-YYYY-MM.jsonl and remove them from the active list \u2014 preserves audit logs, skips tasks still needed as blockers").option("--older-than <days>", "Cutoff in days (default: 30)", "30").option("--dry-run", "Report what would be compacted without modifying anything").action((opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const olderThanDays = parseInt(opts.olderThan, 10);
  if (isNaN(olderThanDays) || olderThanDays < 0) {
    console.error("--older-than must be a non-negative integer");
    process.exit(1);
  }
  const report = compactTasks(paths, { olderThanDays, dryRun: opts.dryRun });
  const verb = report.dry_run ? "would compact" : "compacted";
  console.log(`${verb} ${report.archived.length} task${report.archived.length === 1 ? "" : "s"}, skipped ${report.skipped.length}`);
  for (const a of report.archived) console.log(`  \u2713 ${a.id}  ->  ${a.archive_file}`);
  if (report.skipped.length > 0) {
    console.log(`
Skipped (common reasons: within cutoff, still needed as blocker):`);
    for (const s of report.skipped) console.log(`  - ${s.id}  (${s.reason})`);
  }
});
busCommand.command("check-deps").description("Show open dependencies blocking a task \u2014 lists blocked_by entries that are not yet completed").argument("<id>", "Task ID").action((id) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const open = checkTaskDependencies(paths, id);
  if (open.length === 0) {
    console.log(`${id}: no open dependencies \u2014 ready to work`);
    return;
  }
  console.log(`${id} blocked by ${open.length} dependency${open.length === 1 ? "" : "s"}:`);
  for (const d of open) console.log(`  ${d.id}  [${d.status}]`);
});
busCommand.command("task-history").description("Show a task's append-only audit log (every status change, claim, and completion)").argument("<id>", "Task ID").option("--json", "Emit raw JSONL instead of formatted text").action((id, opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const entries = readTaskAudit(paths, id);
  if (entries.length === 0) {
    console.log(`No audit log for task ${id}`);
    return;
  }
  if (opts.json) {
    for (const e of entries) console.log(JSON.stringify(e));
    return;
  }
  console.log(`Audit log for ${id} (${entries.length} entries):`);
  for (const e of entries) {
    const transition = e.from && e.to ? `${e.from} -> ${e.to}` : e.to || "";
    const note = e.note ? ` | ${e.note}` : "";
    console.log(`  ${e.ts}  ${e.event.padEnd(8)}  ${e.agent.padEnd(16)}  ${transition}${note}`);
  }
});
busCommand.command("claim-task").description("Atomically claim a pending task \u2014 marks in_progress + sets assignee in one shot, rejecting if another agent already owns it").argument("<id>", "Task ID").option("--agent <name>", "Agent claiming the task (defaults to CTX_AGENT_NAME)").action((id, opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const agent = opts.agent || env.agentName;
  if (!agent) {
    console.error("ERROR: --agent or CTX_AGENT_NAME required");
    process.exit(1);
  }
  try {
    const task = claimTask(paths, id, agent);
    console.log(`Claimed ${id} -> in_progress (assigned to ${agent})`);
    console.log(`  Title: ${task.title}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
});
busCommand.command("complete-task").argument("<id>", "Task ID").argument("[result]", "Completion result (optional positional form)").option("--result <text>", "Completion result").action((id, resultArg, opts) => {
  const effectiveResult = opts.result ?? resultArg;
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  if (env.org) {
    const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths.taskDir);
    if (err) {
      console.error(err);
      process.exit(1);
    }
  }
  completeTask(paths, id, effectiveResult);
  console.log(`Completed ${id}`);
});
busCommand.command("save-output").description("Copy a file into the per-task deliverables tree and link it to the task as a file output").argument("<task-id>", "Target task ID").argument("<source>", "Source file to save (absolute or relative to cwd)").option("--label <label>", "Human-readable label for the linked output (defaults to filename)").option("--move", "Delete the source file after a successful copy").option("--no-link", "Save file without linking to task.outputs[]").action((taskId, source, opts) => {
  const noLink = opts.link === false;
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  try {
    const result = saveOutput(paths, {
      taskId,
      sourcePath: source,
      label: opts.label,
      move: opts.move ?? false,
      noLink
    });
    console.log(result.targetPath);
    if (result.linked) {
      console.log(`Linked to ${taskId} as [snapshot] ${opts.label ?? result.storedPath}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
});
busCommand.command("list-tasks").option("--agent <name>", "Filter by agent").option("--status <s>", "Filter by status").option("--format <fmt>", "Output format: json or text", "text").option("--respect-deps", "Sort DAG-aware: unblocked tasks first, blocked tasks last").action((opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const tasks = listTasks(paths, {
    agent: opts.agent,
    status: opts.status,
    respectDeps: opts.respectDeps ?? false
  });
  if (opts.format === "json") {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (tasks.length === 0) {
    console.log("  No tasks found.");
    return;
  }
  const PRIORITY_ICON = { urgent: "\u{1F534}", high: "\u{1F7E0}", normal: "\u{1F535}", low: "\u26AA" };
  const STATUS_ICON = { pending: "\u25CB", in_progress: "\u25CF", blocked: "\u25D1", completed: "\u2713", done: "\u2713", cancelled: "\u2717" };
  console.log(`
  Tasks (${tasks.length})
`);
  const header = "  Status  Pri  ID                        Assignee         Title";
  const separator = "  " + "-".repeat(header.length - 2);
  console.log(header);
  console.log(separator);
  for (const t of tasks) {
    const statusIcon = (STATUS_ICON[t.status] || "?").padEnd(8);
    const priIcon = (PRIORITY_ICON[t.priority] || "\xB7").padEnd(5);
    const id = t.id.substring(0, 26).padEnd(26);
    const assignee = (t.assigned_to || "-").substring(0, 16).padEnd(17);
    const title = t.title.substring(0, 50);
    console.log(`  ${statusIcon}${priIcon}${id}${assignee}${title}`);
  }
  console.log("");
});
busCommand.command("log-event").argument("<category>", "Event category").argument("<event>", "Event name").argument("<severity>", "Severity (info, warning, error, critical)").option("--meta <json>", "Metadata JSON string", "{}").action((category, event, severity, opts) => {
  const validCategories = ["action", "error", "metric", "milestone", "heartbeat", "message", "task", "approval"];
  if (!validCategories.includes(category)) {
    console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(", ")}`);
    process.exit(1);
  }
  const validSeverities = ["info", "warning", "error", "critical"];
  if (!validSeverities.includes(severity)) {
    console.error(`Invalid severity '${severity}'. Must be one of: ${validSeverities.join(", ")}`);
    process.exit(1);
  }
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  logEvent(paths, env.agentName, env.org, category, event, severity, opts.meta);
  console.log(`Logged ${category}/${event} (${severity})`);
});
busCommand.command("update-heartbeat").argument("<status>", "Heartbeat status message").option("--task <task>", "Current task description").option("--timezone <tz>", "Timezone for day/night mode detection").option("--interval <i>", "Loop interval from cron config").action((status, opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  let displayName;
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || "";
  if (frameworkRoot) {
    const identityPaths = [
      (0, import_path28.join)(frameworkRoot, "orgs", env.org, "agents", env.agentName, "IDENTITY.md"),
      (0, import_path28.join)(frameworkRoot, "agents", env.agentName, "IDENTITY.md")
    ];
    for (const idPath of identityPaths) {
      if ((0, import_fs28.existsSync)(idPath)) {
        try {
          const lines = (0, import_fs28.readFileSync)(idPath, "utf-8").split("\n");
          const nameIdx = lines.findIndex((l) => l.trim() === "## Name");
          if (nameIdx >= 0) {
            for (let i = nameIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line || line.startsWith("<!--")) continue;
              if (line.startsWith("#")) break;
              displayName = line;
              break;
            }
          }
          if (!displayName) {
            const h1 = lines.find((l) => l.startsWith("# ") && !l.startsWith("## "));
            if (h1) displayName = h1.replace(/^#\s+/, "").trim();
          }
        } catch {
        }
        break;
      }
    }
  }
  updateHeartbeat(paths, env.agentName, status, {
    org: env.org,
    timezone: opts.timezone,
    loopInterval: opts.interval,
    currentTask: opts.task,
    displayName
  });
  try {
    logEvent(paths, env.agentName, env.org, "heartbeat", "heartbeat", "info", JSON.stringify({ status, task: opts.task ?? "" }));
  } catch {
  }
  console.log(`Heartbeat updated: ${env.agentName}`);
});
busCommand.command("read-all-heartbeats").description("Read heartbeat files for all agents in the system").option("--format <fmt>", "Output format: json or text", "text").action((opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const heartbeats = readAllHeartbeats(paths);
  if (opts.format === "json") {
    console.log(JSON.stringify(heartbeats, null, 2));
    return;
  }
  if (heartbeats.length === 0) {
    console.log("No agents found.");
    return;
  }
  for (const hb of heartbeats) {
    const stale = new Date(hb.last_heartbeat) < new Date(Date.now() - 2 * 60 * 60 * 1e3);
    const staleFlag = stale ? " [STALE]" : "";
    const label = hb.display_name ? `${hb.display_name} (${hb.agent})` : hb.agent;
    console.log(`${label} (${hb.org}) \u2014 ${hb.status}${staleFlag} \u2014 last seen ${hb.last_heartbeat}`);
    if (hb.current_task) console.log(`  task: ${hb.current_task}`);
  }
});
busCommand.command("recall-facts").description("Recall recent session facts extracted at compaction time (cross-session memory)").option("--days <n>", "How many days back to scan", "3").option("--format <fmt>", "Output format: text or json", "text").option("--agent <name>", "Agent name (defaults to CTX_AGENT_NAME)").action((opts) => {
  const env = resolveEnv();
  const agentName = opts.agent || env.agentName;
  const daysBack = Math.max(1, Math.min(30, parseInt(opts.days, 10) || 3));
  const factsDir = (0, import_path28.join)(env.ctxRoot, "state", agentName, "memory", "facts");
  const entries = [];
  for (let d = 0; d < daysBack; d++) {
    const date = new Date(Date.now() - d * 24 * 60 * 60 * 1e3);
    const dateStr = date.toISOString().slice(0, 10);
    const factsFile = (0, import_path28.join)(factsDir, `${dateStr}.jsonl`);
    if (!(0, import_fs28.existsSync)(factsFile)) continue;
    try {
      const lines = (0, import_fs28.readFileSync)(factsFile, "utf-8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {
        }
      }
    } catch {
    }
  }
  if (opts.format === "json") {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("No session facts found. Facts are written automatically at context compaction.");
    return;
  }
  console.log(`
  Session Memory \u2014 last ${daysBack} day(s) \u2014 ${entries.length} entries
`);
  for (const e of entries.slice(-10)) {
    const ts = e.ts.replace("T", " ").replace("Z", " UTC").slice(0, 19);
    console.log(`  [${ts}]`);
    const preview = e.summary.slice(0, 400).replace(/\n/g, " ");
    console.log(`  ${preview}${e.summary.length > 400 ? "..." : ""}`);
    if (e.keywords && e.keywords.length > 0) {
      console.log(`  Keywords: ${e.keywords.slice(0, 8).join(", ")}`);
    }
    console.log();
  }
});
busCommand.command("check-stale-tasks").description("Find stale tasks (in_progress >2h, pending >24h, overdue)").action(() => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const report = checkStaleTasks(paths);
  console.log(JSON.stringify(report));
});
busCommand.command("archive-tasks").description("Archive completed tasks older than 7 days").option("--dry-run", "Show what would be archived without modifying files").action((opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const report = archiveTasks(paths, opts.dryRun ?? false);
  console.log(JSON.stringify(report));
});
busCommand.command("check-human-tasks").description("Find stale human-assigned tasks (>24h)").action(() => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const tasks = checkHumanTasks(paths);
  console.log(JSON.stringify(tasks));
});
busCommand.command("self-restart").description("Immediately restart this agent via daemon IPC (same as soft-restart but targets self)").option("--reason <why>", "Reason for restart").action(async (opts) => {
  const { mkdirSync: mkdirSync15, writeFileSync: writeFileSync22 } = require("fs");
  const { join: join42 } = require("path");
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const reason = opts.reason || "self-restart requested";
  const ctxRoot = require("path").join(require("os").homedir(), ".cortextos", env.instanceId);
  const stateDir = join42(ctxRoot, "state", env.agentName);
  mkdirSync15(stateDir, { recursive: true });
  writeFileSync22(join42(stateDir, ".user-restart"), reason);
  selfRestart(paths, env.agentName, reason);
  const ipc = new IPCClient(env.instanceId);
  const daemonRunning = await ipc.isDaemonRunning();
  if (daemonRunning) {
    const resp = await ipc.send({ type: "restart-agent", agent: env.agentName, source: "cortextos bus self-restart" });
    if (resp.success) {
      console.log(`Restarting ${env.agentName} via daemon IPC`);
    } else {
      console.error(`Daemon restart failed: ${resp.error}`);
      process.exit(1);
    }
  } else {
    console.error("ERROR: Node daemon is not running. Start it with: cortextos start");
    process.exit(1);
  }
});
busCommand.command("hard-restart").description("Plan a hard restart (fresh session, no --continue)").option("--reason <why>", "Reason for restart").option("--handoff-doc <path>", "Path to handoff document to inject into next session boot prompt").action(async (opts) => {
  const { writeFileSync: fsWrite, existsSync: fsExists, mkdirSync: fsMkdir } = require("fs");
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  hardRestart(paths, env.agentName, opts.reason);
  if (opts.handoffDoc && fsExists(opts.handoffDoc)) {
    fsMkdir(paths.stateDir, { recursive: true });
    fsWrite((0, import_path28.join)(paths.stateDir, ".handoff-doc-path"), opts.handoffDoc + "\n", "utf-8");
  }
  const ipc = new IPCClient(env.instanceId);
  const daemonRunning = await ipc.isDaemonRunning();
  if (daemonRunning) {
    const resp = await ipc.send({ type: "restart-agent", agent: env.agentName, source: "cortextos bus hard-restart" });
    if (resp.success) {
      console.log(`Hard restart triggered for ${env.agentName} \u2014 fresh session incoming`);
    } else {
      console.error(`Daemon restart failed: ${resp.error}`);
      process.exit(1);
    }
  } else {
    console.log("Hard restart planned (daemon not running \u2014 will take effect on next start)");
  }
});
busCommand.command("auto-commit").description("Stage safe files for commit (never pushes)").option("--dry-run", "Show what would be staged without modifying git").action((opts) => {
  const env = resolveEnv();
  const projectDir = env.projectRoot || env.frameworkRoot || process.cwd();
  const report = autoCommit(projectDir, opts.dryRun ?? false);
  console.log(JSON.stringify(report));
});
busCommand.command("check-goal-staleness").description("Detect agents with stale GOALS.md").option("--threshold <days>", "Staleness threshold in days", "7").action((opts) => {
  const env = resolveEnv();
  const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
  const report = checkGoalStaleness(projectRoot, parseInt(opts.threshold, 10));
  console.log(JSON.stringify(report, null, 2));
});
busCommand.command("post-activity").description("Post a message to the org Telegram activity channel").argument("<message>", "Message to post").action(async (message) => {
  const env = resolveEnv();
  const orgDir = env.agentDir ? env.agentDir.replace(/\/agents\/.*$/, "") : "";
  const success = await postActivity(orgDir, env.ctxRoot, env.org, message);
  if (success) {
    console.log("Activity posted");
  } else {
    console.error("Failed to post activity. Check that ACTIVITY_CHAT_ID is set in your org secrets.env or .env file.");
  }
});
busCommand.command("create-experiment").description("Create a new experiment proposal").argument("<metric>", "Metric to measure").argument("<hypothesis>", "Hypothesis to test").option("--surface <path>", "Surface file path").option("--direction <dir>", "Direction: higher or lower", "higher").option("--window <dur>", "Measurement window", "24h").action(async (metric, hypothesis, opts) => {
  const env = resolveEnv();
  const agentDir = env.agentDir || process.cwd();
  const id = createExperiment(agentDir, env.agentName, metric, hypothesis, {
    surface: opts.surface,
    direction: opts.direction,
    window: opts.window
  });
  console.log(id);
  const config = loadExperimentConfig(agentDir);
  if (config.approval_required) {
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const approvalId = await createApproval(
      paths,
      env.agentName,
      env.org,
      `Run experiment: ${metric} \u2014 ${hypothesis.slice(0, 80)}`,
      "other",
      `Experiment ID: ${id}
Metric: ${metric}
Hypothesis: ${hypothesis}`,
      env.frameworkRoot
    );
    console.log(`approval_required: ${approvalId}`);
  }
});
busCommand.command("run-experiment").description("Start running a proposed experiment").argument("<id>", "Experiment ID").argument("[description]", "Description of changes").action((id, description) => {
  const env = resolveEnv();
  const agentDir = env.agentDir || process.cwd();
  const experiment = runExperiment(agentDir, id, description);
  console.log(JSON.stringify(experiment, null, 2));
});
busCommand.command("evaluate-experiment").description("Evaluate a running experiment with a measured value").argument("<id>", "Experiment ID").argument("<value>", "Measured value").option("--score <n>", "Score 1-10").option("--justification <text>", "Justification text").action((id, value, opts) => {
  const env = resolveEnv();
  const agentDir = env.agentDir || process.cwd();
  const experiment = evaluateExperiment(agentDir, id, parseFloat(value), {
    score: opts.score ? parseInt(opts.score, 10) : void 0,
    justification: opts.justification
  });
  console.log(JSON.stringify(experiment, null, 2));
});
busCommand.command("list-experiments").description("List experiments with optional filters").option("--agent <name>", "Filter by agent").option("--status <s>", "Filter by status").option("--metric <m>", "Filter by metric").option("--json", "Output as JSON").action((opts) => {
  const env = resolveEnv();
  const agentDir = opts.agent && env.frameworkRoot ? (0, import_path28.join)(env.frameworkRoot, "orgs", env.org, "agents", opts.agent) : env.agentDir || process.cwd();
  const experiments = listExperiments(agentDir, {
    agent: opts.agent,
    status: opts.status,
    metric: opts.metric
  });
  console.log(JSON.stringify(experiments, null, 2));
});
busCommand.command("gather-context").description("Gather experiment context for an agent").option("--agent <name>", "Agent name").option("--format <fmt>", "Output format: json or markdown", "json").action((opts) => {
  const env = resolveEnv();
  const agentName = opts.agent || env.agentName;
  const agentDir = opts.agent && env.frameworkRoot ? (0, import_path28.join)(env.frameworkRoot, "orgs", env.org, "agents", opts.agent) : env.agentDir || process.cwd();
  const context = gatherContext(agentDir, agentName, { format: opts.format });
  console.log(JSON.stringify(context, null, 2));
});
busCommand.command("manage-cycle").description("Manage experiment cycles").argument("<action>", "Action: create, modify, remove, list").argument("<agent>", "Agent name").option("--metric <name>", "Metric name").option("--metric-type <type>", "Metric type: quantitative or qualitative").option("--surface <path>", "Surface path (file to experiment on)").option("--direction <dir>", "Direction: higher or lower").option("--window <dur>", "Measurement window (how long before evaluating)").option("--measurement <method>", "How to measure the metric").option("--loop-interval <dur>", "Cron frequency for the experiment loop").option("--enabled <bool>", "Enable or pause the cycle (true/false)").option("--cycle <name>", "Cycle name").action((action, agent, opts) => {
  const env = resolveEnv();
  const agentDir = env.agentDir || process.cwd();
  if (opts.direction && opts.direction !== "higher" && opts.direction !== "lower") {
    console.error(`Invalid --direction '${opts.direction}'. Must be 'higher' or 'lower'`);
    process.exit(1);
  }
  if (opts.metricType && opts.metricType !== "quantitative" && opts.metricType !== "qualitative") {
    console.error(`Invalid --metric-type '${opts.metricType}'. Must be 'quantitative' or 'qualitative'`);
    process.exit(1);
  }
  const cycles = manageCycle(agentDir, action, {
    agent,
    name: opts.cycle,
    metric: opts.metric,
    metric_type: opts.metricType,
    surface: opts.surface,
    direction: opts.direction,
    window: opts.window,
    measurement: opts.measurement,
    loop_interval: opts.loopInterval,
    enabled: opts.enabled !== void 0 ? opts.enabled === "true" : void 0
  });
  console.log(JSON.stringify(cycles, null, 2));
});
busCommand.command("browse-catalog").description("Browse community catalog for items").option("--type <type>", "Filter by type (skill, agent, org)").option("--tag <tag>", "Filter by tag").option("--search <query>", "Search by name or description").action((opts) => {
  const env = resolveEnv();
  const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
  const result = browseCatalog(frameworkRoot, env.ctxRoot, {
    type: opts.type,
    tag: opts.tag,
    search: opts.search
  });
  console.log(JSON.stringify(result, null, 2));
});
busCommand.command("install-community-item").description("Install a community catalog item").argument("<name>", "Item name to install").option("--dry-run", "Show what would be installed without modifying files").action((name, opts) => {
  const env = resolveEnv();
  const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
  const result = installCommunityItem(frameworkRoot, env.ctxRoot, name, {
    dryRun: opts.dryRun,
    agentDir: env.agentDir
  });
  console.log(JSON.stringify(result, null, 2));
});
busCommand.command("prepare-submission").description("Prepare a skill/agent/org for community submission with PII scanning").argument("<type>", "Item type (skill, agent, org)").argument("<source-path>", "Source directory path").argument("<name>", "Item name").option("--dry-run", "Scan without keeping staged files").action((type, sourcePath, name, opts) => {
  const env = resolveEnv();
  const result = prepareSubmission(env.ctxRoot, type, sourcePath, name, {
    dryRun: opts.dryRun
  });
  console.log(JSON.stringify(result, null, 2));
});
busCommand.command("submit-community-item").description("Submit a prepared item to the community catalog").argument("<name>", "Item name").argument("<type>", "Item type (skill, agent, org)").argument("<description>", "Item description").option("--dry-run", "Show what would be submitted").option("--author <author>", "Author name or handle for attribution").option("--contribute", "Create branch, push to origin, and open a PR against upstream").action((name, type, description, opts) => {
  const env = resolveEnv();
  const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
  const result = submitCommunityItem(frameworkRoot, env.ctxRoot, name, type, description, {
    dryRun: opts.dryRun,
    author: opts.author,
    contribute: opts.contribute
  });
  console.log(JSON.stringify(result, null, 2));
});
busCommand.command("collect-metrics").description("Collect and aggregate system metrics across all agents").action(() => {
  const env = resolveEnv();
  const report = collectMetrics(env.ctxRoot, env.org || void 0);
  console.log(JSON.stringify(report, null, 2));
});
busCommand.command("scrape-usage").description("Parse Claude Code /usage output and store usage data").argument("<agent>", "Agent name").argument("<output>", "Usage output text to parse").action((agent, output) => {
  const env = resolveEnv();
  const data = parseUsageOutput(output, agent);
  storeUsageData(env.ctxRoot, data);
  console.log(JSON.stringify(data, null, 2));
});
busCommand.command("check-upstream").description("Check canonical repo for framework updates").option("--apply", "Merge upstream changes (requires user approval)").action((opts) => {
  const env = resolveEnv();
  const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
  const result = checkUpstream(frameworkRoot, { apply: opts.apply });
  console.log(JSON.stringify(result, null, 2));
});
busCommand.command("register-telegram-commands").description("Register skills as Telegram bot commands").argument("<bot-token>", "Telegram bot token").argument("<scan-dirs...>", "Directories to scan for skills").action(async (botToken, scanDirs) => {
  const commands = collectTelegramCommands(scanDirs);
  const result = await registerTelegramCommands(botToken, commands);
  console.log(JSON.stringify(result, null, 2));
});
busCommand.command("send-telegram").description("Send a message to a Telegram chat").argument("<chat-id>", "Telegram chat ID").argument("<message>", "Message text (supports Telegram Markdown unless --plain-text is set)").option("--image <path>", "Send a photo with caption").option("--file <path>", "Send a document/file with caption (any file type)").option("--plain-text", "Skip Telegram Markdown parsing entirely. Use this when the message contains unescaped _, *, backtick, or [ that would otherwise trip the Markdown parser. Without this flag, sendMessage still retries once with parse_mode disabled on a parse-entity error \u2014 so it is purely an opt-in to save the retry roundtrip.", false).action(async (chatId, message, opts) => {
  const env = resolveEnv();
  let botToken = "";
  if (env.agentDir) {
    const { readFileSync: readFileSync33, existsSync: existsSync33 } = require("fs");
    const { join: join42 } = require("path");
    const agentEnv = join42(env.agentDir, ".env");
    if (existsSync33(agentEnv)) {
      const content = readFileSync33(agentEnv, "utf-8");
      const match = content.match(/^BOT_TOKEN=(.+)$/m);
      if (match && match[1].trim()) botToken = match[1].trim();
    }
  }
  if (!botToken) {
    botToken = process.env.BOT_TOKEN || "";
  }
  if (!botToken) {
    console.error("Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.");
    process.exit(1);
  }
  const api = new TelegramAPI(botToken);
  try {
    let sentMessageId = 0;
    if (opts.image) {
      const result = await api.sendPhoto(chatId, opts.image, message);
      sentMessageId = result?.result?.message_id ?? 0;
    } else if (opts.file) {
      const result = await api.sendDocument(chatId, opts.file, message);
      sentMessageId = result?.result?.message_id ?? 0;
    } else {
      const result = await api.sendMessage(chatId, message, void 0, {
        parseMode: opts.plainText ? null : "HTML"
      });
      sentMessageId = result?.result?.message_id ?? 0;
    }
    const env2 = resolveEnv();
    if (env2.agentName && env2.ctxRoot) {
      logOutboundMessage(env2.ctxRoot, env2.agentName, chatId, message, sentMessageId, {
        parseMode: opts.plainText ? "none" : "html"
      });
      cacheLastSent(env2.ctxRoot, env2.agentName, chatId, message);
      try {
        const paths = resolvePaths(env2.agentName, env2.instanceId, env2.org);
        const preview = message.length > 120 ? message.slice(0, 120) + "\u2026" : message;
        logEvent(paths, env2.agentName, env2.org, "message", "telegram_sent", "info", JSON.stringify({ chat_id: chatId, message_id: sentMessageId, preview }));
      } catch {
      }
    }
    console.log("Message sent");
  } catch (err) {
    console.error(`Failed to send: ${err.message || err}`);
    process.exit(1);
  }
});
busCommand.command("create-approval").description("Request human approval for a high-stakes action").argument("<title>", "What you are requesting approval for").argument("<category>", "Category: external-comms, financial, deployment, data-deletion, other").argument("[context]", "Additional context").action(async (title, category, context) => {
  const validCategories = ["external-comms", "financial", "deployment", "data-deletion", "other"];
  if (!validCategories.includes(category)) {
    console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(", ")}`);
    process.exit(1);
  }
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const id = await createApproval(paths, env.agentName, env.org, title, category, context || "", env.frameworkRoot);
  console.log(id);
});
busCommand.command("update-approval").description("Resolve an approval request").argument("<id>", "Approval ID").argument("<status>", "Resolution: approved or denied").argument("[note]", "Resolution note").action((id, status, note) => {
  const validStatuses = ["approved", "rejected"];
  if (!validStatuses.includes(status)) {
    console.error(`Invalid status '${status}'. Must be one of: approved, rejected`);
    process.exit(1);
  }
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  updateApproval(paths, id, status, note);
  console.log(`Approval ${id} -> ${status}`);
});
busCommand.command("kb-query").description("Query the knowledge base (RAG search)").argument("<question>", "Question or search query").option("--org <org>", "Organization name").option("--agent <name>", "Agent name (for private scope)").option("--scope <s>", "Scope: shared, private, or all", "all").option("--top-k <n>", "Number of results", "5").option("--threshold <f>", "Minimum similarity score (0-1)", "0.5").option("--json", "Output raw JSON").action((question, opts) => {
  const env = resolveEnv();
  const org = opts.org || env.org;
  if (!org) {
    console.error("ERROR: --org or CTX_ORG required");
    process.exit(1);
  }
  const result = queryKnowledgeBase(
    resolvePaths(env.agentName, env.instanceId, org),
    question,
    {
      org,
      agent: opts.agent || env.agentName,
      scope: opts.scope || "all",
      topK: parseInt(opts.topK || "5", 10),
      threshold: parseFloat(opts.threshold || "0.5"),
      frameworkRoot: env.frameworkRoot || process.cwd(),
      instanceId: env.instanceId
    }
  );
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.results.length === 0) {
    console.log(`No results found for: "${question}"`);
    return;
  }
  console.log(`
  Knowledge Base Results (${result.results.length}/${result.total})
`);
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    console.log(`  [${i + 1}] Score: ${r.score.toFixed(3)} | ${r.source_file}`);
    console.log(`      ${r.content.substring(0, 200).replace(/\n/g, " ")}...`);
    console.log("");
  }
});
busCommand.command("kb-ingest").description("Ingest files or directories into the knowledge base").argument("<paths...>", "Files or directories to ingest").option("--org <org>", "Organization name").option("--agent <name>", "Agent name (for private scope)").option("--scope <s>", "Scope: shared or private", "shared").option("--force", "Re-ingest even if already indexed").action((paths, opts) => {
  const env = resolveEnv();
  const org = opts.org || env.org;
  if (!org) {
    console.error("ERROR: --org or CTX_ORG required");
    process.exit(1);
  }
  ensureKBDirs(env.instanceId, env.frameworkRoot, org);
  ingestKnowledgeBase(paths, {
    org,
    agent: opts.agent || env.agentName,
    scope: opts.scope || "shared",
    force: opts.force,
    frameworkRoot: env.frameworkRoot || process.cwd(),
    instanceId: env.instanceId
  });
});
busCommand.command("kb-collections").description("List knowledge base collections and document counts").option("--org <org>", "Organization name").action((opts) => {
  const env = resolveEnv();
  const org = opts.org || env.org;
  if (!org) {
    console.error("ERROR: --org or CTX_ORG required");
    process.exit(1);
  }
  const { execFileSync: execFileSync5 } = require("child_process");
  const { existsSync: existsSync33, readFileSync: readFileSync33 } = require("fs");
  const { join: pjoin } = require("path");
  const { homedir: hdir } = require("os");
  const frameworkRoot = env.frameworkRoot || process.cwd();
  const instanceId = env.instanceId;
  const kbRoot = pjoin(hdir(), ".cortextos", instanceId, "orgs", org, "knowledge-base");
  const chromaDir = pjoin(kbRoot, "chromadb");
  const isWin = process.platform === "win32";
  const venvBin = isWin ? "Scripts" : "bin";
  const pythonExe = isWin ? "python.exe" : "python3";
  const pythonPath = pjoin(frameworkRoot, "knowledge-base", "venv", venvBin, pythonExe);
  const mmragPath = pjoin(frameworkRoot, "knowledge-base", "scripts", "mmrag.py");
  const envFiles = [
    pjoin(frameworkRoot, ".env"),
    pjoin(frameworkRoot, "orgs", org, "secrets.env")
  ];
  const extraVars = {};
  for (const ef of envFiles) {
    if (existsSync33(ef)) {
      for (const line of readFileSync33(ef, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
            val = val.slice(1, -1);
          }
          extraVars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  if (!existsSync33(chromaDir)) {
    console.log("No collections found. Run kb-ingest first.");
    process.exit(0);
  }
  const envVars = {
    ...process.env,
    ...extraVars,
    CTX_ORG: org,
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: chromaDir,
    MMRAG_CONFIG: pjoin(kbRoot, "config.json")
  };
  try {
    execFileSync5(pythonPath, [mmragPath, "collections"], {
      stdio: "inherit",
      env: envVars
    });
  } catch {
    process.exit(1);
  }
});
function runHook(hookName) {
  const hookPath = (0, import_path28.join)(__dirname, `hooks/${hookName}.js`);
  const result = (0, import_child_process7.spawnSync)(process.execPath, [hookPath], { stdio: "inherit" });
  process.exit(result.status ?? 0);
}
busCommand.command("edit-message").description("Edit an existing Telegram message text and optionally update inline keyboard").argument("<chat-id>", "Telegram chat ID").argument("<message-id>", "Message ID to edit").argument("<new-text>", "Replacement text (Telegram Markdown)").argument("[reply-markup]", 'Optional JSON inline keyboard markup (pass "null" to clear)').action(async (chatId, messageId, newText, replyMarkup) => {
  const env = resolveEnv();
  let botToken = "";
  if (env.agentDir) {
    const { readFileSync: readFileSync33, existsSync: existsSync33 } = require("fs");
    const agentEnv = require("path").join(env.agentDir, ".env");
    if (existsSync33(agentEnv)) {
      const match = readFileSync33(agentEnv, "utf-8").match(/^BOT_TOKEN=(.+)$/m);
      if (match?.[1]?.trim()) botToken = match[1].trim();
    }
  }
  if (!botToken) botToken = process.env.BOT_TOKEN || "";
  if (!botToken) {
    console.error("Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.");
    process.exit(1);
  }
  const api = new TelegramAPI(botToken);
  let markup;
  if (replyMarkup && replyMarkup !== "null") {
    try {
      markup = JSON.parse(replyMarkup);
    } catch {
      console.error("Invalid reply-markup JSON");
      process.exit(1);
    }
  } else {
    markup = { inline_keyboard: [] };
  }
  try {
    await api.editMessageText(parseInt(chatId, 10), parseInt(messageId, 10), newText, markup);
    console.log("Message edited");
  } catch (err) {
    console.error(`Failed to edit message: ${err.message || err}`);
    process.exit(1);
  }
});
busCommand.command("answer-callback").description("Answer a Telegram callback query to dismiss button loading state").argument("<callback-query-id>", "Callback query ID from Telegram update").argument("[toast-text]", "Optional toast notification text", "Got it").action(async (callbackQueryId, toastText) => {
  const env = resolveEnv();
  let botToken = "";
  if (env.agentDir) {
    const { readFileSync: readFileSync33, existsSync: existsSync33 } = require("fs");
    const agentEnv = require("path").join(env.agentDir, ".env");
    if (existsSync33(agentEnv)) {
      const match = readFileSync33(agentEnv, "utf-8").match(/^BOT_TOKEN=(.+)$/m);
      if (match?.[1]?.trim()) botToken = match[1].trim();
    }
  }
  if (!botToken) botToken = process.env.BOT_TOKEN || "";
  if (!botToken) {
    console.error("Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.");
    process.exit(1);
  }
  const api = new TelegramAPI(botToken);
  try {
    await api.answerCallbackQuery(callbackQueryId, toastText);
    console.log("Callback answered");
  } catch (err) {
    console.error(`Failed to answer callback: ${err.message || err}`);
    process.exit(1);
  }
});
busCommand.command("list-agents").description("Discover all agents in the system with their status and roles").option("--org <org>", "Filter by organization").option("--status <filter>", "Filter by status: running|all", "all").option("--format <fmt>", "Output format: json|text", "json").action(async (opts) => {
  const { existsSync: existsSync33, readdirSync: readdirSync18, readFileSync: readFileSync33 } = require("fs");
  const { join: join42 } = require("path");
  const env = resolveEnv();
  const ctxRoot = require("path").join(require("os").homedir(), ".cortextos", env.instanceId);
  const frameworkRoot = env.frameworkRoot || process.cwd();
  const enabledFile = join42(ctxRoot, "config", "enabled-agents.json");
  const agentMap = {};
  if (existsSync33(enabledFile)) {
    try {
      const data = JSON.parse(readFileSync33(enabledFile, "utf-8"));
      for (const [name, cfg] of Object.entries(data)) {
        agentMap[name] = { org: cfg.org ?? "", enabled: cfg.enabled !== false };
      }
    } catch {
    }
  }
  const orgsDir = join42(frameworkRoot, "orgs");
  if (existsSync33(orgsDir)) {
    for (const org of readdirSync18(orgsDir)) {
      const agentsDir = join42(orgsDir, org, "agents");
      if (!existsSync33(agentsDir)) continue;
      for (const name of readdirSync18(agentsDir)) {
        if (!agentMap[name]) agentMap[name] = { org, enabled: true };
      }
    }
  }
  const runningAgents = /* @__PURE__ */ new Set();
  const ipc = new IPCClient(env.instanceId);
  try {
    const resp = await ipc.send({ type: "status", source: "cortextos bus" });
    if (resp.success && Array.isArray(resp.data)) {
      for (const a of resp.data) {
        if (a.status === "running") runningAgents.add(a.name);
      }
    }
  } catch {
  }
  const results = [];
  for (const [name, info] of Object.entries(agentMap)) {
    if (opts.org && info.org !== opts.org) continue;
    const running = runningAgents.has(name);
    if (opts.status === "running" && !running) continue;
    let role = "";
    const agentDir = info.org ? join42(frameworkRoot, "orgs", info.org, "agents", name) : join42(frameworkRoot, "agents", name);
    const identityFile = join42(agentDir, "IDENTITY.md");
    if (existsSync33(identityFile)) {
      const content = readFileSync33(identityFile, "utf-8");
      const m = content.match(/^## Role\s*\n(.+)/m);
      if (m) role = m[1].trim();
    }
    const hbFile = join42(ctxRoot, "state", name, "heartbeat.json");
    let lastHeartbeat = "", currentTask = "", mode = "";
    if (existsSync33(hbFile)) {
      try {
        const hb = JSON.parse(readFileSync33(hbFile, "utf-8"));
        lastHeartbeat = hb.last_heartbeat ?? "";
        currentTask = hb.current_task ?? "";
        mode = hb.mode ?? "";
      } catch {
      }
    }
    results.push({ name, org: info.org, role, enabled: info.enabled, running, last_heartbeat: lastHeartbeat, current_task: currentTask, mode });
  }
  if (opts.format === "text") {
    console.log(`Agents in system:
`);
    for (const a of results) {
      const status = a.running ? "RUNNING" : "stopped";
      console.log(`  ${a.name} (${a.org || "root"}) [${status}]`);
      if (a.role) console.log(`    Role: ${a.role}`);
      if (a.current_task) console.log(`    Working on: ${a.current_task}`);
      console.log("");
    }
    console.log(`Total: ${results.length} agents`);
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
});
busCommand.command("list-skills").description("Discover available skills for the current agent").option("--format <fmt>", "Output format: json|text", "json").action((opts) => {
  const { existsSync: existsSync33, readdirSync: readdirSync18, readFileSync: readFileSync33 } = require("fs");
  const { join: join42 } = require("path");
  const env = resolveEnv();
  const frameworkRoot = env.frameworkRoot || process.cwd();
  const agentDir = env.agentDir || process.cwd();
  let template = "";
  const configFile = join42(agentDir, "config.json");
  if (existsSync33(configFile)) {
    try {
      template = JSON.parse(readFileSync33(configFile, "utf-8")).template ?? "";
    } catch {
    }
  }
  function parseSkillFrontmatter2(filePath) {
    try {
      const content = readFileSync33(filePath, "utf-8");
      const lines = content.split("\n");
      let inFrontmatter = false;
      let name = "", description = "";
      for (const line of lines) {
        if (line.trim() === "---") {
          if (inFrontmatter) break;
          inFrontmatter = true;
          continue;
        }
        if (!inFrontmatter) continue;
        const nm = line.match(/^name:\s*['"]?(.+?)['"]?\s*$/);
        if (nm) name = nm[1];
        const dm = line.match(/^description:\s*['"]?(.+?)['"]?\s*$/);
        if (dm) description = dm[1];
      }
      return name ? { name, description } : null;
    } catch {
      return null;
    }
  }
  function scanSkillsDir2(dir, source) {
    const map = /* @__PURE__ */ new Map();
    if (!existsSync33(dir)) return map;
    for (const entry of readdirSync18(dir)) {
      const skillFile = join42(dir, entry, "SKILL.md");
      if (!existsSync33(skillFile)) continue;
      const parsed = parseSkillFrontmatter2(skillFile);
      if (parsed) map.set(parsed.name, { ...parsed, path: skillFile, source });
    }
    return map;
  }
  const merged = /* @__PURE__ */ new Map();
  for (const [k, v] of scanSkillsDir2(join42(frameworkRoot, ".claude", "skills"), "framework")) merged.set(k, v);
  if (template) {
    for (const [k, v] of scanSkillsDir2(join42(frameworkRoot, "templates", template, ".claude", "skills"), `template:${template}`)) merged.set(k, v);
  }
  for (const [k, v] of scanSkillsDir2(join42(agentDir, ".claude", "skills"), "agent")) merged.set(k, v);
  const skills = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (opts.format === "text") {
    console.log(`Available skills for ${env.agentName}:
`);
    for (const s of skills) {
      console.log(`  ${s.name} (${s.source})`);
      if (s.description) console.log(`    ${s.description}`);
      console.log("");
    }
    console.log(`Total: ${skills.length} skills`);
  } else {
    console.log(JSON.stringify(skills, null, 2));
  }
});
busCommand.command("notify-agent").description("Send urgent signal to another agent for immediate delivery via fast-checker").argument("<agent>", "Target agent name").argument("<message>", "Urgent message text").action((targetAgent, message) => {
  const { mkdirSync: mkdirSync15, writeFileSync: writeFileSync22 } = require("fs");
  const { join: join42 } = require("path");
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const ctxRoot = require("path").join(require("os").homedir(), ".cortextos", env.instanceId);
  const signalDir = join42(ctxRoot, "state", targetAgent);
  mkdirSync15(signalDir, { recursive: true });
  const signal = {
    from: env.agentName,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z")
  };
  writeFileSync22(join42(signalDir, ".urgent-signal"), JSON.stringify(signal));
  try {
    sendMessage(paths, env.agentName, targetAgent, "urgent", message);
  } catch {
  }
  console.log(`Signal sent to ${targetAgent}`);
});
busCommand.command("soft-restart").description("Gracefully restart another agent by writing the restart marker then sending /exit").argument("<agent>", "Target agent name to restart").argument("[reason]", "Reason for restart", "user request via soft-restart").action(async (targetAgent, reason) => {
  const { mkdirSync: mkdirSync15, writeFileSync: writeFileSync22 } = require("fs");
  const { join: join42 } = require("path");
  const env = resolveEnv();
  const ctxRoot = require("path").join(require("os").homedir(), ".cortextos", env.instanceId);
  const stateDir = join42(ctxRoot, "state", targetAgent);
  mkdirSync15(stateDir, { recursive: true });
  writeFileSync22(join42(stateDir, ".user-restart"), reason);
  console.log(`Wrote .user-restart marker for ${targetAgent}: ${reason}`);
  const ipc = new IPCClient(env.instanceId);
  const daemonRunning = await ipc.isDaemonRunning();
  if (daemonRunning) {
    const resp = await ipc.send({ type: "restart-agent", agent: targetAgent, source: "cortextos bus soft-restart" });
    if (resp.success) {
      console.log(`Restarted ${targetAgent} via daemon IPC`);
    } else {
      console.error(`Daemon restart failed: ${resp.error}`);
      process.exit(1);
    }
  } else {
    console.error("ERROR: Node daemon is not running. Start it with: cortextos start");
    process.exit(1);
  }
});
busCommand.command("soft-restart-all").description("Soft-restart all enabled agents in the org with optional stagger delay").option("--stagger <seconds>", "Seconds between each agent restart", "5").option("--reason <why>", "Reason for restart", "soft-restart-all requested").action(async (opts) => {
  const { mkdirSync: mkdirSync15, writeFileSync: writeFileSync22, readFileSync: readFileSync33, existsSync: existsSync33 } = require("fs");
  const { join: join42 } = require("path");
  const env = resolveEnv();
  const ctxRoot = require("path").join(require("os").homedir(), ".cortextos", env.instanceId);
  const staggerMs = parseInt(opts.stagger, 10) * 1e3;
  const enabledFile = join42(ctxRoot, "config", "enabled-agents.json");
  if (!existsSync33(enabledFile)) {
    console.error("ERROR: enabled-agents.json not found at", enabledFile);
    process.exit(1);
  }
  const enabledAgents = JSON.parse(readFileSync33(enabledFile, "utf-8"));
  const targets = Object.entries(enabledAgents).filter(([, cfg]) => cfg.enabled !== false).filter(([, cfg]) => !env.org || !cfg.org || cfg.org === env.org).map(([name]) => name);
  if (targets.length === 0) {
    console.log("No enabled agents found for org:", env.org || "(all)");
    process.exit(0);
  }
  const ipc = new IPCClient(env.instanceId);
  const daemonRunning = await ipc.isDaemonRunning();
  if (!daemonRunning) {
    console.error("ERROR: Node daemon is not running. Start it with: cortextos start");
    process.exit(1);
  }
  console.log(`Restarting ${targets.length} agent(s) with ${opts.stagger}s stagger: ${targets.join(", ")}`);
  for (let i = 0; i < targets.length; i++) {
    const agent = targets[i];
    if (i > 0) {
      await new Promise((resolve4) => setTimeout(resolve4, staggerMs));
    }
    const stateDir = join42(ctxRoot, "state", agent);
    mkdirSync15(stateDir, { recursive: true });
    writeFileSync22(join42(stateDir, ".user-restart"), opts.reason);
    const resp = await ipc.send({ type: "restart-agent", agent, source: "cortextos bus soft-restart-all" });
    if (resp.success) {
      console.log(`[${i + 1}/${targets.length}] Restarted ${agent}`);
    } else {
      console.error(`[${i + 1}/${targets.length}] Failed to restart ${agent}: ${resp.error}`);
    }
  }
  console.log("soft-restart-all complete.");
});
busCommand.command("send-mobile-reply").description("Reply to a mobile app user message and ACK the inbox message").argument("<agent>", "Agent name sending the reply").argument("<reply>", "Reply text").argument("[msg-id]", "Inbox message ID to ACK").action((agent, reply, msgId) => {
  const { mkdirSync: mkdirSync15, appendFileSync: appendFileSync7 } = require("fs");
  const { join: join42 } = require("path");
  const env = resolveEnv();
  const ctxRoot = require("path").join(require("os").homedir(), ".cortextos", env.instanceId);
  const logDir = join42(ctxRoot, "logs", agent);
  mkdirSync15(logDir, { recursive: true });
  const entry = JSON.stringify({
    timestamp: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    agent,
    text: reply,
    message_id: `mobile-reply-${Date.now()}`,
    type: "text"
  });
  appendFileSync7(join42(logDir, "outbound-messages.jsonl"), entry + "\n");
  if (msgId) {
    const paths = resolvePaths(agent, env.instanceId, env.org);
    try {
      ackInbox(paths, msgId);
    } catch {
    }
  }
  console.log("Replied to mobile user");
});
busCommand.command("list-approvals").description("List pending approval requests").option("--format <fmt>", "Output format: json|text", "json").option("--all-orgs", "Scan all orgs under CTX_ROOT (matches dashboard view)", false).action((opts) => {
  const { listPendingApprovals: listPendingApprovals2 } = (init_approval(), __toCommonJS(approval_exports));
  const { readdirSync: readdirSync18, existsSync: existsSync33 } = require("fs");
  const { join: join42, homedir: _homedir } = require("path");
  const { homedir: homedir19 } = require("os");
  const env = resolveEnv();
  let approvals = [];
  if (opts.allOrgs) {
    const ctxRoot = join42(homedir19(), ".cortextos", env.instanceId);
    const orgsDir = join42(ctxRoot, "orgs");
    const orgs = existsSync33(orgsDir) ? readdirSync18(orgsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
    for (const org of orgs) {
      const orgPaths = resolvePaths(env.agentName, env.instanceId, org);
      approvals = approvals.concat(listPendingApprovals2(orgPaths));
    }
  } else {
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    approvals = listPendingApprovals2(paths);
  }
  if (opts.format === "text") {
    if (approvals.length === 0) {
      console.log("No pending approvals");
      return;
    }
    for (const a of approvals) {
      console.log(`[${a.id}] ${a.title}`);
      console.log(`  Category: ${a.category} | Agent: ${a.requesting_agent} | Org: ${a.org ?? env.org} | Created: ${a.created_at}`);
      if (a.description) console.log(`  Context: ${a.description}`);
      console.log("");
    }
    console.log(`Total: ${approvals.length} pending`);
  } else {
    console.log(JSON.stringify(approvals, null, 2));
  }
});
busCommand.command("create-reminder").argument("<fire-at>", "When to fire, ISO 8601 UTC (e.g. 2026-04-05T08:00:00Z)").argument("<prompt>", "Text to inject into boot prompt when overdue").description("Create a persistent reminder that survives hard-restarts").action((fireAt, prompt) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const reminder = createReminder(paths, fireAt, prompt);
  console.log(reminder.id);
});
busCommand.command("list-reminders").option("--all", "Include acked reminders", false).option("--format <fmt>", "Output format: json or text", "text").description("List pending (or all) reminders").action((opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const reminders = listReminders(paths, { all: opts.all });
  if (opts.format === "json") {
    console.log(JSON.stringify(reminders, null, 2));
    return;
  }
  if (reminders.length === 0) {
    console.log("No pending reminders");
    return;
  }
  const now = Date.now();
  for (const r of reminders) {
    const overdue = Date.parse(r.fire_at) <= now;
    const overdueTag = overdue ? " [OVERDUE]" : "";
    console.log(`[${r.id}]${overdueTag}`);
    console.log(`  fire_at: ${r.fire_at}  status: ${r.status}`);
    console.log(`  prompt:  ${r.prompt}`);
    console.log("");
  }
});
busCommand.command("ack-reminder").argument("<id>", "Reminder ID to acknowledge").description("Mark a reminder as handled").action((id) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  ackReminder(paths, id);
  console.log(`ACK'd reminder ${id}`);
});
busCommand.command("prune-reminders").option("--days <n>", "Retain acked reminders for N days", "7").description("Delete acked reminders older than N days").action((opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const pruned = pruneReminders(paths, parseInt(opts.days ?? "7", 10));
  console.log(`Pruned ${pruned} acked reminder(s)`);
});
busCommand.command("update-cron-fire").argument("<cron-name>", "Name of the cron as defined in config.json").option("--interval <interval>", 'Expected interval, e.g. "6h", "24h", "30m"').description("Record that a named cron just fired (enables daemon gap detection for dead zones)").action((cronName, opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  updateCronFire(paths.stateDir, cronName, opts.interval);
  console.log(`Recorded fire for cron "${cronName}"`);
});
busCommand.command("hook-context-status").description("StatusLine hook: writes context window % to state/context_status.json").action(() => runHook("hook-context-status"));
busCommand.command("hook-ask-telegram").description("PreToolUse hook: forward AskUserQuestion to Telegram (cross-platform)").action(() => runHook("hook-ask-telegram"));
busCommand.command("hook-permission-telegram").description("PermissionRequest hook: send approve/deny request to Telegram (cross-platform)").action(() => runHook("hook-permission-telegram"));
busCommand.command("hook-planmode-telegram").description("ExitPlanMode hook: send plan for review to Telegram (cross-platform)").action(() => runHook("hook-planmode-telegram"));
busCommand.command("hook-compact-telegram").description("PreCompact hook: notify user via Telegram when context compaction starts (#18)").action(() => runHook("hook-compact-telegram"));
busCommand.command("hook-idle-flag").description("Stop hook: writes last_idle.flag timestamp so fast-checker knows agent finished its turn").action(() => runHook("hook-idle-flag"));
busCommand.command("check-usage-api").description("Fetch Claude OAuth utilization from Anthropic usage API (3-min TTL cache)").option("--account <name>", "Check specific account (default: active account)").option("--force", "Bypass cache and fetch fresh data").option("--json", "Output as JSON").action(async (opts) => {
  const env = resolveEnv();
  try {
    const result = await checkUsageApi(env.ctxRoot, { force: opts.force, account: opts.account });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const cached = result.cached ? " (cached)" : "";
      const warn5h = result.five_hour_utilization >= ALERT_5H ? " \u26A0\uFE0F" : "";
      const warn7d = result.seven_day_utilization >= ALERT_7D ? " \u26A0\uFE0F" : "";
      console.log(`Account: ${result.account}${cached}`);
      console.log(`5h utilization:  ${pct2(result.five_hour_utilization)}${warn5h}`);
      console.log(`7d utilization:  ${pct2(result.seven_day_utilization)}${warn7d}`);
      console.log(`Fetched at: ${result.fetched_at}`);
    }
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }
});
busCommand.command("refresh-oauth-token").description("Refresh OAuth token for an account using its refresh_token (one-time use \u2014 writes atomically)").option("--account <name>", "Account to refresh (default: active account)").action(async (opts) => {
  const env = resolveEnv();
  try {
    const result = await refreshOAuthToken(env.ctxRoot, opts.account);
    const expiresIn = Math.round((result.expires_at - Date.now()) / 1e3 / 60);
    console.log(`Refreshed account: ${result.account}`);
    console.log(`New token expires in: ${expiresIn} minutes`);
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }
});
busCommand.command("rotate-oauth").description("Rotate to the next OAuth account if utilization thresholds are met").option("--force", "Force rotation regardless of utilization").option("--agent <name>", "Only update this agent's .env (default: all agents in org)").option("--reason <text>", "Reason for rotation (logged)").option("--json", "Output as JSON").action(async (opts) => {
  const env = resolveEnv();
  if (!env.frameworkRoot) {
    console.error("CTX_FRAMEWORK_ROOT is required for rotate-oauth");
    process.exit(1);
  }
  try {
    const result = await rotateOAuth(env.ctxRoot, env.frameworkRoot, env.org, {
      force: opts.force,
      agent: opts.agent,
      reason: opts.reason
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.rotated) {
      console.log(`Rotated: ${result.from} \u2192 ${result.to}`);
      console.log(`Reason: ${result.reason}`);
    } else {
      console.log(`No rotation needed: ${result.reason}`);
    }
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }
});
busCommand.command("list-oauth-accounts").description("List all OAuth accounts and their utilization").action((opts) => {
  const env = resolveEnv();
  const store = loadAccounts(env.ctxRoot);
  if (!store) {
    console.log("No accounts.json found at state/oauth/accounts.json");
    return;
  }
  for (const [name, acct] of Object.entries(store.accounts)) {
    const active = name === store.active ? " (active)" : "";
    const expiry = new Date(acct.expires_at).toISOString();
    const warn5h = acct.five_hour_utilization >= ALERT_5H ? " \u26A0\uFE0F" : "";
    const warn7d = acct.seven_day_utilization >= ALERT_7D ? " \u26A0\uFE0F" : "";
    console.log(`${name}${active}`);
    console.log(`  5h: ${pct2(acct.five_hour_utilization)}${warn5h}  7d: ${pct2(acct.seven_day_utilization)}${warn7d}  expires: ${expiry}`);
  }
});
busCommand.command("tui-stream").description("Stream Claude Code TUI tool activity to the event log and optionally Telegram").option("--session <name>", "tmux session name (defaults to CTX_AGENT_NAME)").option("--interval <ms>", "Poll interval in milliseconds", "2000").option("--telegram", "Forward high-signal events to Telegram chat", false).option("--dry-run", "Print events to stdout instead of logging", false).action(async (opts) => {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const sessionName = opts.session || env.agentName;
  const pollMs = Math.max(500, parseInt(opts.interval, 10) || 2e3);
  const HIGH_SIGNAL = [
    /^[├│└].*Tool:\s*(Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|Agent)/i,
    /^[├│└].*Running bash command/i,
    /^[├│└].*Editing file/i,
    /^[├│└].*Writing file/i,
    /^[├│└].*Reading file/i,
    /error|Error|ERROR/,
    /✓.*completed|✗.*failed/i,
    /Permission (request|denied|approved)/i
  ];
  const TOOL_LINE = /^[├│└▶◆●]|^(Tool|Bash|Edit|Write|Read|Glob|Grep|Agent):/i;
  let prevOutput = "";
  let telegramApi = null;
  let chatId;
  if (opts.telegram) {
    const { TelegramAPI: TelegramAPI2 } = await Promise.resolve().then(() => (init_api(), api_exports));
    const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
    const envPath = (0, import_path28.join)(agentDir, ".env");
    if ((0, import_fs28.existsSync)(envPath)) {
      const envContent = (0, import_fs28.readFileSync)(envPath, "utf-8");
      const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
      const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
      if (botTokenMatch && chatIdMatch) {
        telegramApi = new TelegramAPI2(botTokenMatch[1].trim());
        chatId = chatIdMatch[1].trim();
      }
    }
  }
  const logLine = (msg) => {
    if (opts.dryRun) {
      console.log(msg);
    }
  };
  let lastTelegramSent = 0;
  const TELEGRAM_COOLDOWN_MS = 1e4;
  logLine(`[tui-stream] Watching tmux session: ${sessionName} (poll: ${pollMs}ms)`);
  while (true) {
    try {
      let currentOutput = "";
      try {
        const result = (0, import_child_process7.execFileSync)("tmux", ["capture-pane", "-t", sessionName, "-p"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"]
        });
        currentOutput = result;
      } catch {
        await sleepMs(pollMs * 5);
        continue;
      }
      const prevLines = prevOutput.split("\n");
      const currLines = currentOutput.split("\n");
      const newLines = currLines.length > prevLines.length ? currLines.slice(prevLines.length - 1) : currLines.filter((l) => !prevOutput.includes(l));
      prevOutput = currentOutput;
      if (newLines.length === 0) {
        await sleepMs(pollMs);
        continue;
      }
      const toolLines = newLines.filter((l) => {
        const t = l.trim();
        return t.length > 0 && (TOOL_LINE.test(t) || t.startsWith("\u25CF") || t.startsWith("\u25C6"));
      });
      for (const line of toolLines) {
        const trimmed = line.trim().slice(0, 200);
        const isHighSignal = HIGH_SIGNAL.some((re) => re.test(trimmed));
        if (!opts.dryRun) {
          try {
            logEvent(paths, env.agentName, env.org, "agent_activity", "tool_call", "info", {
              line: trimmed,
              session: sessionName,
              high_signal: isHighSignal
            });
          } catch {
          }
        } else {
          logLine(`[event] ${trimmed}`);
        }
        if (isHighSignal && opts.telegram && telegramApi && chatId) {
          const now = Date.now();
          if (now - lastTelegramSent >= TELEGRAM_COOLDOWN_MS) {
            lastTelegramSent = now;
            try {
              await telegramApi.sendMessage(chatId, `[${env.agentName}] ${trimmed}`);
            } catch {
            }
          }
        }
      }
    } catch {
    }
    await sleepMs(pollMs);
  }
});
busCommand.command("fix-agent-settings").description("Patch all agent settings.json files: add missing allowlist tools and statusLine hook").option("--dry-run", "Show what would be changed without writing").action((opts) => {
  const { existsSync: fsExists, readdirSync: fsReaddir, readFileSync: fsRead, writeFileSync: fsWrite } = require("fs");
  const env = resolveEnv();
  const frameworkRoot = env.frameworkRoot || process.cwd();
  const orgsDir = (0, import_path28.join)(frameworkRoot, "orgs");
  const REQUIRED_ALLOW = [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "ToolSearch",
    "CronCreate",
    "CronList",
    "CronDelete",
    "Skill",
    "Agent"
  ];
  const STATUS_LINE = {
    type: "command",
    command: "cortextos bus hook-context-status",
    refreshInterval: 5,
    timeout: 2
  };
  if (!fsExists(orgsDir)) {
    console.error("orgs/ directory not found at", orgsDir);
    process.exit(1);
  }
  let patched = 0;
  let skipped = 0;
  for (const org of fsReaddir(orgsDir)) {
    const agentsDir = (0, import_path28.join)(orgsDir, org, "agents");
    if (!fsExists(agentsDir)) continue;
    for (const agent of fsReaddir(agentsDir)) {
      const settingsPath = (0, import_path28.join)(agentsDir, agent, ".claude", "settings.json");
      if (!fsExists(settingsPath)) continue;
      let settings;
      try {
        settings = JSON.parse(fsRead(settingsPath, "utf-8"));
      } catch {
        console.warn(`  SKIP ${agent}: could not parse settings.json`);
        skipped++;
        continue;
      }
      const changes = [];
      const current = settings?.permissions?.allow ?? [];
      const missing = REQUIRED_ALLOW.filter((t) => !current.includes(t));
      if (missing.length > 0) changes.push(`allow: +[${missing.join(", ")}]`);
      if (!settings.statusLine) changes.push("statusLine: add hook-context-status");
      if (changes.length === 0) {
        console.log(`  OK   ${agent}: already up to date`);
        skipped++;
        continue;
      }
      if (opts.dryRun) {
        console.log(`  DRY  ${agent}: would apply [${changes.join("; ")}]`);
        patched++;
      } else {
        settings.permissions = settings.permissions ?? {};
        settings.permissions.allow = [...current, ...missing];
        settings.statusLine = STATUS_LINE;
        fsWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        console.log(`  FIX  ${agent}: applied [${changes.join("; ")}]`);
        patched++;
      }
    }
  }
  const verb = opts.dryRun ? "Would patch" : "Patched";
  console.log(`
${verb} ${patched} agent(s). ${skipped} already up to date or skipped.`);
  if (!opts.dryRun && patched > 0) {
    console.log("\nRestart affected agents to apply the new settings:");
    console.log("  cortextos restart <agent-name>");
  }
});
function sleepMs(ms) {
  return new Promise((resolve4) => setTimeout(resolve4, ms));
}
function pct2(v) {
  return `${Math.round(v * 100)}%`;
}

// src/cli/list-agents.ts
init_cjs_shims();
var import_commander8 = require("commander");
var import_os10 = require("os");
var import_path30 = require("path");

// src/bus/agents.ts
init_cjs_shims();
var import_fs29 = require("fs");
var import_path29 = require("path");
init_atomic();
init_message();
function listAgents(ctxRoot, org) {
  const agents = [];
  const seen = /* @__PURE__ */ new Set();
  const enabledFile = (0, import_path29.join)(ctxRoot, "config", "enabled-agents.json");
  let enabledAgents = {};
  if ((0, import_fs29.existsSync)(enabledFile)) {
    try {
      enabledAgents = JSON.parse((0, import_fs29.readFileSync)(enabledFile, "utf-8"));
    } catch {
    }
  }
  const cliProjectRoot = process.env.CTX_FRAMEWORK_ROOT;
  const scanRoots = [];
  if (cliProjectRoot && (0, import_fs29.existsSync)((0, import_path29.join)(cliProjectRoot, "orgs"))) {
    scanRoots.push(cliProjectRoot);
  }
  if (scanRoots.length === 0 && !cliProjectRoot) {
    const cwd = process.cwd();
    if ((0, import_fs29.existsSync)((0, import_path29.join)(cwd, "orgs"))) {
      scanRoots.push(cwd);
    }
  }
  for (const root of scanRoots) {
    const orgsDir = (0, import_path29.join)(root, "orgs");
    if (!(0, import_fs29.existsSync)(orgsDir)) continue;
    let orgDirs;
    try {
      orgDirs = (0, import_fs29.readdirSync)(orgsDir);
    } catch {
      continue;
    }
    for (const orgName of orgDirs) {
      if (org && orgName !== org) continue;
      const agentsDir = (0, import_path29.join)(orgsDir, orgName, "agents");
      if (!(0, import_fs29.existsSync)(agentsDir)) continue;
      let agentDirs;
      try {
        agentDirs = (0, import_fs29.readdirSync)(agentsDir);
      } catch {
        continue;
      }
      for (const agentName of agentDirs) {
        if (!/^[a-z0-9_-]+$/.test(agentName)) continue;
        if (seen.has(agentName)) continue;
        seen.add(agentName);
        const explicitEntry = enabledAgents[agentName];
        const isEnabled = explicitEntry ? explicitEntry.enabled !== false : true;
        agents.push(buildAgentInfo(agentName, orgName, isEnabled, ctxRoot));
      }
    }
  }
  for (const [name, cfg] of Object.entries(enabledAgents)) {
    if (!/^[a-z0-9_-]+$/.test(name)) continue;
    if (seen.has(name)) continue;
    const agentOrg = cfg.org || "";
    if (org && agentOrg !== org) continue;
    seen.add(name);
    agents.push(buildAgentInfo(name, agentOrg, cfg.enabled !== false, ctxRoot));
  }
  return agents;
}
function buildAgentInfo(name, org, enabled, ctxRoot) {
  let lastHeartbeat = null;
  let currentTask = null;
  let mode = null;
  let running = false;
  const stateHeartbeat = (0, import_path29.join)(ctxRoot, "state", name, "heartbeat.json");
  if ((0, import_fs29.existsSync)(stateHeartbeat)) {
    try {
      const hb = JSON.parse((0, import_fs29.readFileSync)(stateHeartbeat, "utf-8"));
      lastHeartbeat = hb.last_heartbeat || hb.timestamp || null;
      currentTask = hb.current_task || null;
      mode = hb.mode || null;
      if (lastHeartbeat) {
        const age = Date.now() - new Date(lastHeartbeat).getTime();
        running = age < 10 * 60 * 1e3;
      }
    } catch {
    }
  }
  let role = "";
  let displayName;
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || "";
  if (frameworkRoot) {
    const identityPaths = [
      (0, import_path29.join)(frameworkRoot, "orgs", org, "agents", name, "IDENTITY.md"),
      (0, import_path29.join)(frameworkRoot, "agents", name, "IDENTITY.md")
    ];
    for (const idPath of identityPaths) {
      if ((0, import_fs29.existsSync)(idPath)) {
        try {
          const content = (0, import_fs29.readFileSync)(idPath, "utf-8");
          const lines = content.split("\n");
          const nameIdx = lines.findIndex((l) => l.trim() === "## Name");
          if (nameIdx >= 0) {
            for (let i = nameIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line || line.startsWith("<!--")) continue;
              if (line.startsWith("##")) break;
              displayName = line;
              break;
            }
          }
          const roleIdx = lines.findIndex((l) => l.startsWith("## Role"));
          if (roleIdx >= 0) {
            for (let i = roleIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line || line.startsWith("<!--") || line.startsWith("##")) break;
              role = line;
              break;
            }
          }
          if (!role) {
            for (const line of lines) {
              const t = line.trim();
              if (t && !t.startsWith("#") && !t.startsWith("<!--")) {
                role = t;
                break;
              }
            }
          }
        } catch {
        }
        break;
      }
    }
  }
  const configFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || "";
  if (configFrameworkRoot) {
    const configPaths = [
      (0, import_path29.join)(configFrameworkRoot, "orgs", org, "agents", name, "config.json"),
      (0, import_path29.join)(configFrameworkRoot, "agents", name, "config.json")
    ];
    for (const cfgPath of configPaths) {
      if ((0, import_fs29.existsSync)(cfgPath)) {
        try {
          const cfg = JSON.parse((0, import_fs29.readFileSync)(cfgPath, "utf-8"));
          if (cfg.enabled !== void 0) enabled = cfg.enabled;
        } catch {
        }
        break;
      }
    }
  }
  return {
    name,
    org,
    display_name: displayName,
    role,
    enabled,
    running,
    last_heartbeat: lastHeartbeat,
    current_task: currentTask,
    mode
  };
}
function notifyAgent(paths, from, targetAgent, message, ctxRoot) {
  const signalDir = (0, import_path29.join)(ctxRoot, "state", targetAgent);
  ensureDir(signalDir);
  const signal = {
    from,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z")
  };
  atomicWriteSync((0, import_path29.join)(signalDir, ".urgent-signal"), JSON.stringify(signal));
  try {
    sendMessage(paths, from, targetAgent, "urgent", message);
  } catch {
  }
}

// src/cli/list-agents.ts
var listAgentsCommand = new import_commander8.Command("list-agents").description("List all agents in the system").option("--org <org>", "Filter by organization").option("--format <format>", "Output format: json or text", "text").option("--instance <id>", "Instance ID").action((options) => {
  const instanceId = options.instance || process.env.CTX_INSTANCE_ID || "default";
  const ctxRoot = (0, import_path30.join)((0, import_os10.homedir)(), ".cortextos", instanceId);
  const agents = listAgents(ctxRoot, options.org);
  if (options.format === "json") {
    console.log(JSON.stringify(agents, null, 2));
  } else {
    if (agents.length === 0) {
      console.log("No agents found.");
      return;
    }
    const header = "  Name              Display Name      Org              Role                          Status          Last Heartbeat";
    const separator = "  " + "-".repeat(header.length - 2);
    console.log("\n  Agents\n");
    console.log(header);
    console.log(separator);
    for (const a of agents) {
      const name = a.name.padEnd(18);
      const displayName = (a.display_name || "-").padEnd(18);
      const org = (a.org || "-").padEnd(17);
      const role = (a.role || "-").substring(0, 29).padEnd(30);
      const healthIcon = a.running ? "\u25CF " : "\u25CB ";
      const statusText = a.running ? "running" : "stopped";
      const status = (healthIcon + statusText).padEnd(16);
      const hb = a.last_heartbeat || "-";
      console.log(`  ${name}${displayName}${org}${role}${status}${hb}`);
    }
    console.log(`
  Total: ${agents.length} agents
`);
  }
});

// src/cli/notify-agent.ts
init_cjs_shims();
var import_commander9 = require("commander");
var import_os11 = require("os");
var import_path31 = require("path");
var notifyAgentCommand = new import_commander9.Command("notify-agent").description("Send an urgent notification to an agent").argument("<name>", "Target agent name").argument("<message>", "Message to send").option("--from <agent>", "Sender agent name", "cli").option("--instance <id>", "Instance ID", "default").action((name, message, options) => {
  const paths = resolvePaths(options.from, options.instance);
  const ctxRoot = (0, import_path31.join)((0, import_os11.homedir)(), ".cortextos", options.instance);
  notifyAgent(paths, options.from, name, message, ctxRoot);
  console.log(`Signal sent to ${name}`);
});

// src/cli/list-skills.ts
init_cjs_shims();
var import_commander10 = require("commander");
var import_fs30 = require("fs");
var import_path32 = require("path");
function parseFrontmatter(filePath) {
  try {
    const content = (0, import_fs30.readFileSync)(filePath, "utf-8");
    const lines = content.split("\n");
    let inFrontmatter = false;
    let name = "";
    let description = "";
    for (const line of lines) {
      if (line.trim() === "---") {
        if (inFrontmatter) break;
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
        if (nameMatch) name = nameMatch[1];
        const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
        if (descMatch) description = descMatch[1];
      }
    }
    return name ? { name, description } : null;
  } catch {
    return null;
  }
}
function scanSkillsDir(dir, source) {
  if (!(0, import_fs30.existsSync)(dir)) return [];
  const skills = [];
  try {
    const entries = (0, import_fs30.readdirSync)(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = (0, import_path32.join)(dir, entry.name, "SKILL.md");
      if (!(0, import_fs30.existsSync)(skillFile)) continue;
      const parsed = parseFrontmatter(skillFile);
      if (parsed) {
        skills.push({
          name: parsed.name,
          description: parsed.description,
          path: skillFile,
          source
        });
      }
    }
  } catch {
  }
  return skills;
}
var listSkillsCommand = new import_commander10.Command("list-skills").option("--format <format>", "Output format (json|text)", "text").option("--agent-dir <dir>", "Agent directory to scan").description("List available skills for the current agent").action(async (options) => {
  const agentDir = options.agentDir || process.cwd();
  const skillMap = /* @__PURE__ */ new Map();
  const templateRoot = findTemplateRoot();
  if (templateRoot) {
    const frameworkSkills = (0, import_path32.join)(templateRoot, "..", "skills");
    for (const skill of scanSkillsDir(frameworkSkills, "framework")) {
      skillMap.set(skill.name, skill);
    }
  }
  if (templateRoot) {
    try {
      const configPath = (0, import_path32.join)(agentDir, "config.json");
      if ((0, import_fs30.existsSync)(configPath)) {
        const config = JSON.parse((0, import_fs30.readFileSync)(configPath, "utf-8"));
        const role = config.template || "";
        if (role) {
          const roleSkillsDir = (0, import_path32.join)(templateRoot, role, "skills");
          for (const skill of scanSkillsDir(roleSkillsDir, `template:${role}`)) {
            skillMap.set(skill.name, skill);
          }
        }
      }
    } catch {
    }
  }
  const agentSkills = (0, import_path32.join)(agentDir, "skills");
  for (const skill of scanSkillsDir(agentSkills, "agent")) {
    skillMap.set(skill.name, skill);
  }
  const skills = Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (options.format === "json") {
    console.log(JSON.stringify(skills, null, 2));
  } else {
    if (skills.length === 0) {
      console.log("No skills found.");
      return;
    }
    console.log("Available skills:\n");
    for (const skill of skills) {
      console.log(`  ${skill.name} (${skill.source})`);
      console.log(`    ${skill.description}`);
      console.log("");
    }
    console.log(`Total: ${skills.length} skills`);
  }
});
function findTemplateRoot() {
  const candidates = [
    (0, import_path32.join)(process.cwd(), "templates"),
    (0, import_path32.join)(__dirname, "..", "..", "templates")
  ];
  for (const dir of candidates) {
    if ((0, import_fs30.existsSync)(dir)) return dir;
  }
  return null;
}

// src/cli/install.ts
init_cjs_shims();
var import_commander11 = require("commander");
var import_fs31 = require("fs");
var import_path33 = require("path");
var import_os12 = require("os");
var import_child_process8 = require("child_process");
var import_crypto5 = require("crypto");
var IS_WINDOWS2 = (0, import_os12.platform)() === "win32";
var IS_MAC = (0, import_os12.platform)() === "darwin";
var SAFE_NAME = /^[@a-z0-9._/-]+$/i;
function tryInstallGlobal(pkg) {
  if (!SAFE_NAME.test(pkg)) return false;
  const result = IS_WINDOWS2 ? (0, import_child_process8.spawnSync)(`npm install -g ${pkg}`, { stdio: "inherit", timeout: 12e4, shell: true }) : (0, import_child_process8.spawnSync)("npm", ["install", "-g", pkg], { stdio: "inherit", timeout: 12e4 });
  return result.status === 0;
}
function commandExists2(cmd) {
  if (!SAFE_NAME.test(cmd)) return false;
  if (IS_WINDOWS2) {
    const result2 = (0, import_child_process8.spawnSync)(`where ${cmd}`, { stdio: "pipe", shell: true });
    return result2.status === 0;
  }
  const result = (0, import_child_process8.spawnSync)("which", [cmd], { stdio: "pipe" });
  return result.status === 0;
}
function tryInstallJq() {
  if (IS_MAC && commandExists2("brew")) {
    try {
      (0, import_child_process8.execSync)("brew install jq", { stdio: "inherit" });
      return true;
    } catch {
      return false;
    }
  }
  if (!IS_WINDOWS2 && !IS_MAC) {
    try {
      (0, import_child_process8.execSync)("sudo apt-get install -y jq", { stdio: "inherit" });
      return true;
    } catch {
      return false;
    }
  }
  if (IS_WINDOWS2) {
    if (commandExists2("winget")) {
      try {
        (0, import_child_process8.execSync)("winget install jqlang.jq --silent", { stdio: "inherit" });
        return true;
      } catch {
      }
    }
    if (commandExists2("choco")) {
      try {
        (0, import_child_process8.execSync)("choco install jq -y", { stdio: "inherit" });
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}
var installCommand = new import_commander11.Command("install").option("--instance <id>", "Instance ID", "default").description("Install cortextOS \u2014 create state directories, check and install dependencies").action(async (options) => {
  const instanceId = options.instance;
  const ctxRoot = (0, import_path33.join)((0, import_os12.homedir)(), ".cortextos", instanceId);
  console.log("\ncortextOS Installation\n");
  console.log("Checking dependencies...\n");
  try {
    const v = (0, import_child_process8.execSync)("node --version", { encoding: "utf-8", stdio: "pipe" }).trim();
    const major = parseInt(v.replace("v", "").split(".")[0], 10);
    if (major < 20) {
      console.error(`  \u2717 node: v${major} too old (need v20+). Install from https://nodejs.org`);
      process.exit(1);
    }
    console.log(`  \u2713 node: ${v}`);
  } catch {
    console.error("  \u2717 node: NOT FOUND \u2014 install from https://nodejs.org");
    process.exit(1);
  }
  let claudeOk = false;
  try {
    const v = (0, import_child_process8.execSync)("claude --version", { encoding: "utf-8", stdio: "pipe" }).trim().split("\n")[0];
    console.log(`  \u2713 claude: ${v}`);
    claudeOk = true;
  } catch {
    console.log("  \u2717 claude: NOT FOUND");
    console.log("    Auto-installing Claude Code...");
    if (tryInstallGlobal("@anthropic-ai/claude-code")) {
      try {
        const v = (0, import_child_process8.execSync)("claude --version", { encoding: "utf-8", stdio: "pipe" }).trim().split("\n")[0];
        console.log(`  \u2713 claude: ${v} (just installed)`);
        claudeOk = true;
      } catch {
      }
    }
    if (!claudeOk) {
      console.error("  \u2717 Could not install Claude Code. Install manually:");
      console.error("    npm install -g @anthropic-ai/claude-code");
      process.exit(1);
    }
  }
  {
    let authenticated = false;
    try {
      const authOutput = (0, import_child_process8.execSync)("claude auth status", { encoding: "utf-8", stdio: "pipe" }).trim();
      if (authOutput.includes('"loggedIn": true') || authOutput.includes('"loggedIn":true')) {
        authenticated = true;
      }
    } catch {
      if (process.env.ANTHROPIC_API_KEY) {
        authenticated = true;
      }
    }
    if (!authenticated) {
      console.log("");
      console.log("  ! Claude Code is not authenticated.");
      console.log("    Run: claude login");
      console.log("    Agents will not start until you authenticate.");
      console.log("    You can run this after installation completes.");
      console.log("");
    } else {
      console.log("  \u2713 claude: authenticated");
    }
  }
  try {
    require("node-pty");
    console.log("  \u2713 node-pty: native module loaded");
  } catch (err) {
    console.error("  \u2717 node-pty: native module failed to load");
    console.error(`    Error: ${err.message}`);
    if (IS_MAC) {
      console.error("    Install Xcode Command Line Tools: xcode-select --install");
    } else if (IS_WINDOWS2) {
      console.error('    Install "Desktop development with C++" workload from Visual Studio Build Tools:');
      console.error("    https://visualstudio.microsoft.com/visual-cpp-build-tools/");
      console.error("    Then run: npm rebuild node-pty");
    } else {
      console.error("    Install build tools: sudo apt-get install -y build-essential python3");
    }
    console.error("    Then run: npm install (in the cortextOS directory)");
    process.exit(1);
  }
  if (!IS_WINDOWS2) {
    const fixed = fixSpawnHelper(process.cwd());
    if (fixed) {
      console.log("  \u2713 node-pty: spawn-helper permissions fixed");
    }
  }
  {
    try {
      const pty = require("node-pty");
      let output = "";
      const smokeCmd = IS_WINDOWS2 ? "cmd.exe" : "/bin/echo";
      const smokeArgs = IS_WINDOWS2 ? ["/c", "echo", "pty-ok"] : ["pty-ok"];
      const p = pty.spawn(smokeCmd, smokeArgs, { name: "xterm-256color", cols: 80, rows: 24 });
      await new Promise((resolve4, reject) => {
        p.onData((data) => {
          output += data;
        });
        p.onExit(({ exitCode }) => {
          if (exitCode === 0 && output.includes("pty-ok")) resolve4();
          else reject(new Error(`spawn test failed (exit ${exitCode})`));
        });
        setTimeout(() => reject(new Error("spawn test timed out")), 5e3);
      });
      console.log("  \u2713 node-pty: spawn test passed");
    } catch (err) {
      console.error("  \u2717 node-pty: spawn test failed");
      console.error(`    Error: ${err.message}`);
      console.error("    The daemon will not be able to start agents.");
      console.error("    Try: npm rebuild node-pty");
      process.exit(1);
    }
  }
  if (!commandExists2("pm2")) {
    console.log("  - pm2: not found. Installing...");
    if (tryInstallGlobal("pm2")) {
      try {
        const v = (0, import_child_process8.execSync)("pm2 --version", { encoding: "utf-8", stdio: "pipe" }).trim();
        console.log(`  \u2713 pm2: ${v} (just installed)`);
      } catch {
        console.log("  \u2713 pm2: installed (restart terminal if pm2 not in PATH)");
      }
    } else {
      console.log("  ! pm2: could not auto-install. Run: npm install -g pm2");
    }
  } else {
    try {
      const v = (0, import_child_process8.execSync)("pm2 --version", { encoding: "utf-8", stdio: "pipe" }).trim();
      console.log(`  \u2713 pm2: ${v}`);
    } catch {
      console.log("  \u2713 pm2: installed");
    }
  }
  if (!commandExists2("jq")) {
    console.log("  - jq: not found. Installing...");
    const installed = tryInstallJq();
    if (installed && commandExists2("jq")) {
      const v = (0, import_child_process8.execSync)("jq --version", { encoding: "utf-8", stdio: "pipe" }).trim();
      console.log(`  \u2713 jq: ${v} (just installed)`);
    } else {
      console.log("  ! jq: could not auto-install.");
      if (IS_MAC) console.log("    Install with: brew install jq");
      else if (IS_WINDOWS2) console.log("    Install with: winget install jqlang.jq");
      else console.log("    Install with: sudo apt-get install -y jq");
      console.log("    Agent bus scripts (messaging, tasks) will not work without jq.");
    }
  } else {
    try {
      const v = (0, import_child_process8.execSync)("jq --version", { encoding: "utf-8", stdio: "pipe" }).trim();
      console.log(`  \u2713 jq: ${v}`);
    } catch {
      console.log("  \u2713 jq: installed");
    }
  }
  const kbVenvDir = (0, import_path33.join)(process.cwd(), "knowledge-base", "venv");
  const kbReqs = (0, import_path33.join)(process.cwd(), "knowledge-base", "scripts", "requirements.txt");
  const python3Cmd = IS_WINDOWS2 ? "python" : "python3";
  if (commandExists2(python3Cmd)) {
    if (!(0, import_fs31.existsSync)(kbVenvDir)) {
      console.log("  - Knowledge Base venv: not found. Creating...");
      const venvResult = (0, import_child_process8.spawnSync)(python3Cmd, ["-m", "venv", kbVenvDir], { stdio: "inherit", timeout: 6e4 });
      if (venvResult.status === 0) {
        console.log("  \u2713 Knowledge Base venv created");
        if ((0, import_fs31.existsSync)(kbReqs)) {
          const pip = IS_WINDOWS2 ? (0, import_path33.join)(kbVenvDir, "Scripts", "pip") : (0, import_path33.join)(kbVenvDir, "bin", "pip");
          const pipResult = (0, import_child_process8.spawnSync)(pip, ["install", "--quiet", "-r", kbReqs], { stdio: "inherit", timeout: 12e4 });
          if (pipResult.status === 0) {
            console.log("  \u2713 Knowledge Base dependencies installed");
          } else {
            console.log("  ! Knowledge Base dependencies failed to install. Run kb-setup.sh manually.");
          }
        }
      } else {
        console.log("  ! Could not create Knowledge Base venv. Run: bus/kb-setup.sh --org <org>");
      }
    } else {
      console.log("  \u2713 Knowledge Base venv exists");
    }
  } else {
    console.log(`  ! ${python3Cmd}: not found. Knowledge Base requires Python 3.`);
    if (IS_WINDOWS2) console.log("    Install from: https://www.python.org/downloads/");
    else console.log("    Install with: sudo apt-get install -y python3 python3-venv");
  }
  console.log("");
  console.log("Creating state directories...");
  const dirs = [
    ctxRoot,
    (0, import_path33.join)(ctxRoot, "config"),
    (0, import_path33.join)(ctxRoot, "state"),
    (0, import_path33.join)(ctxRoot, "state", "oauth"),
    (0, import_path33.join)(ctxRoot, "state", "usage"),
    (0, import_path33.join)(ctxRoot, "inbox"),
    (0, import_path33.join)(ctxRoot, "inflight"),
    (0, import_path33.join)(ctxRoot, "processed"),
    (0, import_path33.join)(ctxRoot, "outbox"),
    (0, import_path33.join)(ctxRoot, "logs"),
    (0, import_path33.join)(ctxRoot, "orgs")
  ];
  for (const dir of dirs) {
    (0, import_fs31.mkdirSync)(dir, { recursive: true });
    try {
      (0, import_fs31.chmodSync)(dir, 448);
    } catch {
    }
  }
  console.log(`  Created ${dirs.length} directories at ${ctxRoot}`);
  const enabledPath = (0, import_path33.join)(ctxRoot, "config", "enabled-agents.json");
  if (!(0, import_fs31.existsSync)(enabledPath)) {
    (0, import_fs31.writeFileSync)(enabledPath, "{}", "utf-8");
    console.log("  Created enabled-agents.json");
  }
  const envPath = (0, import_path33.join)(ctxRoot, ".env");
  if (!(0, import_fs31.existsSync)(envPath)) {
    (0, import_fs31.writeFileSync)(envPath, [
      `CTX_INSTANCE_ID=${instanceId}`,
      `CTX_ROOT=${ctxRoot}`,
      ""
    ].join("\n"), "utf-8");
    try {
      (0, import_fs31.chmodSync)(envPath, 384);
    } catch {
    }
    console.log("  Created .env");
  }
  const signingKeyPath = (0, import_path33.join)(ctxRoot, "config", "bus-signing-key");
  if (!(0, import_fs31.existsSync)(signingKeyPath)) {
    const signingKey = (0, import_crypto5.randomBytes)(32).toString("hex");
    (0, import_fs31.writeFileSync)(signingKeyPath, signingKey, "utf-8");
    try {
      (0, import_fs31.chmodSync)(signingKeyPath, 384);
    } catch {
    }
    console.log("  Generated bus-signing-key (HMAC-SHA256)");
  }
  const dashEnvPath = (0, import_path33.join)(ctxRoot, "dashboard.env");
  let authSecret;
  let adminPassword;
  if ((0, import_fs31.existsSync)(dashEnvPath)) {
    const existing = (0, import_fs31.readFileSync)(dashEnvPath, "utf-8");
    const lines = Object.fromEntries(
      existing.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    );
    authSecret = lines["AUTH_SECRET"] || (0, import_crypto5.randomBytes)(32).toString("hex");
    adminPassword = lines["ADMIN_PASSWORD"] || (0, import_crypto5.randomBytes)(12).toString("hex");
  } else {
    authSecret = (0, import_crypto5.randomBytes)(32).toString("hex");
    adminPassword = (0, import_crypto5.randomBytes)(12).toString("hex");
  }
  (0, import_fs31.writeFileSync)(
    dashEnvPath,
    [
      `AUTH_SECRET=${authSecret}`,
      `ADMIN_USERNAME=admin`,
      `ADMIN_PASSWORD=${adminPassword}`,
      `CTX_ROOT=${ctxRoot}`,
      `CTX_FRAMEWORK_ROOT=${process.cwd()}`,
      ""
    ].join("\n"),
    "utf-8"
  );
  try {
    (0, import_fs31.chmodSync)(dashEnvPath, 384);
  } catch {
  }
  console.log(`  Generated dashboard credentials at ${dashEnvPath}`);
  console.log("Registering cortextos CLI globally...");
  const linkResult = IS_WINDOWS2 ? (0, import_child_process8.spawnSync)("npm link", { stdio: "pipe", cwd: process.cwd(), timeout: 3e4, shell: true }) : (0, import_child_process8.spawnSync)("npm", ["link"], { stdio: "pipe", cwd: process.cwd(), timeout: 3e4 });
  if (linkResult.status === 0) {
    console.log("  \u2713 cortextos registered globally (npm link)");
  } else {
    console.log("  ! npm link failed. Run manually: npm link (from the cortextOS directory)");
    console.log("    Without this, agents cannot use bus commands in PTY sessions.");
  }
  console.log("\n  Installation complete.");
  console.log(`  State directory: ${ctxRoot}`);
  console.log(`
  Dashboard credentials saved to: ${dashEnvPath}`);
  console.log(`    Admin username: admin`);
  console.log(`    Admin credentials saved to: ${dashEnvPath}`);
  console.log(`    (View password with: cat ${dashEnvPath})`);
  console.log("\n  Next steps:");
  console.log("    1. cortextos init <org-name>");
  console.log("    2. cortextos add-agent <name> --template orchestrator");
  console.log("    3. cortextos ecosystem && pm2 start ecosystem.config.js");
  console.log("    4. cortextos dashboard\n");
});
function fixSpawnHelper(projectRoot) {
  const prebuildsDir = (0, import_path33.join)(projectRoot, "node_modules", "node-pty", "prebuilds");
  const buildRelease = (0, import_path33.join)(projectRoot, "node_modules", "node-pty", "build", "Release");
  let fixed = false;
  if ((0, import_fs31.existsSync)(prebuildsDir)) {
    try {
      for (const platformDir of (0, import_fs31.readdirSync)(prebuildsDir)) {
        const helperPath = (0, import_path33.join)(prebuildsDir, platformDir, "spawn-helper");
        if ((0, import_fs31.existsSync)(helperPath)) {
          try {
            const mode = (0, import_fs31.statSync)(helperPath).mode;
            if ((mode & 73) === 0) {
              (0, import_fs31.chmodSync)(helperPath, 493);
              fixed = true;
            }
          } catch {
          }
        }
      }
    } catch {
    }
  }
  const buildHelper = (0, import_path33.join)(buildRelease, "spawn-helper");
  if ((0, import_fs31.existsSync)(buildHelper)) {
    try {
      const mode = (0, import_fs31.statSync)(buildHelper).mode;
      if ((mode & 73) === 0) {
        (0, import_fs31.chmodSync)(buildHelper, 493);
        fixed = true;
      }
    } catch {
    }
  }
  return fixed;
}

// src/cli/enable-agent.ts
init_cjs_shims();
var import_commander12 = require("commander");
var import_fs32 = require("fs");
var import_path34 = require("path");
var import_os13 = require("os");
init_api();
function discoverProjectRoot() {
  if (process.env.CTX_FRAMEWORK_ROOT) return process.env.CTX_FRAMEWORK_ROOT;
  if (process.env.CTX_PROJECT_ROOT) return process.env.CTX_PROJECT_ROOT;
  const canonical = (0, import_path34.join)((0, import_os13.homedir)(), "cortextos");
  if ((0, import_fs32.existsSync)((0, import_path34.join)(canonical, "orgs")) || (0, import_fs32.existsSync)((0, import_path34.join)(canonical, "agents"))) {
    return canonical;
  }
  return process.cwd();
}
function parseEnvFile2(path) {
  const vars = {};
  try {
    const lines = (0, import_fs32.readFileSync)(path, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      vars[key] = val;
    }
  } catch {
  }
  return vars;
}
function getEnabledAgentsPath(instanceId) {
  return (0, import_path34.join)((0, import_os13.homedir)(), ".cortextos", instanceId, "config", "enabled-agents.json");
}
function readEnabledAgents(instanceId) {
  const path = getEnabledAgentsPath(instanceId);
  if (!(0, import_fs32.existsSync)(path)) return {};
  let raw;
  try {
    raw = (0, import_fs32.readFileSync)(path, "utf-8");
  } catch (err) {
    console.error(`[enable] Failed to read ${path}: ${err}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backup = `${path}.broken-${Date.now()}`;
    try {
      (0, import_fs32.writeFileSync)(backup, raw);
    } catch {
    }
    console.error(`[enable] WARNING: ${path} contains invalid JSON. Backed up to ${backup}. Treating as empty.`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const backup = `${path}.broken-${Date.now()}`;
    try {
      (0, import_fs32.writeFileSync)(backup, raw);
    } catch {
    }
    console.error(`[enable] WARNING: ${path} is not a JSON object (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}). Backed up to ${backup}. Treating as empty.`);
    return {};
  }
  return parsed;
}
function writeDisableMarker(instanceId, agent, reason) {
  try {
    const ctxRoot = (0, import_path34.join)((0, import_os13.homedir)(), ".cortextos", instanceId);
    const stateDir = (0, import_path34.join)(ctxRoot, "state", agent);
    (0, import_fs32.mkdirSync)(stateDir, { recursive: true });
    (0, import_fs32.writeFileSync)((0, import_path34.join)(stateDir, ".user-disable"), reason);
  } catch {
  }
}
function writeEnabledAgents(instanceId, agents) {
  const path = getEnabledAgentsPath(instanceId);
  const dir = (0, import_path34.join)((0, import_os13.homedir)(), ".cortextos", instanceId, "config");
  (0, import_fs32.mkdirSync)(dir, { recursive: true });
  (0, import_fs32.writeFileSync)(path, JSON.stringify(agents, null, 2) + "\n", "utf-8");
}
var enableAgentCommand = new import_commander12.Command("enable").argument("<agent>", "Agent name to enable").option("--instance <id>", "Instance ID", "default").option("--org <org>", "Organization name").description("Enable an agent (register and start)").action(async (agent, options) => {
  const projectRoot = discoverProjectRoot();
  if (!options.org) {
    const orgsDir = (0, import_path34.join)(projectRoot, "orgs");
    if ((0, import_fs32.existsSync)(orgsDir)) {
      try {
        const { readdirSync: readdirSync18 } = require("fs");
        const orgs = readdirSync18(orgsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        for (const o of orgs) {
          if ((0, import_fs32.existsSync)((0, import_path34.join)(orgsDir, o, "agents", agent))) {
            options.org = o;
            break;
          }
        }
      } catch {
      }
    }
  }
  const orgDir = options.org ? (0, import_path34.join)(projectRoot, "orgs", options.org) : null;
  let agentEnvPath = null;
  if (orgDir) {
    const candidate = (0, import_path34.join)(orgDir, "agents", agent, ".env");
    if ((0, import_fs32.existsSync)(candidate)) agentEnvPath = candidate;
  }
  if (!agentEnvPath) {
    const candidate = (0, import_path34.join)(projectRoot, "agents", agent, ".env");
    if ((0, import_fs32.existsSync)(candidate)) agentEnvPath = candidate;
  }
  if (!agentEnvPath) {
    console.error(`Error: No .env found for agent "${agent}". Checked:`);
    if (orgDir) console.error(`  - ${(0, import_path34.join)(orgDir, "agents", agent, ".env")}`);
    console.error(`  - ${(0, import_path34.join)(projectRoot, "agents", agent, ".env")}`);
    console.error(`Project root: ${projectRoot}`);
    console.error(`(Set CTX_FRAMEWORK_ROOT to override path discovery, or run from inside ~/cortextos.)`);
    console.error(`Create the .env with BOT_TOKEN and CHAT_ID before enabling.`);
    process.exit(1);
  }
  const env = parseEnvFile2(agentEnvPath);
  const missing = ["BOT_TOKEN", "CHAT_ID"].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`Error: .env for agent "${agent}" is missing required values: ${missing.join(", ")}`);
    console.error(`Edit ${agentEnvPath} and set BOT_TOKEN and CHAT_ID before enabling.`);
    process.exit(1);
  }
  try {
    const telegramApi = new TelegramAPI(env.BOT_TOKEN);
    const validation = await telegramApi.validateCredentials(env.CHAT_ID);
    if (validation.ok) {
      const label = validation.chatTitle ? ` (${validation.chatTitle})` : "";
      console.log(
        `Telegram validated: bot=@${validation.botUsername} chat=${env.CHAT_ID} type=${validation.chatType}${label}`
      );
    } else if (validation.reason === "network_error" || validation.reason === "rate_limited") {
      console.error(`Warning: could not verify Telegram credentials (${validation.reason}).`);
      console.error(`  ${formatValidateError(validation)}`);
      console.error("  Continuing anyway \u2014 re-run enable after connectivity is restored to confirm.");
    } else {
      console.error(`Error: Telegram credentials for agent "${agent}" failed validation.`);
      console.error(`  ${formatValidateError(validation)}`);
      console.error(`  Edit ${agentEnvPath} and re-run: cortextos enable ${agent}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Warning: Telegram credential validation crashed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("  Continuing enable. Investigate the validator if this recurs.");
  }
  const agents = readEnabledAgents(options.instance);
  agents[agent] = {
    enabled: true,
    status: "configured",
    ...options.org ? { org: options.org } : {}
  };
  writeEnabledAgents(options.instance, agents);
  const ctxRoot = (0, import_path34.join)((0, import_os13.homedir)(), ".cortextos", options.instance);
  const agentDirs = [
    (0, import_path34.join)(ctxRoot, "inbox", agent),
    (0, import_path34.join)(ctxRoot, "inflight", agent),
    (0, import_path34.join)(ctxRoot, "processed", agent),
    (0, import_path34.join)(ctxRoot, "outbox", agent),
    (0, import_path34.join)(ctxRoot, "logs", agent),
    (0, import_path34.join)(ctxRoot, "state", agent)
  ];
  for (const dir of agentDirs) {
    (0, import_fs32.mkdirSync)(dir, { recursive: true });
  }
  console.log(`Agent "${agent}" enabled.`);
  const ipc = new IPCClient(options.instance);
  const running = await ipc.isDaemonRunning();
  if (running) {
    const response = await ipc.send({ type: "start-agent", agent, source: "cortextos enable" });
    if (response.success) {
      console.log(`  Started via daemon: ${response.data}`);
    }
  } else {
    console.log("  Daemon not running. Start with: cortextos start");
  }
});
var disableAgentCommand = new import_commander12.Command("disable").argument("<agent>", "Agent name to disable").option("--instance <id>", "Instance ID", "default").description("Disable an agent (stop and deregister)").action(async (agent, options) => {
  const agents = readEnabledAgents(options.instance);
  if (agents[agent]) {
    agents[agent].enabled = false;
  }
  writeEnabledAgents(options.instance, agents);
  const ipc = new IPCClient(options.instance);
  const running = await ipc.isDaemonRunning();
  if (running) {
    writeDisableMarker(options.instance, agent, "disabled via cortextos disable");
    const response = await ipc.send({ type: "stop-agent", agent, source: "cortextos disable" });
    if (response.success) {
      console.log(`Agent "${agent}" disabled and stopped.`);
    } else {
      console.log(`Agent "${agent}" disabled. Stop failed: ${response.error}`);
    }
  } else {
    console.log(`Agent "${agent}" disabled.`);
  }
});

// src/cli/ecosystem.ts
init_cjs_shims();
var import_commander13 = require("commander");
var import_fs33 = require("fs");
var import_path35 = require("path");
var import_os14 = require("os");
var ecosystemCommand = new import_commander13.Command("ecosystem").option("--instance <id>", "Instance ID", "default").option("--org <name>", "Organization name (auto-detected if not specified)").option("--output <path>", "Output file", "ecosystem.config.js").description("Generate PM2 ecosystem.config.js from agent configs").action(async (options) => {
  const ctxRoot = (0, import_path35.join)((0, import_os14.homedir)(), ".cortextos", options.instance);
  let projectRoot;
  if (process.env.CTX_FRAMEWORK_ROOT) {
    projectRoot = process.env.CTX_FRAMEWORK_ROOT;
  } else if (process.env.CTX_PROJECT_ROOT) {
    projectRoot = process.env.CTX_PROJECT_ROOT;
  } else {
    const canonical = (0, import_path35.join)((0, import_os14.homedir)(), "cortextos");
    projectRoot = (0, import_fs33.existsSync)((0, import_path35.join)(canonical, "orgs")) ? canonical : process.cwd();
  }
  const agents = [];
  const orgsDir = (0, import_path35.join)(projectRoot, "orgs");
  if ((0, import_fs33.existsSync)(orgsDir)) {
    for (const org of (0, import_fs33.readdirSync)(orgsDir, { withFileTypes: true })) {
      if (!org.isDirectory()) continue;
      const agentsDir = (0, import_path35.join)(orgsDir, org.name, "agents");
      if (!(0, import_fs33.existsSync)(agentsDir)) continue;
      for (const agent of (0, import_fs33.readdirSync)(agentsDir, { withFileTypes: true })) {
        if (!agent.isDirectory()) continue;
        agents.push({ name: agent.name, dir: (0, import_path35.join)(agentsDir, agent.name), org: org.name });
      }
    }
  }
  if (agents.length === 0) {
    console.log("No agents found. Add agents first: cortextos add-agent <name>");
    return;
  }
  const detectedOrg = options.org || agents.find((a) => a.org)?.org || "";
  if (!detectedOrg) {
    console.error("Could not determine org. Use --org <name>.");
    return;
  }
  const distDir = (0, import_path35.join)(projectRoot, "dist");
  const daemonScript = (0, import_path35.join)(distDir, "daemon.js");
  const dashboardDir = (0, import_path35.join)(projectRoot, "dashboard");
  const hasDashboard = (0, import_fs33.existsSync)((0, import_path35.join)(dashboardDir, "package.json")) && (0, import_fs33.existsSync)((0, import_path35.join)(dashboardDir, "node_modules", ".bin", "next"));
  const dashboardAppBlock = hasDashboard ? `,
    {
      name: 'cortextos-dashboard',
      script: 'npm',
      args: 'run dev',
      cwd: ${JSON.stringify(dashboardDir)},
      env: {
        PORT: process.env.PORT || '3000',
      },
      // Dashboard reads its real config from dashboard/.env.local \u2014 populated
      // by /onboarding Phase 7. PM2 just supervises the npm process.
      max_restarts: 50,
      restart_delay: 5000,
      autorestart: true,
    }` : "";
  const content = `// AUTO-GENERATED by \`cortextos ecosystem\`. Do NOT edit by hand.
// Re-run \`cortextos ecosystem\` to regenerate.
//
// Note: env vars use process.env.X || 'default' so PM2 picks up the value
// from the calling shell at startup time. This means \`CTX_INSTANCE_ID=foo
// pm2 restart cortextos-daemon\` switches instances without regenerating.
module.exports = {
  apps: [
    {
      name: 'cortextos-daemon',
      script: ${JSON.stringify(daemonScript)},
      args: '--instance ' + (process.env.CTX_INSTANCE_ID || ${JSON.stringify(options.instance)}),
      cwd: ${JSON.stringify(projectRoot)},
      env: {
        CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID || ${JSON.stringify(options.instance)},
        CTX_ROOT: process.env.CTX_ROOT || ${JSON.stringify(ctxRoot)},
        CTX_FRAMEWORK_ROOT: ${JSON.stringify(projectRoot)},
        CTX_PROJECT_ROOT: ${JSON.stringify(projectRoot)},
        CTX_ORG: process.env.CTX_ORG || ${JSON.stringify(detectedOrg)},
      },
      max_restarts: 50,
      restart_delay: 5000,
      autorestart: true,
    }${dashboardAppBlock},
  ],
};
`;
  (0, import_fs33.writeFileSync)(options.output, content, "utf-8");
  console.log(`Generated ${options.output} with daemon (manages ${agents.length} agents)${hasDashboard ? " + dashboard" : ""}`);
  console.log("\nStart with:");
  console.log(`  pm2 start ${options.output}`);
  console.log("  pm2 save");
});

// src/cli/uninstall.ts
init_cjs_shims();
var import_commander14 = require("commander");
var import_fs34 = require("fs");
var import_path36 = require("path");
var import_os15 = require("os");
var import_child_process9 = require("child_process");
var uninstallCommand = new import_commander14.Command("uninstall").option("--instance <id>", "Instance ID", "default").option("--force", "Skip confirmation").option("--keep-state", "Remove agent config but preserve state directory (logs, tasks, heartbeats)").description("Remove cortextOS state directories and PM2 processes").action(async (options) => {
  const instanceId = options.instance;
  const ctxRoot = (0, import_path36.join)((0, import_os15.homedir)(), ".cortextos", instanceId);
  if (!(0, import_fs34.existsSync)(ctxRoot)) {
    console.log(`No cortextOS state found at ${ctxRoot}`);
    return;
  }
  console.log(`
Uninstalling cortextOS instance: ${instanceId}`);
  console.log(`  State directory: ${ctxRoot}`);
  if (options.keepState) {
    console.log("  Mode: --keep-state (preserving state directory, removing agent config only)\n");
  } else {
    console.log("");
  }
  try {
    const pm2Result = (0, import_child_process9.spawnSync)("pm2", ["jlist"], {
      encoding: "utf-8",
      timeout: 5e3,
      stdio: "pipe"
    });
    if (pm2Result.status === 0 && pm2Result.stdout) {
      const processes = JSON.parse(pm2Result.stdout);
      const cortextosProcesses = processes.filter(
        (p) => p.name.startsWith("cortextos-") || p.name.startsWith(`ctx-${instanceId}`)
      );
      for (const p of cortextosProcesses) {
        const del = (0, import_child_process9.spawnSync)("pm2", ["delete", p.name], { timeout: 5e3, stdio: "pipe" });
        if (del.status === 0) {
          console.log(`  Stopped PM2 process: ${p.name}`);
        }
      }
    }
  } catch {
  }
  if (options.keepState) {
    const enabledFile = (0, import_path36.join)(ctxRoot, "config", "enabled-agents.json");
    if ((0, import_fs34.existsSync)(enabledFile)) {
      try {
        (0, import_fs34.rmSync)(enabledFile);
        console.log("  Removed enabled-agents.json");
      } catch {
      }
    }
    console.log("  Preserved state directory (logs, tasks, heartbeats, analytics)");
  } else {
    try {
      (0, import_fs34.rmSync)(ctxRoot, { recursive: true, force: true });
      console.log(`  Removed state directory: ${ctxRoot}`);
    } catch (err) {
      console.error(`  Failed to remove ${ctxRoot}: ${err}`);
    }
  }
  const ecosystemPath = (0, import_path36.join)(process.cwd(), "ecosystem.config.js");
  if ((0, import_fs34.existsSync)(ecosystemPath)) {
    try {
      (0, import_fs34.rmSync)(ecosystemPath);
      console.log("  Removed ecosystem.config.js");
    } catch {
    }
  }
  console.log("\n  cortextOS uninstalled.");
});

// src/cli/dashboard.ts
init_cjs_shims();
var import_commander15 = require("commander");
var import_fs35 = require("fs");
var import_path37 = require("path");
var import_os16 = require("os");
var import_crypto6 = require("crypto");
var IS_WINDOWS3 = (0, import_os16.platform)() === "win32";
function parseEnvFile3(filePath) {
  const result = {};
  try {
    for (const line of (0, import_fs35.readFileSync)(filePath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        let val = trimmed.slice(idx + 1);
        if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
          val = val.slice(1, -1);
        }
        result[trimmed.slice(0, idx)] = val;
      }
    }
  } catch {
  }
  return result;
}
var dashboardCommand = new import_commander15.Command("dashboard").option("--port <port>", "Port to run dashboard on", "3000").option("--instance <id>", "Instance ID", "default").option("--build", "Build for production first (recommended for Cloudflare Tunnel / remote access)").option("--install", "Install dashboard dependencies first").description("Start the cortextOS dashboard (Next.js)").action(async (options) => {
  const { execSync: execSync8, spawn: spawn2 } = require("child_process");
  const dashboardDir = findDashboardDir();
  if (!dashboardDir) {
    console.error("Dashboard not found. Expected at ./dashboard or in node_modules.");
    process.exit(1);
  }
  const ctxRoot = (0, import_path37.join)((0, import_os16.homedir)(), ".cortextos", options.instance);
  const dashEnvPath = (0, import_path37.join)(ctxRoot, "dashboard.env");
  let dashCreds = {};
  if ((0, import_fs35.existsSync)(dashEnvPath)) {
    dashCreds = parseEnvFile3(dashEnvPath);
  }
  let authSecret = process.env.AUTH_SECRET || dashCreds["AUTH_SECRET"];
  if (!authSecret) {
    authSecret = (0, import_crypto6.randomBytes)(32).toString("hex");
    console.log("\n  AUTH_SECRET not set \u2014 generating one automatically.");
    dashCreds["AUTH_SECRET"] = authSecret;
    dashCreds["ADMIN_USERNAME"] = dashCreds["ADMIN_USERNAME"] || "admin";
    if (!dashCreds["ADMIN_PASSWORD"]) {
      dashCreds["ADMIN_PASSWORD"] = (0, import_crypto6.randomBytes)(12).toString("hex");
      console.log(`  Generated admin credentials saved to: ${dashEnvPath}`);
      console.log(`  (View password with: cat ${dashEnvPath})`);
    }
    const content = Object.entries(dashCreds).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    (0, import_fs35.writeFileSync)(dashEnvPath, content, "utf-8");
    try {
      (0, import_fs35.chmodSync)(dashEnvPath, 384);
    } catch {
    }
  }
  const adminPassword = process.env.ADMIN_PASSWORD || dashCreds["ADMIN_PASSWORD"];
  if (!adminPassword) {
    console.error("\nERROR: ADMIN_PASSWORD is not set.");
    console.error("Run: cortextos install  (auto-generates dashboard credentials)");
    console.error(`Or set ADMIN_PASSWORD in your environment or ${dashEnvPath}`);
    process.exit(1);
  }
  const adminUsername = process.env.ADMIN_USERNAME || dashCreds["ADMIN_USERNAME"] || "admin";
  if (options.install || !(0, import_fs35.existsSync)((0, import_path37.join)(dashboardDir, "node_modules"))) {
    console.log("\nInstalling dashboard dependencies...");
    try {
      execSync8("npm install", { cwd: dashboardDir, stdio: "inherit", timeout: 12e4 });
    } catch (err) {
      console.error("Failed to install dashboard dependencies:", err);
      process.exit(1);
    }
  }
  if (options.build) {
    console.log("\nBuilding dashboard for production...");
    try {
      execSync8("npm run build", {
        cwd: dashboardDir,
        stdio: "inherit",
        timeout: 3e5,
        env: {
          ...process.env,
          AUTH_SECRET: authSecret,
          ADMIN_PASSWORD: adminPassword,
          ADMIN_USERNAME: adminUsername,
          CTX_ROOT: ctxRoot
        }
      });
    } catch (err) {
      console.error("Dashboard build failed:", err);
      process.exit(1);
    }
  }
  const nextEnvPath = (0, import_path37.join)(dashboardDir, ".env.local");
  const nextEnvLines = [
    "# AUTO-GENERATED by cortextos dashboard. To change credentials, edit:",
    `# ${(0, import_path37.join)(ctxRoot, "dashboard.env")}`,
    `AUTH_SECRET=${authSecret}`,
    `AUTH_TRUST_HOST=true`,
    `ADMIN_USERNAME=${adminUsername}`,
    `ADMIN_PASSWORD=${adminPassword}`,
    `CTX_ROOT=${ctxRoot}`,
    `CTX_FRAMEWORK_ROOT=${process.cwd()}`,
    `CTX_INSTANCE_ID=${options.instance}`,
    `PORT=${options.port}`
  ];
  (0, import_fs35.writeFileSync)(nextEnvPath, nextEnvLines.join("\n") + "\n", "utf-8");
  try {
    (0, import_fs35.chmodSync)(nextEnvPath, 384);
  } catch {
  }
  const dashEnv = {
    ...process.env,
    PORT: options.port,
    AUTH_SECRET: authSecret,
    ADMIN_USERNAME: adminUsername,
    ADMIN_PASSWORD: adminPassword,
    CTX_ROOT: ctxRoot,
    CTX_FRAMEWORK_ROOT: process.cwd(),
    CTX_INSTANCE_ID: options.instance,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST || "true"
  };
  const startMode = options.build ? "start" : "dev";
  const startArgs = startMode === "start" ? ["next", "start", "--port", options.port] : ["next", "dev", "--port", options.port];
  console.log(`
Dashboard starting on http://localhost:${options.port}`);
  console.log(`  Admin username: ${adminUsername}`);
  console.log(`  Admin credentials: ${dashEnvPath}`);
  console.log(`  (View password with: cat ${dashEnvPath})`);
  if (options.build) {
    console.log("  Mode: production");
  } else {
    console.log("  Mode: dev (use --build for production/tunnel use)");
  }
  console.log("");
  const logDir = (0, import_path37.join)(ctxRoot, "logs", "dashboard");
  (0, import_fs35.mkdirSync)(logDir, { recursive: true });
  const logPath = (0, import_path37.join)(logDir, "dashboard.log");
  const logFd = (0, import_fs35.openSync)(logPath, "a");
  const child = IS_WINDOWS3 ? spawn2(["npx", ...startArgs].join(" "), { cwd: dashboardDir, stdio: ["ignore", logFd, logFd], env: dashEnv, shell: true, detached: true }) : spawn2("npx", startArgs, { cwd: dashboardDir, stdio: ["ignore", logFd, logFd], env: dashEnv, detached: true });
  child.unref();
  console.log(`  Log: ${logPath}`);
  console.log(`  PID: ${child.pid}`);
  child.on("error", (err) => {
    console.error("Failed to start dashboard:", err.message);
    process.exit(1);
  });
  process.on("SIGHUP", () => {
    process.exit(0);
  });
  const forwardAndExit = (sig) => {
    try {
      child.kill(sig);
    } catch {
    }
    process.exit(0);
  };
  process.on("SIGINT", () => forwardAndExit("SIGINT"));
  process.on("SIGTERM", () => forwardAndExit("SIGTERM"));
});
function findDashboardDir() {
  const candidates = [
    (0, import_path37.join)(process.cwd(), "dashboard"),
    (0, import_path37.join)(__dirname, "..", "..", "dashboard"),
    (0, import_path37.join)(process.cwd(), "node_modules", "cortextos", "dashboard")
  ];
  for (const dir of candidates) {
    if ((0, import_fs35.existsSync)((0, import_path37.join)(dir, "package.json"))) return dir;
  }
  return null;
}

// src/cli/tunnel.ts
init_cjs_shims();
var import_commander16 = require("commander");
var import_child_process10 = require("child_process");
var import_fs36 = require("fs");
var import_path38 = require("path");
var import_os17 = require("os");
var TUNNEL_NAME = "cortextos";
var PLIST_LABEL = "com.cortextos.tunnel";
var PLIST_PATH = (0, import_path38.join)((0, import_os17.homedir)(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
var CLOUDFLARED_CERT = (0, import_path38.join)((0, import_os17.homedir)(), ".cloudflared", "cert.pem");
var CLOUDFLARED_CONFIG = (0, import_path38.join)((0, import_os17.homedir)(), ".cloudflared", "config.yaml");
function getTunnelConfigPath(instance) {
  return (0, import_path38.join)((0, import_os17.homedir)(), ".cortextos", instance, "tunnel.json");
}
function readTunnelConfig(instance) {
  try {
    return JSON.parse((0, import_fs36.readFileSync)(getTunnelConfigPath(instance), "utf-8"));
  } catch {
    return {};
  }
}
function writeTunnelConfig(instance, config) {
  const configPath = getTunnelConfigPath(instance);
  (0, import_fs36.mkdirSync)((0, import_path38.join)((0, import_os17.homedir)(), ".cortextos", instance), { recursive: true });
  (0, import_fs36.writeFileSync)(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
function checkPlatform() {
  if (process.platform !== "darwin") {
    console.error("  cortextos tunnel requires macOS (uses launchd for persistence).");
    console.error("  On Linux/Windows, run cloudflared manually: cloudflared tunnel run cortextos");
    process.exit(1);
  }
}
function checkCloudflared() {
  try {
    const version = (0, import_child_process10.execSync)("cloudflared --version", { encoding: "utf-8", stdio: "pipe", timeout: 5e3 }).trim();
    return version;
  } catch {
    console.error("  cloudflared is not installed.");
    console.error("  Install with: brew install cloudflared");
    process.exit(1);
  }
}
function checkAuth() {
  if (!(0, import_fs36.existsSync)(CLOUDFLARED_CERT)) {
    console.error("  Not authenticated with Cloudflare.");
    console.error("  Run: cloudflared login");
    console.error("  Then re-run: cortextos tunnel start");
    process.exit(1);
  }
}
function getCloudflaredPath() {
  try {
    const fromWhich = (0, import_child_process10.execSync)("which cloudflared", { encoding: "utf-8", stdio: "pipe" }).trim();
    if (fromWhich) return fromWhich;
  } catch {
  }
  const candidates = [
    "/opt/homebrew/bin/cloudflared",
    // Apple Silicon
    "/usr/local/bin/cloudflared"
    // Intel Mac
  ];
  for (const p of candidates) {
    if ((0, import_fs36.existsSync)(p)) {
      console.warn(`  warning: cloudflared not on PATH \u2014 falling back to ${p}`);
      return p;
    }
  }
  console.warn("  warning: cloudflared not found on PATH or in common install locations");
  return "cloudflared";
}
function detectNodePath() {
  try {
    return (0, import_path38.join)(process.execPath, "..").replace(/\/$/, "");
  } catch {
    return "/usr/local/bin";
  }
}
function detectCloudflaredPath() {
  try {
    const cfPath = (0, import_child_process10.execSync)("which cloudflared", { encoding: "utf-8", stdio: "pipe" }).trim();
    if (cfPath) return (0, import_path38.join)(cfPath, "..").replace(/\/$/, "");
  } catch {
  }
  const candidates = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
  for (const p of candidates) {
    if ((0, import_fs36.existsSync)(p)) {
      console.warn(`  warning: cloudflared not on PATH \u2014 falling back to ${(0, import_path38.join)(p, "..")}`);
      return (0, import_path38.join)(p, "..").replace(/\/$/, "");
    }
  }
  console.warn("  warning: cloudflared directory not found \u2014 defaulting to /opt/homebrew/bin");
  return "/opt/homebrew/bin";
}
function findExistingTunnel() {
  try {
    const output = (0, import_child_process10.execSync)("cloudflared tunnel list --output json", {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 1e4
    });
    const tunnels = JSON.parse(output);
    return tunnels.find((t) => t.name === TUNNEL_NAME && !t.deleted_at) ?? null;
  } catch {
    return null;
  }
}
function createTunnel() {
  let output = "";
  try {
    output = (0, import_child_process10.execSync)(`cloudflared tunnel create --output json ${TUNNEL_NAME}`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 3e4
    });
  } catch (err) {
    console.error("  Failed to create tunnel:", err);
    process.exit(1);
  }
  try {
    const created = JSON.parse(output);
    return { id: created.id, name: created.name };
  } catch {
    const tunnel = findExistingTunnel();
    if (!tunnel) {
      console.error("  Tunnel was created but could not be found in list. Try running again.");
      process.exit(1);
    }
    return tunnel;
  }
}
function writeCloudflaredConfig(tunnelId, port) {
  const credFile = (0, import_path38.join)((0, import_os17.homedir)(), ".cloudflared", `${tunnelId}.json`);
  const config = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credFile}`,
    `ingress:`,
    `  - service: http://localhost:${port}`
  ].join("\n") + "\n";
  (0, import_fs36.writeFileSync)(CLOUDFLARED_CONFIG, config, "utf-8");
}
function writePlist(instance, port) {
  const cfPath = getCloudflaredPath();
  const nodeBinDir = detectNodePath();
  const cfBinDir = detectCloudflaredPath();
  const logDir = (0, import_path38.join)((0, import_os17.homedir)(), ".cortextos", instance, "logs", "tunnel");
  const ctxRoot = (0, import_path38.join)((0, import_os17.homedir)(), ".cortextos", instance);
  (0, import_fs36.mkdirSync)(logDir, { recursive: true });
  const launchdPath = [
    nodeBinDir,
    cfBinDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].filter((p, i, arr) => arr.indexOf(p) === i).join(":");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${cfPath}</string>
        <string>tunnel</string>
        <string>--no-autoupdate</string>
        <string>run</string>
        <string>${TUNNEL_NAME}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>${logDir}/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${logDir}/stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${(0, import_os17.homedir)()}</string>
        <key>PATH</key>
        <string>${launchdPath}</string>
        <key>CTX_ROOT</key>
        <string>${ctxRoot}</string>
    </dict>
</dict>
</plist>
`;
  (0, import_fs36.mkdirSync)((0, import_path38.join)((0, import_os17.homedir)(), "Library", "LaunchAgents"), { recursive: true });
  (0, import_fs36.writeFileSync)(PLIST_PATH, plist, "utf-8");
  (0, import_fs36.chmodSync)(PLIST_PATH, 420);
}
function isServiceLoaded() {
  const result = (0, import_child_process10.spawnSync)("launchctl", ["list", PLIST_LABEL], { stdio: "pipe" });
  return result.status === 0;
}
function getUid() {
  try {
    return (0, import_child_process10.execSync)("id -u", { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return String(process.getuid ? process.getuid() : 501);
  }
}
function loadService() {
  const uid = getUid();
  (0, import_child_process10.spawnSync)("launchctl", ["bootout", `gui/${uid}/${PLIST_LABEL}`], { stdio: "pipe" });
  (0, import_child_process10.spawnSync)("launchctl", ["bootout", `gui/${uid}`, PLIST_PATH], { stdio: "pipe" });
  const result = (0, import_child_process10.spawnSync)("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH], {
    encoding: "utf-8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    const legacyResult = (0, import_child_process10.spawnSync)("launchctl", ["load", "-w", PLIST_PATH], {
      encoding: "utf-8",
      stdio: "pipe"
    });
    if (legacyResult.status !== 0) {
      throw new Error(`Failed to load service: ${legacyResult.stderr || legacyResult.stdout}`);
    }
  }
}
function unloadService() {
  const uid = getUid();
  const result = (0, import_child_process10.spawnSync)("launchctl", ["bootout", `gui/${uid}/${PLIST_LABEL}`], {
    encoding: "utf-8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    (0, import_child_process10.spawnSync)("launchctl", ["unload", "-w", PLIST_PATH], { stdio: "pipe" });
  }
}
var startCommand2 = new import_commander16.Command("start").option("--instance <id>", "Instance ID", "default").option("--port <port>", "Dashboard port", "3000").description("Create (or reuse) the Cloudflare tunnel and start it as a launchd service").action(async (options) => {
  const port = parseInt(options.port, 10);
  checkPlatform();
  console.log("\ncortextOS Tunnel\n");
  const version = checkCloudflared();
  console.log(`  cloudflared: ${version}`);
  checkAuth();
  console.log(`  Cloudflare auth: OK`);
  let tunnel = findExistingTunnel();
  if (tunnel) {
    console.log(`  Tunnel: ${tunnel.name} (${tunnel.id}) \u2014 reusing existing`);
  } else {
    console.log(`  Creating tunnel '${TUNNEL_NAME}'...`);
    tunnel = createTunnel();
    console.log(`  Tunnel: ${tunnel.name} (${tunnel.id}) \u2014 created`);
  }
  const tunnelUrl = `https://${tunnel.id}.cfargotunnel.com`;
  writeCloudflaredConfig(tunnel.id, port);
  console.log(`  Config: ${CLOUDFLARED_CONFIG}`);
  writePlist(options.instance, port);
  console.log(`  Plist: ${PLIST_PATH}`);
  if (isServiceLoaded()) {
    console.log(`  Service: already running \u2014 reloading`);
  }
  loadService();
  console.log(`  Service: loaded (auto-starts on login)`);
  console.log(`  Waiting for tunnel to connect...`);
  let connected = false;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2e3));
    try {
      const res = (0, import_child_process10.execSync)("curl -sf http://localhost:20241/ready", {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 3e3
      });
      if (res.includes("OK") || res.trim() === "") {
        connected = true;
        break;
      }
    } catch {
    }
  }
  if (connected) {
    console.log(`  Tunnel: connected to Cloudflare edge`);
  } else {
    console.log(`  Tunnel: service started (health check timed out \u2014 may still be connecting)`);
  }
  writeTunnelConfig(options.instance, {
    tunnelId: tunnel.id,
    tunnelName: tunnel.name,
    tunnelUrl,
    port,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  console.log(`
  Dashboard URL: ${tunnelUrl}`);
  console.log(`  TUNNEL_URL saved to: ${getTunnelConfigPath(options.instance)}
`);
  console.log(`  The tunnel will restart automatically after reboot.`);
  console.log(`  Start the dashboard with: cortextos dashboard
`);
});
var stopCommand2 = new import_commander16.Command("stop").option("--instance <id>", "Instance ID", "default").description("Stop the Cloudflare tunnel launchd service").action(async (_options) => {
  checkPlatform();
  if (!(0, import_fs36.existsSync)(PLIST_PATH)) {
    console.log("  Tunnel service is not installed. Run: cortextos tunnel start");
    return;
  }
  if (!isServiceLoaded()) {
    console.log("  Tunnel service is not running.");
    return;
  }
  unloadService();
  console.log("  Tunnel service stopped.");
  console.log("  (The tunnel config is preserved \u2014 run `cortextos tunnel start` to restart)\n");
});
var statusCommand2 = new import_commander16.Command("status").option("--instance <id>", "Instance ID", "default").description("Show tunnel URL and running status").action(async (options) => {
  checkPlatform();
  console.log("\ncortextOS Tunnel Status\n");
  let cfVersion = "not installed";
  try {
    cfVersion = (0, import_child_process10.execSync)("cloudflared --version", { encoding: "utf-8", stdio: "pipe", timeout: 5e3 }).trim();
  } catch {
  }
  console.log(`  cloudflared: ${cfVersion}`);
  console.log(`  Cloudflare auth: ${(0, import_fs36.existsSync)(CLOUDFLARED_CERT) ? "OK" : "not authenticated (run: cloudflared login)"}`);
  const tunnel = findExistingTunnel();
  console.log(`  Tunnel '${TUNNEL_NAME}': ${tunnel ? `exists (${tunnel.id})` : "not created"}`);
  const running = isServiceLoaded();
  console.log(`  Service (launchd): ${running ? "running" : "stopped"}`);
  const config = readTunnelConfig(options.instance);
  if (config.tunnelUrl) {
    console.log(`  Dashboard URL: ${config.tunnelUrl}`);
  } else {
    console.log(`  Dashboard URL: not set (run: cortextos tunnel start)`);
  }
  if (config.createdAt) {
    console.log(`  Tunnel created: ${new Date(config.createdAt).toLocaleString()}`);
  }
  console.log("");
});
var urlCommand = new import_commander16.Command("url").option("--instance <id>", "Instance ID", "default").description("Print the tunnel URL (for scripting)").action(async (options) => {
  const config = readTunnelConfig(options.instance);
  if (!config.tunnelUrl) {
    console.error("No tunnel URL found. Run: cortextos tunnel start");
    process.exit(1);
  }
  process.stdout.write(config.tunnelUrl + "\n");
});
var tunnelCommand = new import_commander16.Command("tunnel").description("Manage Cloudflare tunnel for persistent dashboard access").addCommand(startCommand2).addCommand(stopCommand2).addCommand(statusCommand2).addCommand(urlCommand);
tunnelCommand.action(async () => {
  await startCommand2.parseAsync([], { from: "user" });
});

// src/cli/get-config.ts
init_cjs_shims();
var import_commander17 = require("commander");
var import_fs37 = require("fs");
var import_path39 = require("path");
var getConfigCommand = new import_commander17.Command("get-config").description("Show resolved operational config for an agent (org defaults + agent overrides)").option("--agent <name>", "Agent name").option("--org <org>", "Org name").option("--format <format>", "Output format: text or json", "text").action((options) => {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();
  const org = options.org || process.env.CTX_ORG || "";
  const agentName = options.agent || process.env.CTX_AGENT_NAME || "";
  if (!org) {
    process.stderr.write("Error: --org is required (or set CTX_ORG)\n");
    process.exit(1);
  }
  let orgCtx = {};
  const orgCtxPath = (0, import_path39.join)(frameworkRoot, "orgs", org, "context.json");
  if ((0, import_fs37.existsSync)(orgCtxPath)) {
    try {
      orgCtx = JSON.parse((0, import_fs37.readFileSync)(orgCtxPath, "utf-8"));
    } catch {
    }
  } else {
    process.stderr.write(`Warning: org context not found at ${orgCtxPath}, using hardcoded defaults
`);
  }
  let agentCfg = {};
  if (agentName) {
    const agentCfgPath = (0, import_path39.join)(frameworkRoot, "orgs", org, "agents", agentName, "config.json");
    if ((0, import_fs37.existsSync)(agentCfgPath)) {
      try {
        agentCfg = JSON.parse((0, import_fs37.readFileSync)(agentCfgPath, "utf-8"));
      } catch {
      }
    } else if (options.agent) {
      process.stderr.write(`Warning: agent config not found at ${agentCfgPath}, showing org defaults only
`);
    }
  }
  const defaultApprovalCategories = Array.isArray(orgCtx.default_approval_categories) ? orgCtx.default_approval_categories : ["external-comms", "financial", "deployment", "data-deletion"];
  const resolved = {
    timezone: agentCfg.timezone || orgCtx.timezone || "UTC",
    day_mode_start: agentCfg.day_mode_start || orgCtx.day_mode_start || "08:00",
    day_mode_end: agentCfg.day_mode_end || orgCtx.day_mode_end || "00:00",
    communication_style: agentCfg.communication_style || orgCtx.communication_style || "direct and casual",
    approval_rules: agentCfg.approval_rules || {
      always_ask: defaultApprovalCategories,
      never_ask: []
    }
  };
  if (options.format === "json") {
    console.log(JSON.stringify(resolved, null, 2));
    return;
  }
  const header = agentName ? `=== Config: ${agentName} (org: ${org}) ===` : `=== Org Config: ${org} ===`;
  console.log(header);
  console.log(`Timezone:            ${resolved.timezone}`);
  console.log(`Day Mode:            ${resolved.day_mode_start} \u2013 ${resolved.day_mode_end}`);
  console.log(`Night Mode:          ${resolved.day_mode_end} \u2013 ${resolved.day_mode_start}`);
  console.log(`Approval Required:   ${resolved.approval_rules.always_ask.join(", ") || "(none)"}`);
  console.log(`Never Need Approval: ${resolved.approval_rules.never_ask.join(", ") || "(none)"}`);
  console.log(`Communication:       ${resolved.communication_style}`);
});

// src/cli/goals.ts
init_cjs_shims();
var import_commander18 = require("commander");
var import_fs38 = require("fs");
var import_path40 = require("path");
var goalsCommand = new import_commander18.Command("goals").description("Manage goals.json and auto-generate GOALS.md for agents");
goalsCommand.command("generate-md").description("Regenerate GOALS.md from goals.json for an agent").requiredOption("--agent <name>", "Agent name").requiredOption("--org <org>", "Org name").action((options) => {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();
  if (!/^[A-Za-z0-9_-]+$/.test(options.agent) || !/^[A-Za-z0-9_-]+$/.test(options.org)) {
    process.stderr.write("Error: agent and org must be alphanumeric/dash/underscore only\n");
    process.exit(1);
  }
  const agentDir = (0, import_path40.join)(frameworkRoot, "orgs", options.org, "agents", options.agent);
  const goalsJsonPath = (0, import_path40.join)(agentDir, "goals.json");
  const goalsMdPath = (0, import_path40.join)(agentDir, "GOALS.md");
  if (!(0, import_fs38.existsSync)(goalsJsonPath)) {
    process.stderr.write(`goals.json not found at ${goalsJsonPath}
`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse((0, import_fs38.readFileSync)(goalsJsonPath, "utf-8"));
  } catch {
    process.stderr.write(`Failed to parse goals.json for ${options.agent}
`);
    process.exit(1);
  }
  const goals = Array.isArray(data.goals) ? data.goals : [];
  const focus = typeof data.focus === "string" ? data.focus : "";
  const bottleneck = typeof data.bottleneck === "string" ? data.bottleneck : "";
  const updatedAt = typeof data.updated_at === "string" ? data.updated_at : (/* @__PURE__ */ new Date()).toISOString();
  const updatedBy = typeof data.updated_by === "string" ? data.updated_by : "";
  const lines = [
    "# Goals",
    "",
    "> Auto-generated from goals.json. Do not edit this file directly.",
    `> To regenerate: \`cortextos goals generate-md --agent ${options.agent} --org ${options.org}\``,
    "",
    "## Focus",
    focus || "(not set \u2014 check with your orchestrator)",
    "",
    "## Goals"
  ];
  if (goals.length === 0) {
    lines.push("(none set \u2014 message your orchestrator to request today's goals)");
  } else {
    goals.forEach((g, i) => {
      const title = typeof g === "string" ? g : g.title;
      lines.push(`${i + 1}. ${title}`);
    });
  }
  lines.push(
    "",
    "## Bottleneck",
    bottleneck || "(none)",
    "",
    "## Updated",
    updatedBy ? `${updatedAt} (by ${updatedBy})` : updatedAt,
    ""
  );
  (0, import_fs38.writeFileSync)(goalsMdPath, lines.join("\n"), "utf-8");
  console.log(`Generated GOALS.md for ${options.agent}`);
});

// src/cli/setup.ts
init_cjs_shims();
var import_commander19 = require("commander");
var import_readline = require("readline");
var import_fs39 = require("fs");
var import_path41 = require("path");
var import_os18 = require("os");
var import_child_process11 = require("child_process");
init_api();
function rl() {
  return (0, import_readline.createInterface)({ input: process.stdin, output: process.stdout });
}
function ask(iface, question) {
  return new Promise((resolve4) => iface.question(question, (answer) => resolve4(answer.trim())));
}
function askRequired(iface, question, errorMsg) {
  return new Promise(async (resolve4) => {
    while (true) {
      const answer = await ask(iface, question);
      if (answer) {
        resolve4(answer);
        return;
      }
      console.log(`  ${errorMsg}`);
    }
  });
}
function askDefault(iface, question, defaultVal) {
  return new Promise(
    (resolve4) => iface.question(`${question} [${defaultVal}]: `, (answer) => {
      const trimmed = answer.trim();
      resolve4(trimmed || defaultVal);
    })
  );
}
function askYN(iface, question, defaultYes = false) {
  const hint = defaultYes ? "Y/n" : "y/N";
  return new Promise(
    (resolve4) => iface.question(`${question} [${hint}]: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) return resolve4(defaultYes);
      resolve4(a === "y" || a === "yes");
    })
  );
}
function runCli(cwd, args, label) {
  const cliPath = (0, import_path41.join)(cwd, "dist", "cli.js");
  const result = (0, import_child_process11.spawnSync)(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) {
    console.error(`
  Error during: ${label}`);
    return false;
  }
  return true;
}
function writeAgentEnv(agentDir, botToken, chatId) {
  const envPath = (0, import_path41.join)(agentDir, ".env");
  const content = `BOT_TOKEN=${botToken}
CHAT_ID=${chatId}
`;
  (0, import_fs39.writeFileSync)(envPath, content, "utf-8");
  try {
    (0, import_fs39.chmodSync)(envPath, 384);
  } catch {
  }
}
function fetchChatId(botToken) {
  const script = [
    `fetch('https://api.telegram.org/bot' + process.argv[1] + '/getUpdates')`,
    `.then(r => r.json())`,
    `.then(d => { const m = d.result?.slice(-1)[0]?.message; console.log(m?.chat?.id || ''); })`,
    `.catch(() => console.log(''))`
  ].join("");
  const result = (0, import_child_process11.spawnSync)(process.execPath, ["-e", script, botToken], {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 1e4
  });
  const id = result.stdout?.trim() ?? "";
  if (id && /^\d+$/.test(id)) {
    console.log(`  Chat ID: ${id}`);
    return id;
  }
  console.log("  Could not auto-detect chat ID.");
  return "";
}
async function validateTelegramCredsInteractive(iface, botToken, initialChatId, label) {
  let chatId = initialChatId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const api = new TelegramAPI(botToken);
    let result;
    try {
      result = await api.validateCredentials(chatId);
    } catch (err) {
      console.log(`  Warning: Telegram validator crashed: ${err instanceof Error ? err.message : String(err)}. Writing .env anyway.`);
      return chatId;
    }
    if (result.ok) {
      const titleHint = result.chatTitle ? ` (${result.chatTitle})` : "";
      console.log(`  Validated ${label}: bot=@${result.botUsername} chat=${chatId} type=${result.chatType}${titleHint}`);
      return chatId;
    }
    if (result.reason === "network_error" || result.reason === "rate_limited") {
      console.log(`  Warning: ${formatValidateError(result)}`);
      console.log("  Writing .env with unvalidated values. Re-run cortextos enable later to confirm.");
      return chatId;
    }
    console.log(`  Validation failed: ${formatValidateError(result)}`);
    if (result.reason === "bad_token") {
      console.log("  Re-run cortextos setup after fixing the bot token.");
      return null;
    }
    const answer = await ask(iface, `  Enter a different chat_id for ${label} (or blank to give up): `);
    if (!answer) {
      console.log("  Giving up on validation. No .env will be written for this agent.");
      return null;
    }
    chatId = answer;
  }
  console.log(`  Too many failed attempts \u2014 giving up on ${label}.`);
  return null;
}
function validateAgentName2(name) {
  return /^[a-z0-9_-]+$/.test(name);
}
function validateOrgName2(name) {
  return /^[a-z0-9_-]+$/.test(name);
}
function findProjectRoot() {
  if (process.env.CTX_FRAMEWORK_ROOT && (0, import_fs39.existsSync)((0, import_path41.join)(process.env.CTX_FRAMEWORK_ROOT, "dist", "cli.js"))) {
    return process.env.CTX_FRAMEWORK_ROOT;
  }
  const cwd = process.cwd();
  if ((0, import_fs39.existsSync)((0, import_path41.join)(cwd, "dist", "cli.js"))) return cwd;
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const pkg = (0, import_path41.join)(dir, "package.json");
    if ((0, import_fs39.existsSync)(pkg)) {
      try {
        const { name } = JSON.parse(require("fs").readFileSync(pkg, "utf-8"));
        if (name === "cortextos" && (0, import_fs39.existsSync)((0, import_path41.join)(dir, "dist", "cli.js"))) return dir;
      } catch {
      }
    }
    const parent = (0, import_path41.join)(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}
var setupCommand = new import_commander19.Command("setup").option("--instance <id>", "Instance ID", "default").description("Interactive first-run setup wizard \u2014 install, create org, configure agents, start daemon").action(async (options) => {
  const instanceId = options.instance;
  const projectRoot = findProjectRoot();
  const ctxRoot = (0, import_path41.join)((0, import_os18.homedir)(), ".cortextos", instanceId);
  const iface = rl();
  console.log("\n  Welcome to cortextOS setup\n");
  console.log("  This wizard will:");
  console.log("    1. Check and install dependencies");
  console.log("    2. Create your organization");
  console.log("    3. Configure your orchestrator agent");
  console.log("    4. Optionally add more agents");
  console.log("    5. Start the system\n");
  console.log("  Press Ctrl+C at any time to exit.\n");
  console.log("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
  console.log("  Step 1: Checking dependencies and creating state directories...\n");
  const installOk = runCli(projectRoot, ["install", "--instance", instanceId], "cortextos install");
  if (!installOk) {
    console.error("\n  Install step failed. Fix the errors above and re-run cortextos setup.");
    iface.close();
    process.exit(1);
  }
  console.log("\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
  console.log("  Step 2: Create your organization\n");
  console.log('  This is the name for your team or project (e.g. "acme", "myco", "demo").');
  console.log("  Lowercase letters, numbers, hyphens, and underscores only.\n");
  let orgName = "";
  while (true) {
    orgName = await askRequired(iface, "  Organization name: ", "Organization name cannot be empty.");
    if (!validateOrgName2(orgName)) {
      console.log("  Invalid name. Use lowercase letters, numbers, hyphens, and underscores only.");
      continue;
    }
    break;
  }
  const initOk = runCli(projectRoot, ["init", orgName, "--instance", instanceId], "cortextos init");
  if (!initOk) {
    console.error("\n  Org creation failed. Fix the errors above and re-run cortextos setup.");
    iface.close();
    process.exit(1);
  }
  console.log("\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
  console.log("  Step 3: Create your orchestrator agent\n");
  console.log("  The orchestrator coordinates all other agents, routes messages,");
  console.log("  and sends you morning/evening briefings via Telegram.\n");
  console.log("  You need a Telegram bot token. Create one via @BotFather on Telegram:");
  console.log("    1. Open Telegram, search @BotFather");
  console.log("    2. Send /newbot, follow the prompts");
  console.log("    3. Copy the token it gives you (looks like 123456789:AAA...)\n");
  let orchName = "";
  while (true) {
    orchName = await askDefault(iface, "  Orchestrator agent name", "boss");
    if (!validateAgentName2(orchName)) {
      console.log("  Invalid name. Use lowercase letters, numbers, hyphens, and underscores only.");
      continue;
    }
    break;
  }
  const orchToken = await askRequired(
    iface,
    "  Orchestrator bot token (from @BotFather): ",
    "Bot token is required."
  );
  console.log("\n  Now send a message to your new bot in Telegram (any message).");
  console.log("  This lets us fetch your chat ID.\n");
  await ask(iface, "  Press Enter when done...");
  let orchChatId = "";
  console.log("\n  Fetching your chat ID...");
  orchChatId = fetchChatId(orchToken);
  if (!orchChatId) {
    orchChatId = await askRequired(iface, "  Enter your Telegram chat ID manually: ", "Chat ID is required.");
  }
  const validatedOrchChatId = await validateTelegramCredsInteractive(
    iface,
    orchToken,
    orchChatId,
    `orchestrator ${orchName}`
  );
  if (!validatedOrchChatId) {
    console.error("\n  Cannot continue without validated orchestrator credentials.");
    iface.close();
    process.exit(1);
  }
  orchChatId = validatedOrchChatId;
  const addOrchOk = runCli(
    projectRoot,
    ["add-agent", orchName, "--template", "orchestrator", "--org", orgName, "--instance", instanceId],
    "cortextos add-agent orchestrator"
  );
  if (!addOrchOk) {
    console.error("\n  Failed to create orchestrator agent.");
    iface.close();
    process.exit(1);
  }
  const orchDir = (0, import_path41.join)(projectRoot, "orgs", orgName, "agents", orchName);
  writeAgentEnv(orchDir, orchToken, orchChatId);
  console.log(`  Wrote .env for ${orchName}`);
  const enableOrchOk = runCli(
    projectRoot,
    ["enable", orchName, "--org", orgName, "--instance", instanceId],
    "cortextos enable orchestrator"
  );
  if (!enableOrchOk) {
    console.error(`
  Failed to enable ${orchName}. Check .env and try: cortextos enable ${orchName}`);
  }
  console.log("\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
  console.log("  Step 4: Add more agents (optional)\n");
  console.log("  Common additions:");
  console.log("    - analyst: reviews data, generates reports");
  console.log("    - agent: general-purpose specialist\n");
  const addedAgents = [orchName];
  while (true) {
    const addMore = await askYN(iface, "  Add another agent?", false);
    if (!addMore) break;
    let agentName = "";
    while (true) {
      agentName = await askRequired(iface, "  Agent name: ", "Agent name is required.");
      if (!validateAgentName2(agentName)) {
        console.log("  Invalid name. Use lowercase letters, numbers, hyphens, and underscores only.");
        continue;
      }
      if (addedAgents.includes(agentName)) {
        console.log(`  Agent "${agentName}" already added.`);
        continue;
      }
      break;
    }
    const templateChoices = ["orchestrator", "analyst", "agent"];
    let template = await askDefault(iface, `  Template for ${agentName} (orchestrator/analyst/agent)`, "agent");
    if (!templateChoices.includes(template)) template = "agent";
    console.log(`
  Create a Telegram bot for ${agentName} via @BotFather, then enter its token.
`);
    const agentToken = await askRequired(iface, `  Bot token for ${agentName}: `, "Bot token is required.");
    console.log(`
  Send a message to the ${agentName} bot in Telegram, then press Enter.`);
    await ask(iface, "  Press Enter when done...");
    let agentChatId = "";
    agentChatId = fetchChatId(agentToken);
    if (!agentChatId) {
      agentChatId = await askRequired(iface, `  Enter chat ID for ${agentName} manually: `, "Chat ID is required.");
    }
    const validatedAgentChatId = await validateTelegramCredsInteractive(
      iface,
      agentToken,
      agentChatId,
      `agent ${agentName}`
    );
    if (!validatedAgentChatId) {
      console.log(`  Skipping ${agentName} \u2014 fix the credentials and re-run cortextos setup or cortextos enable ${agentName}.`);
      continue;
    }
    agentChatId = validatedAgentChatId;
    const addOk = runCli(
      projectRoot,
      ["add-agent", agentName, "--template", template, "--org", orgName, "--instance", instanceId],
      `cortextos add-agent ${agentName}`
    );
    if (addOk) {
      const agentDir = (0, import_path41.join)(projectRoot, "orgs", orgName, "agents", agentName);
      writeAgentEnv(agentDir, agentToken, agentChatId);
      console.log(`  Wrote .env for ${agentName}`);
      runCli(projectRoot, ["enable", agentName, "--org", orgName, "--instance", instanceId], `enable ${agentName}`);
      addedAgents.push(agentName);
    }
  }
  console.log("\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
  console.log("  Step 5: Generating ecosystem config and starting daemon...\n");
  const ecoEnv = { ...process.env, CTX_INSTANCE_ID: instanceId, CTX_ORG: orgName };
  const ecoResult = (0, import_child_process11.spawnSync)(process.execPath, [(0, import_path41.join)(projectRoot, "dist", "cli.js"), "ecosystem", "--instance", instanceId], {
    cwd: projectRoot,
    stdio: "inherit",
    env: ecoEnv
  });
  if (ecoResult.status !== 0) {
    console.error("  Failed to generate ecosystem config. Run manually: cortextos ecosystem");
  } else {
    const pm2Result = (0, import_child_process11.spawnSync)("pm2", ["start", "ecosystem.config.js"], {
      cwd: projectRoot,
      stdio: "inherit"
    });
    if (pm2Result.status === 0) {
      (0, import_child_process11.spawnSync)("pm2", ["save"], { cwd: projectRoot, stdio: "inherit" });
      console.log("\n  Daemon started via PM2.");
    } else {
      runCli(projectRoot, ["start", "--instance", instanceId], "cortextos start");
    }
  }
  iface.close();
  console.log("\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
  console.log("  Setup complete!\n");
  console.log(`  Organization: ${orgName}`);
  console.log(`  Agents: ${addedAgents.join(", ")}`);
  console.log(`  State: ${ctxRoot}
`);
  console.log("  Next steps:");
  console.log("    - Check agent status: cortextos status");
  console.log("    - Start dashboard:    cortextos dashboard");
  console.log("    - View PM2 logs:      pm2 logs");
  console.log("    - Talk to your agent via Telegram!\n");
});

// src/cli/workers.ts
init_cjs_shims();
var import_commander20 = require("commander");
var import_path42 = require("path");
var spawnWorkerCommand = new import_commander20.Command("spawn-worker").description("Spawn an ephemeral worker Claude Code session for a parallelized task").argument("<name>", "Worker name (used for bus identity)").requiredOption("--dir <path>", "Working directory for the worker session").requiredOption("--prompt <text>", "Task prompt to inject at session start").option("--parent <agent>", "Parent agent name (for bus reply routing)").option("--model <model>", "Claude model to use (defaults to org default)").action(async (name, opts) => {
  const env = resolveEnv();
  const client = new IPCClient(env.instanceId);
  const dir = (0, import_path42.resolve)(opts.dir);
  const response = await client.send({
    type: "spawn-worker",
    data: { name, dir, prompt: opts.prompt, parent: opts.parent, model: opts.model }
  });
  if (response.success) {
    console.log(`Worker "${name}" spawning in ${dir}`);
    console.log(`Monitor: cortextos list-workers`);
    console.log(`Inject:  cortextos inject-worker ${name} "<text>"`);
    console.log(`Stop:    cortextos terminate-worker ${name}`);
  } else {
    console.error(`Error: ${response.error}`);
    process.exit(1);
  }
});
var terminateWorkerCommand = new import_commander20.Command("terminate-worker").description("Terminate a running worker session").argument("<name>", "Worker name").action(async (name) => {
  const env = resolveEnv();
  const client = new IPCClient(env.instanceId);
  const response = await client.send({
    type: "terminate-worker",
    data: { name }
  });
  if (response.success) {
    console.log(`Worker "${name}" terminating`);
  } else {
    console.error(`Error: ${response.error}`);
    process.exit(1);
  }
});
var listWorkersCommand = new import_commander20.Command("list-workers").description("List active and recently completed worker sessions").action(async () => {
  const env = resolveEnv();
  const client = new IPCClient(env.instanceId);
  const response = await client.send({ type: "list-workers" });
  if (!response.success) {
    console.error(`Error: ${response.error}`);
    process.exit(1);
  }
  const workers = response.data;
  if (!workers || workers.length === 0) {
    console.log("No active workers");
    return;
  }
  for (const w of workers) {
    const pid = w.pid ? ` (pid ${w.pid})` : "";
    const parent = w.parent ? ` \u2190 ${w.parent}` : "";
    const exit = w.exitCode !== void 0 ? ` exit=${w.exitCode}` : "";
    const age = Math.round((Date.now() - new Date(w.spawnedAt).getTime()) / 1e3);
    console.log(`${w.name}  ${w.status}${pid}${exit}${parent}  ${age}s  ${w.dir}`);
  }
});
var injectWorkerCommand = new import_commander20.Command("inject-worker").description("Inject text into a running worker session (nudge / stuck-state recovery)").argument("<name>", "Worker name").argument("<text>", "Text to inject into the worker PTY").action(async (name, text) => {
  const env = resolveEnv();
  const client = new IPCClient(env.instanceId);
  const response = await client.send({
    type: "inject-worker",
    data: { name, text }
  });
  if (response.success) {
    console.log(`Injected into worker "${name}"`);
  } else {
    console.error(`Error: ${response.error}`);
    process.exit(1);
  }
});

// src/cli/index.ts
var program = new import_commander21.Command();
program.name("cortextos").description("Persistent 24/7 Claude Code agents with multi-agent orchestration").version("0.1.1");
program.addCommand(initCommand);
program.addCommand(installCommand);
program.addCommand(addAgentCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(statusCommand);
program.addCommand(doctorCommand);
program.addCommand(busCommand);
program.addCommand(listAgentsCommand);
program.addCommand(notifyAgentCommand);
program.addCommand(listSkillsCommand);
program.addCommand(enableAgentCommand);
program.addCommand(disableAgentCommand);
program.addCommand(ecosystemCommand);
program.addCommand(uninstallCommand);
program.addCommand(dashboardCommand);
program.addCommand(tunnelCommand);
program.addCommand(getConfigCommand);
program.addCommand(goalsCommand);
program.addCommand(setupCommand);
program.addCommand(spawnWorkerCommand);
program.addCommand(terminateWorkerCommand);
program.addCommand(listWorkersCommand);
program.addCommand(injectWorkerCommand);
var crashAlertCommand = new import_commander21.Command("crash-alert").description("SessionEnd hook: send crash/restart notification via Telegram (cross-platform)").action(() => {
  const hookPath = (0, import_path43.join)(__dirname, "hooks/hook-crash-alert.js");
  const result = (0, import_child_process12.spawnSync)(process.execPath, [hookPath], { stdio: "inherit" });
  process.exit(result.status ?? 0);
});
program.addCommand(crashAlertCommand);
program.parse();
//# sourceMappingURL=cli.js.map