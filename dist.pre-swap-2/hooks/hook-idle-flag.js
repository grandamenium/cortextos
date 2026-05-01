#!/usr/bin/env node
"use strict";

// src/hooks/hook-idle-flag.ts
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
async function main() {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || "default";
  if (!agentName) return;
  const stateDir = (0, import_path.join)((0, import_os.homedir)(), ".cortextos", instanceId, "state", agentName);
  try {
    (0, import_fs.mkdirSync)(stateDir, { recursive: true });
    (0, import_fs.writeFileSync)((0, import_path.join)(stateDir, "last_idle.flag"), String(Math.floor(Date.now() / 1e3)), "utf-8");
  } catch {
  }
}
main().catch(() => process.exit(0));
//# sourceMappingURL=hook-idle-flag.js.map