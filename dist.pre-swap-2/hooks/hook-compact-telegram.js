#!/usr/bin/env node
"use strict";

// src/hooks/index.ts
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
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

// src/hooks/hook-compact-telegram.ts
async function main() {
  const env = loadEnv();
  if (!env.botToken || !env.chatId) return;
  const agentName = env.agentName || "agent";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5e3);
  try {
    const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.chatId,
        text: `[${agentName}] Context compacting... resuming shortly`
      }),
      signal: controller.signal
    });
  } catch {
  } finally {
    clearTimeout(timer);
  }
}
main().catch(() => process.exit(0));
//# sourceMappingURL=hook-compact-telegram.js.map