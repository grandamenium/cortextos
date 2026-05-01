#!/usr/bin/env node
"use strict";

// src/hooks/hook-context-status.ts
var import_fs2 = require("fs");
var import_path2 = require("path");
var import_os = require("os");

// src/utils/atomic.ts
var import_fs = require("fs");
var import_path = require("path");
var import_crypto = require("crypto");
function atomicWriteSync(filePath, data) {
  const dir = (0, import_path.dirname)(filePath);
  (0, import_fs.mkdirSync)(dir, { recursive: true });
  const tmpPath = (0, import_path.join)(dir, `.tmp.${(0, import_crypto.randomBytes)(6).toString("hex")}`);
  try {
    (0, import_fs.writeFileSync)(tmpPath, data + "\n", { encoding: "utf-8", mode: 384 });
    (0, import_fs.renameSync)(tmpPath, filePath);
  } catch (err) {
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}

// src/hooks/hook-context-status.ts
async function main() {
  const agentName = process.env.CTX_AGENT_NAME;
  if (!agentName) return;
  const ctxRoot = process.env.CTX_ROOT || (0, import_path2.join)((0, import_os.homedir)(), ".cortextos", "default");
  const stateDir = (0, import_path2.join)(ctxRoot, "state", agentName);
  const outPath = (0, import_path2.join)(stateDir, "context_status.json");
  try {
    const mtime = (0, import_fs2.statSync)(outPath).mtimeMs;
    if (Date.now() - mtime < 500) return;
  } catch {
  }
  const chunks = [];
  await new Promise((resolve) => {
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
    setTimeout(resolve, 1500);
  });
  let data = {};
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return;
  }
  const cw = data.context_window;
  if (!cw) return;
  const payload = JSON.stringify({
    used_percentage: typeof cw.used_percentage === "number" ? cw.used_percentage : null,
    context_window_size: cw.context_window_size ?? null,
    exceeds_200k_tokens: Boolean(cw.exceeds_200k_tokens),
    current_usage: cw.current_usage ?? null,
    session_id: data.session_id ?? null,
    written_at: (/* @__PURE__ */ new Date()).toISOString()
  });
  (0, import_fs2.mkdirSync)(stateDir, { recursive: true });
  atomicWriteSync(outPath, payload);
}
main().catch(() => process.exit(0));
//# sourceMappingURL=hook-context-status.js.map