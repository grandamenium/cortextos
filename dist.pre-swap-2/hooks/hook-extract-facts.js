#!/usr/bin/env node
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/hooks/hook-extract-facts.ts
var hook_extract_facts_exports = {};
__export(hook_extract_facts_exports, {
  extractKeywords: () => extractKeywords
});
module.exports = __toCommonJS(hook_extract_facts_exports);
var import_fs2 = require("fs");
var import_path2 = require("path");

// src/hooks/index.ts
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}
function loadEnv() {
  const agentName = process.env.CTX_AGENT_NAME || require("path").basename(process.cwd());
  const ctxRoot = process.env.CTX_ROOT || (0, import_path.join)((0, import_os.homedir)(), ".cortextos", "default");
  const stateDir = (0, import_path.join)(ctxRoot, "state", agentName);
  const envPaths = [
    process.env.CTX_AGENT_DIR ? (0, import_path.join)(process.env.CTX_AGENT_DIR, ".env") : null,
    (0, import_path.join)(process.cwd(), ".env")
  ].filter(Boolean);
  for (const envPath of envPaths) {
    if ((0, import_fs.existsSync)(envPath)) {
      const content = (0, import_fs.readFileSync)(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    }
  }
  return {
    botToken: process.env.BOT_TOKEN,
    chatId: process.env.CHAT_ID,
    agentName,
    stateDir,
    ctxRoot
  };
}

// src/hooks/hook-extract-facts.ts
function extractKeywords(text) {
  const stopwords = /* @__PURE__ */ new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "was",
    "are",
    "were",
    "be",
    "been",
    "has",
    "have",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "that",
    "this",
    "these",
    "those",
    "it",
    "its",
    "i",
    "we",
    "you",
    "he",
    "she",
    "they",
    "my",
    "our",
    "your",
    "their",
    "not",
    "no",
    "so",
    "if",
    "then",
    "than",
    "as",
    "also",
    "just",
    "now",
    "up",
    "out",
    "what",
    "which",
    "who",
    "when",
    "where",
    "how",
    "about",
    "after",
    "before",
    "into",
    "through",
    "during",
    "each",
    "some",
    "any"
  ]);
  const words = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !stopwords.has(w));
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).filter(([, count]) => count >= 2).sort(([, a], [, b]) => b - a).slice(0, 20).map(([word]) => word);
}
async function main() {
  const env = loadEnv();
  try {
    const raw = await Promise.race([
      readStdin(),
      new Promise((resolve) => setTimeout(() => resolve(""), 1e4))
    ]);
    let payload = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { summary: raw.trim() };
      }
    }
    let summaryText = payload.summary || "";
    if (!summaryText && payload.turns && payload.turns.length > 0) {
      const lastAssistant = [...payload.turns].reverse().find((t) => t.role === "assistant");
      if (lastAssistant) summaryText = lastAssistant.content;
    }
    if (!summaryText || summaryText.trim().length < 20) return;
    const now = /* @__PURE__ */ new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const org = process.env.CTX_ORG || "";
    const factsDir = (0, import_path2.join)(env.ctxRoot, "state", env.agentName, "memory", "facts");
    if (!(0, import_fs2.existsSync)(factsDir)) {
      (0, import_fs2.mkdirSync)(factsDir, { recursive: true });
    }
    const entry = {
      ts,
      session_id: payload.session_id || `session-${Date.now()}`,
      agent: env.agentName,
      org,
      source: "precompact",
      summary: summaryText.slice(0, 8e3),
      // Cap at 8k chars
      keywords: extractKeywords(summaryText)
    };
    const factsFile = (0, import_path2.join)(factsDir, `${dateStr}.jsonl`);
    (0, import_fs2.appendFileSync)(factsFile, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
  }
}
main().catch(() => process.exit(0));
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  extractKeywords
});
//# sourceMappingURL=hook-extract-facts.js.map