#!/usr/bin/env node
"use strict";

// src/hooks/hook-crash-alert.ts
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
var DEDUP_WINDOW_MS = 10 * 60 * 1e3;
var QUIET_HOUR_START_LA = 22;
var QUIET_HOUR_END_LA = 7;
var QUIET_SUPPRESSED_TYPES = /* @__PURE__ */ new Set([
  "planned-restart",
  "session-refresh",
  "daemon-stop",
  "user-restart",
  "user-disable",
  "user-stop",
  "rate-limited"
]);
function isQuietHoursLA(now) {
  const laString = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false
  });
  const m = laString.match(/\d+\/\d+\/\d+,?\s+(\d+):/);
  if (!m) return false;
  const hour = parseInt(m[1], 10);
  return hour >= QUIET_HOUR_START_LA || hour < QUIET_HOUR_END_LA;
}
function detectRateLimitInLog(logPath) {
  try {
    const size = (0, import_fs.statSync)(logPath).size;
    const readBytes = Math.min(size, 200 * 1024);
    const fd = (0, import_fs.readFileSync)(logPath);
    const slice = fd.slice(Math.max(0, fd.length - readBytes)).toString("utf-8");
    const text = slice.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").toLowerCase();
    return text.includes("overloaded_error") || text.includes("rate_limit_error") || text.includes("rate limit") || text.includes("rate-limit") || text.includes("too many requests") || text.includes("quota exceeded") || text.includes("usage limit") || text.includes("weekly limit") || text.includes("5-hour limit") || text.includes("5h limit") || /used \d+% of your/.test(text);
  } catch {
    return false;
  }
}
function shouldSuppressDedup(stateDir, endType) {
  const dedupFile = (0, import_path.join)(stateDir, ".crash_alert_dedup.json");
  const now = Date.now();
  let last = {};
  try {
    last = JSON.parse((0, import_fs.readFileSync)(dedupFile, "utf-8"));
  } catch {
  }
  const prev = last[endType] ?? 0;
  if (now - prev < DEDUP_WINDOW_MS) {
    return true;
  }
  last[endType] = now;
  try {
    (0, import_fs.writeFileSync)(dedupFile, JSON.stringify(last), "utf-8");
  } catch {
  }
  return false;
}
async function main() {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || "default";
  if (!agentName) return;
  const ctxRoot = (0, import_path.join)((0, import_os.homedir)(), ".cortextos", instanceId);
  const stateDir = (0, import_path.join)(ctxRoot, "state", agentName);
  const logDir = (0, import_path.join)(ctxRoot, "logs", agentName);
  (0, import_fs.mkdirSync)(stateDir, { recursive: true });
  (0, import_fs.mkdirSync)(logDir, { recursive: true });
  let endType = "crash";
  let reason = "";
  const markers = [
    { file: ".restart-planned", type: "planned-restart" },
    { file: ".session-refresh", type: "session-refresh" },
    { file: ".user-restart", type: "user-restart" },
    { file: ".user-disable", type: "user-disable" },
    { file: ".user-stop", type: "user-stop" },
    // .daemon-crashed wins over .daemon-stop when both are present — a crash
    // during shutdown is the more important signal. Written by the daemon's
    // uncaughtException handler in src/daemon/index.ts.
    { file: ".daemon-crashed", type: "daemon-crashed" },
    { file: ".daemon-stop", type: "daemon-stop" }
  ];
  for (const marker of markers) {
    const markerPath = (0, import_path.join)(stateDir, marker.file);
    if ((0, import_fs.existsSync)(markerPath)) {
      endType = marker.type;
      try {
        reason = (0, import_fs.readFileSync)(markerPath, "utf-8").trim();
        (0, import_fs.unlinkSync)(markerPath);
      } catch {
      }
      break;
    }
  }
  if (endType === "crash") {
    const stdoutPath = (0, import_path.join)(logDir, "stdout.log");
    if ((0, import_fs.existsSync)(stdoutPath) && detectRateLimitInLog(stdoutPath)) {
      endType = "rate-limited";
      reason = "anthropic rate limit detected in stdout.log";
    }
  }
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const countFile = (0, import_path.join)(stateDir, ".crash_count_today");
  let crashCount = 0;
  if (endType === "crash") {
    try {
      const data = (0, import_fs.readFileSync)(countFile, "utf-8").trim();
      const [date, count] = data.split(":");
      crashCount = date === today ? parseInt(count, 10) + 1 : 1;
    } catch {
      crashCount = 1;
    }
    try {
      (0, import_fs.writeFileSync)(countFile, `${today}:${crashCount}`, "utf-8");
    } catch {
    }
  }
  let lastTask = "";
  try {
    const hb = JSON.parse((0, import_fs.readFileSync)((0, import_path.join)(stateDir, "heartbeat.json"), "utf-8"));
    lastTask = hb.status || "";
  } catch {
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const logLine = `${timestamp} type=${endType} reason=${reason || "none"} last_task=${lastTask}
`;
  try {
    (0, import_fs.appendFileSync)((0, import_path.join)(logDir, "crashes.log"), logLine);
  } catch {
  }
  const now = /* @__PURE__ */ new Date();
  const quiet = isQuietHoursLA(now);
  if (quiet && QUIET_SUPPRESSED_TYPES.has(endType)) {
    return;
  }
  if (shouldSuppressDedup(stateDir, endType)) {
    return;
  }
  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
  if (!botToken || !chatId) return;
  let message = "";
  switch (endType) {
    case "planned-restart":
      message = reason?.startsWith("CONTEXT-FORCE-RESTART") ? `\u{1F504} ${agentName} restarting with memory` : `\u{1F504} ${agentName} restarted (planned): ${reason || "no reason given"}`;
      break;
    case "session-refresh":
      message = `\u267B\uFE0F ${agentName} session refresh (context exhaustion). Restarting with fresh session.`;
      break;
    case "user-restart":
      message = `\u{1F504} ${agentName} restarted by user: ${reason || "no reason given"}`;
      break;
    case "user-disable":
      message = `\u23F8\uFE0F ${agentName} disabled by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case "user-stop":
      message = `\u23F9\uFE0F ${agentName} stopped by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case "daemon-stop":
      message = `\u{1F6D1} ${agentName} stopped (daemon shutdown).`;
      if (reason) message += ` (${reason})`;
      break;
    case "daemon-crashed":
      message = `\u{1F6A8} ${agentName} \u2014 daemon crashed, session was interrupted. Resuming.`;
      if (reason) message += `
Crash time: ${reason}`;
      break;
    case "rate-limited":
      message = `\u23F3 ${agentName} paused \u2014 Anthropic rate limit hit. Will resume when the window resets.`;
      break;
    case "crash":
      message = `\u{1F6A8} CRASH: ${agentName} died unexpectedly.`;
      if (crashCount > 0) message += ` Crashes today: ${crashCount}.`;
      if (lastTask) message += `
Last status: ${lastTask}`;
      break;
  }
  if (message) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message })
      });
    } catch {
    }
  }
}
main().catch(() => process.exit(0));
//# sourceMappingURL=hook-crash-alert.js.map