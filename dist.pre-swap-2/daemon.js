#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/daemon/index.ts
var daemon_exports = {};
__export(daemon_exports, {
  CRASH_HISTORY_MAX: () => CRASH_HISTORY_MAX,
  CRASH_LOOP_COOLDOWN_MS: () => CRASH_LOOP_COOLDOWN_MS,
  CRASH_LOOP_THRESHOLD: () => CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS: () => CRASH_LOOP_WINDOW_MS,
  countRecentCrashes: () => countRecentCrashes,
  crashHistoryPath: () => crashHistoryPath,
  readCrashHistory: () => readCrashHistory,
  recordCrash: () => recordCrash,
  shouldSendCrashLoopAlert: () => shouldSendCrashLoopAlert,
  writeCrashHistory: () => writeCrashHistory,
  writeDaemonCrashedMarkers: () => writeDaemonCrashedMarkers
});
module.exports = __toCommonJS(daemon_exports);

// src/daemon/agent-manager.ts
var import_fs19 = require("fs");
var import_path19 = require("path");

// src/daemon/agent-process.ts
var import_fs8 = require("fs");
var import_path8 = require("path");
var import_os4 = require("os");

// src/pty/agent-pty.ts
var import_path = require("path");
var import_fs2 = require("fs");
var import_os = require("os");

// src/pty/output-buffer.ts
var import_fs = require("fs");

// src/pty/redact.ts
var JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
function redactSecrets(data) {
  return data.replace(JWT_PATTERN, "[REDACTED_JWT]");
}

// src/pty/output-buffer.ts
var stripAnsi;
async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import("strip-ansi");
    stripAnsi = mod.default;
  }
  return stripAnsi;
}
var MAX_LOG_BYTES = 50 * 1024 * 1024;
var OutputBuffer = class {
  chunks = [];
  maxChunks;
  logPath;
  bootstrapPattern;
  constructor(maxChunks = 1e3, logPath, bootstrapPattern) {
    this.maxChunks = maxChunks;
    this.logPath = logPath || null;
    this.bootstrapPattern = bootstrapPattern || "permissions";
  }
  /**
   * Push new output data into the buffer.
   * Also streams to log file if configured.
   *
   * Secret redaction runs once at the top via `redactSecrets` and the
   * scrubbed string is used for BOTH the in-memory ring buffer AND the
   * disk log. Without this, any JWT or session cookie an agent's shell
   * happens to print (e.g. curl -v against an authenticated endpoint)
   * would end up persisted to stdout.log verbatim. See src/pty/redact.ts
   * for the rationale + the known chunk-boundary limitation.
   */
  push(data) {
    const safe = redactSecrets(data);
    this.chunks.push(safe);
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
    }
    if (this.logPath) {
      try {
        try {
          const size = (0, import_fs.statSync)(this.logPath).size;
          if (size >= MAX_LOG_BYTES) {
            try {
              (0, import_fs.renameSync)(this.logPath, this.logPath + ".1");
            } catch {
            }
          }
        } catch {
        }
        (0, import_fs.appendFileSync)(this.logPath, safe, "utf-8");
      } catch {
      }
    }
  }
  /**
   * Get the last N chunks of output joined together.
   */
  getRecent(n) {
    const count = n || this.chunks.length;
    return this.chunks.slice(-count).join("");
  }
  /**
   * Search for a pattern in recent output (ANSI codes stripped).
   * Used for bootstrap detection ("permissions" text).
   */
  async search(pattern) {
    const strip = await loadStripAnsi();
    const text = strip(this.getRecent());
    return text.includes(pattern);
  }
  /**
   * Synchronous search for simple patterns.
   * Does basic ANSI stripping inline (strips ESC[ sequences).
   */
  searchSync(pattern) {
    const text = this.getRecent().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    return text.includes(pattern);
  }
  /**
   * Check if agent has bootstrapped (ready-for-input signal appeared).
   *
   * For Claude Code: looks for the "permissions" status-bar text.
   * For Hermes: looks for the "❯" prompt character (configurable via constructor).
   * The bootstrap pattern is set at construction time by the PTY class.
   */
  isBootstrapped() {
    const recent = this.getRecent();
    const cleaned = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    if (this.bootstrapPattern === "permissions") {
      if (cleaned.includes("trust") && !cleaned.includes("> ")) {
        return false;
      }
    }
    return cleaned.includes(this.bootstrapPattern);
  }
  /**
   * Get the total size of buffered output in bytes.
   * Useful for activity detection (typing indicator).
   */
  getSize() {
    let size = 0;
    for (const chunk of this.chunks) {
      size += chunk.length;
    }
    return size;
  }
  /**
   * Clear the buffer.
   */
  clear() {
    this.chunks = [];
  }
};

// src/pty/agent-pty.ts
var AgentPTY = class {
  pty = null;
  _alive = false;
  outputBuffer;
  env;
  config;
  onExitHandler = null;
  spawnFn = null;
  constructor(env, config, logPath, bootstrapPattern) {
    this.env = env;
    this.config = config;
    this.outputBuffer = new OutputBuffer(1e3, logPath, bootstrapPattern);
  }
  /**
   * Spawn Claude Code in a PTY process.
   *
   * @param mode 'fresh' for new conversation, 'continue' for preserving history
   * @param prompt The startup or continue prompt to pass to Claude
   */
  async spawn(mode, prompt) {
    if (this.pty) {
      throw new Error("PTY already spawned. Kill first.");
    }
    if (!this.spawnFn) {
      const nodePty = require("node-pty");
      this.spawnFn = nodePty.spawn;
    }
    const cwd = this.config.working_directory || this.env.agentDir || process.cwd();
    const ptyEnv = {
      ...this.getBaseEnv(),
      CTX_INSTANCE_ID: this.env.instanceId,
      CTX_ROOT: this.env.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.env.frameworkRoot,
      CTX_AGENT_NAME: this.env.agentName,
      CTX_ORG: this.env.org,
      CTX_AGENT_DIR: this.env.agentDir,
      CTX_PROJECT_ROOT: this.env.projectRoot,
      // Backward compat
      CRM_AGENT_NAME: this.env.agentName,
      CRM_TEMPLATE_ROOT: this.env.frameworkRoot
    };
    if (this.env.org && this.env.projectRoot) {
      const orgEnvFile = (0, import_path.join)(this.env.projectRoot, "orgs", this.env.org, "secrets.env");
      if ((0, import_fs2.existsSync)(orgEnvFile)) {
        const content = (0, import_fs2.readFileSync)(orgEnvFile, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            ptyEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
          }
        }
      }
    }
    const agentEnvFile = (0, import_path.join)(this.env.agentDir, ".env");
    if ((0, import_fs2.existsSync)(agentEnvFile)) {
      const content = (0, import_fs2.readFileSync)(agentEnvFile, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          ptyEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    }
    if (ptyEnv["CHAT_ID"]) {
      ptyEnv["CTX_TELEGRAM_CHAT_ID"] = ptyEnv["CHAT_ID"];
    }
    const configTimezone = this.config.timezone;
    if (configTimezone) {
      ptyEnv["CTX_TIMEZONE"] = configTimezone;
      ptyEnv["TZ"] = configTimezone;
    } else if (process.env.TZ) {
      ptyEnv["CTX_TIMEZONE"] = process.env.TZ;
    }
    if (this.env.projectRoot && this.env.org) {
      try {
        const contextPath = (0, import_path.join)(this.env.projectRoot, "orgs", this.env.org, "context.json");
        if ((0, import_fs2.existsSync)(contextPath)) {
          const ctx = JSON.parse((0, import_fs2.readFileSync)(contextPath, "utf-8"));
          if (ctx.orchestrator) {
            ptyEnv["CTX_ORCHESTRATOR_AGENT"] = ctx.orchestrator;
          }
        }
      } catch {
      }
    }
    const claudeArgs = this.buildClaudeArgs(mode, prompt);
    const claudeCmd = this.getBinaryName();
    this.pty = this.spawnFn(claudeCmd, claudeArgs, {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd,
      env: ptyEnv
    });
    this._alive = true;
    this.pty.onData((data) => {
      this.outputBuffer.push(data);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      this.pty = null;
      if (this.onExitHandler) {
        this.onExitHandler(exitCode, signal);
      }
    });
    setTimeout(() => {
      if (this.pty) {
        const recent = this.outputBuffer.getRecent();
        if (recent.includes("trust") || recent.includes("Yes")) {
          this.pty.write("\r");
        }
      }
    }, 5e3);
    setTimeout(() => {
      if (this.pty) {
        const recent = this.outputBuffer.getRecent();
        if (recent.includes("trust") || recent.includes("Yes")) {
          this.pty.write("\r");
        }
      }
    }, 8e3);
  }
  /**
   * Returns the binary name for the agent process.
   * Protected so HermesPTY can override to return 'hermes'.
   */
  getBinaryName() {
    return (0, import_os.platform)() === "win32" ? "claude.cmd" : "claude";
  }
  /**
   * Build the claude CLI argument array.
   * Returns args suitable for passing directly to node-pty spawn (no shell escaping needed).
   * Protected so HermesPTY can override this for its own spawn args.
   */
  buildClaudeArgs(mode, prompt) {
    const args = [];
    if (mode === "continue") {
      args.push("--continue");
    }
    args.push("--dangerously-skip-permissions");
    if (this.config.model) {
      args.push("--model", this.config.model);
    }
    const agentDir = this.env.agentDir;
    if (agentDir) {
      const localDir = (0, import_path.join)(agentDir, "local");
      if ((0, import_fs2.existsSync)(localDir)) {
        try {
          const mdFiles = (0, import_fs2.readdirSync)(localDir).filter((f) => f.endsWith(".md")).sort().map((f) => (0, import_path.join)(localDir, f));
          if (mdFiles.length > 0) {
            const localContent = mdFiles.map((f) => (0, import_fs2.readFileSync)(f, "utf-8")).join("\n\n");
            args.push("--append-system-prompt", localContent);
          }
        } catch {
        }
      }
    }
    args.push(prompt);
    return args;
  }
  /**
   * Write data to the PTY.
   */
  write(data) {
    if (!this.pty) {
      throw new Error("PTY not spawned");
    }
    this.pty.write(data);
  }
  /**
   * Kill the PTY process.
   */
  kill() {
    const pty = this.pty;
    if (pty) {
      this._alive = false;
      this.pty = null;
      pty.kill();
    }
  }
  /**
   * Check if the PTY process is alive.
   * Uses an internal flag set by the onExit handler — cross-platform safe.
   * (process.kill(pid, 0) is unreliable on Windows.)
   */
  isAlive() {
    return this._alive && this.pty !== null;
  }
  /**
   * Get the PTY PID.
   */
  getPid() {
    return this.pty?.pid || null;
  }
  /**
   * Register an exit handler.
   */
  onExit(handler) {
    this.onExitHandler = handler;
  }
  /**
   * Get the output buffer for inspection.
   */
  getOutputBuffer() {
    return this.outputBuffer;
  }
  /**
   * Get a clean base environment (excluding potentially harmful vars).
   */
  getBaseEnv() {
    const env = {};
    const keepVars = [
      "PATH",
      "HOME",
      "USER",
      "SHELL",
      "TERM",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "TEMP",
      "TMP",
      "ANTHROPIC_API_KEY",
      "CLAUDE_API_KEY",
      "NODE_PATH",
      "COMSPEC",
      "SystemRoot",
      "USERPROFILE"
    ];
    for (const key of keepVars) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    if ((0, import_os.platform)() === "win32") {
      if (!env["LANG"]) env["LANG"] = "en_US.UTF-8";
      if (!env["LC_ALL"]) env["LC_ALL"] = "en_US.UTF-8";
      if (!process.env["PYTHONIOENCODING"]) env["PYTHONIOENCODING"] = "utf-8";
    }
    return env;
  }
};

// src/pty/hermes-pty.ts
var import_fs3 = require("fs");
var import_path2 = require("path");
var import_os2 = require("os");
var HERMES_BOOTSTRAP_PATTERN = "\u276F";
var STARTUP_PROMPT_FILE = ".cortextos-startup.md";
var HermesPTY = class extends AgentPTY {
  startupPrompt = "";
  agentDir;
  constructor(env, config, logPath) {
    super(env, config, logPath, HERMES_BOOTSTRAP_PATTERN);
    this.agentDir = config.working_directory || env.agentDir;
  }
  /**
   * Returns the hermes binary name.
   * Hermes is a Python package installed via pip — no .cmd wrapper on Windows.
   */
  getBinaryName() {
    return "hermes";
  }
  /**
   * Build Hermes CLI args.
   *
   * Hermes session continuity: if ~/.hermes/state.db exists, pass --continue
   * to resume the last session. The SQLite DB persists conversation history
   * across daemon restarts (unlike Claude Code's .jsonl files which live in
   * the working dir).
   *
   * No positional prompt: the startup prompt is injected post-boot via a
   * temp file to avoid bracketed paste issues (see class-level comment).
   */
  buildClaudeArgs(mode, _prompt) {
    if (mode === "continue") {
      return ["--continue"];
    }
    return [];
  }
  /**
   * Override spawn to write the startup prompt to a temp file and inject it
   * after Hermes boots to the `❯` prompt.
   *
   * We cannot pass the startup prompt as a CLI arg (Hermes has no such flag)
   * and bracketed paste is buggy in Hermes (issue #7316). Instead:
   *   1. Write prompt to .cortextos-startup.md in the agent dir
   *   2. Spawn Hermes normally
   *   3. After `❯` appears (isBootstrapped), inject a single-line read command
   */
  async spawn(mode, prompt) {
    this.startupPrompt = prompt;
    this.writeStartupFile(prompt);
    await super.spawn(mode, prompt);
    this.scheduleStartupInjection();
  }
  /**
   * Write the startup prompt to a temp file in the agent directory.
   * The file is gitignored (.cortextos-startup.md is in .gitignore by convention).
   */
  writeStartupFile(prompt) {
    try {
      const filePath = (0, import_path2.join)(this.agentDir, STARTUP_PROMPT_FILE);
      (0, import_fs3.writeFileSync)(filePath, prompt, "utf-8");
    } catch (err) {
      console.error(`[hermes-pty] Failed to write startup file: ${err}`);
    }
  }
  /**
   * Wait for Hermes's `❯` prompt, then inject the startup instruction.
   * Runs in the background — does not block spawn().
   */
  scheduleStartupInjection() {
    this.waitForPromptThenInject().catch((err) => {
      console.error(`[hermes-pty] Startup injection failed (non-fatal): ${err}`);
    });
  }
  async waitForPromptThenInject(timeoutMs = 3e4) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.getOutputBuffer().isBootstrapped()) {
        this.write(`Read ${STARTUP_PROMPT_FILE} and follow the instructions there.\r`);
        return;
      }
      await sleep(500);
    }
    this.write(`Read ${STARTUP_PROMPT_FILE} and follow the instructions there.\r`);
  }
};
function hermesDbExists(hermesHome) {
  const base = hermesHome || (0, import_path2.join)((0, import_os2.homedir)(), ".hermes");
  return (0, import_fs3.existsSync)((0, import_path2.join)(base, "state.db"));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/pty/inject.ts
var import_crypto = require("crypto");
var PASTE_START = "\x1B[200~";
var PASTE_END = "\x1B[201~";
var KEYS = {
  ENTER: "\r",
  CTRL_C: "",
  DOWN: "\x1B[B",
  UP: "\x1B[A",
  SPACE: " ",
  ESCAPE: "\x1B",
  TAB: "	"
};
var MessageDedup = class {
  hashes = [];
  maxEntries;
  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }
  /**
   * Returns true if this content has been seen before (duplicate).
   */
  isDuplicate(content) {
    const hash = (0, import_crypto.createHash)("md5").update(content).digest("hex");
    if (this.hashes.includes(hash)) {
      return true;
    }
    this.hashes.push(hash);
    if (this.hashes.length > this.maxEntries) {
      this.hashes.shift();
    }
    return false;
  }
  clear() {
    this.hashes = [];
  }
};
function injectMessage(write, content, enterDelay = 300) {
  const MAX_CHUNK = 4096;
  if (content.length <= MAX_CHUNK) {
    write(PASTE_START + content + PASTE_END);
  } else {
    write(PASTE_START);
    for (let i = 0; i < content.length; i += MAX_CHUNK) {
      write(content.slice(i, i + MAX_CHUNK));
    }
    write(PASTE_END);
  }
  setTimeout(() => {
    try {
      write(KEYS.ENTER);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[inject] deferred Enter failed (pty likely torn down): ${msg}`);
    }
  }, enterDelay);
}

// src/utils/atomic.ts
var import_fs4 = require("fs");
var import_path3 = require("path");
var import_crypto2 = require("crypto");
function atomicWriteSync(filePath, data) {
  const dir = (0, import_path3.dirname)(filePath);
  (0, import_fs4.mkdirSync)(dir, { recursive: true });
  const tmpPath = (0, import_path3.join)(dir, `.tmp.${(0, import_crypto2.randomBytes)(6).toString("hex")}`);
  try {
    (0, import_fs4.writeFileSync)(tmpPath, data + "\n", { encoding: "utf-8", mode: 384 });
    (0, import_fs4.renameSync)(tmpPath, filePath);
  } catch (err) {
    try {
      const { unlinkSync: unlinkSync3 } = require("fs");
      unlinkSync3(tmpPath);
    } catch {
    }
    throw err;
  }
}
function ensureDir(dirPath) {
  (0, import_fs4.mkdirSync)(dirPath, { recursive: true });
}

// src/utils/env.ts
var import_fs5 = require("fs");
var import_path4 = require("path");

// src/types/index.ts
var PRIORITY_MAP = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3
};
var VALID_PRIORITIES = ["urgent", "high", "normal", "low"];

// src/utils/validate.ts
var AGENT_NAME_REGEX = /^[a-z0-9_-]+$/;
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
function stripControlChars(input) {
  return input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b[^[\]]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// src/utils/env.ts
function writeCortextosEnv(agentDir, env) {
  ensureDir(agentDir);
  const content = [
    `CTX_INSTANCE_ID=${env.instanceId}`,
    `CTX_ROOT=${env.ctxRoot}`,
    `CTX_FRAMEWORK_ROOT=${env.frameworkRoot}`,
    `CTX_AGENT_NAME=${env.agentName}`,
    `CTX_ORG=${env.org}`,
    `CTX_AGENT_DIR=${env.agentDir}`,
    `CTX_PROJECT_ROOT=${env.projectRoot}`
  ].join("\n");
  (0, import_fs5.writeFileSync)((0, import_path4.join)(agentDir, ".cortextos-env"), content + "\n", "utf-8");
}

// src/bus/reminders.ts
var import_fs6 = require("fs");
var import_path5 = require("path");
function remindersPath(paths) {
  return (0, import_path5.join)(paths.stateDir, "pending-reminders.json");
}
function readReminders(paths) {
  const filePath = remindersPath(paths);
  if (!(0, import_fs6.existsSync)(filePath)) return [];
  try {
    const raw = (0, import_fs6.readFileSync)(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function getOverdueReminders(paths) {
  const now = Date.now();
  return readReminders(paths).filter(
    (r) => r.status === "pending" && Date.parse(r.fire_at) <= now
  );
}

// src/bus/cron-state.ts
var import_fs7 = require("fs");
var import_path6 = require("path");
function cronStatePath(stateDir) {
  return (0, import_path6.join)(stateDir, "cron-state.json");
}
function readCronState(stateDir) {
  const filePath = cronStatePath(stateDir);
  if (!(0, import_fs7.existsSync)(filePath)) {
    return { updated_at: (/* @__PURE__ */ new Date()).toISOString(), crons: [] };
  }
  try {
    const raw = (0, import_fs7.readFileSync)(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.crons) ? parsed : { updated_at: (/* @__PURE__ */ new Date()).toISOString(), crons: [] };
  } catch {
    return { updated_at: (/* @__PURE__ */ new Date()).toISOString(), crons: [] };
  }
}
function parseDurationMs(interval) {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = {
    m: 6e4,
    h: 36e5,
    d: 864e5,
    w: 6048e5
  };
  return n * multipliers[unit];
}
function cronExpressionMinIntervalMs(expr) {
  const FALLBACK_MS = 48 * 36e5;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [minute, hour] = parts;
  const everyMin = /^\*\/(\d+)$/.exec(minute);
  if (everyMin && hour === "*") return parseInt(everyMin[1], 10) * 6e4;
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) return parseInt(everyHour[1], 10) * 36e5;
  if (/^\d+$/.test(hour)) return 24 * 36e5;
  return FALLBACK_MS;
}

// src/utils/paths.ts
var import_os3 = require("os");
var import_path7 = require("path");
function resolvePaths(agentName, instanceId = "default", org) {
  validateInstanceId(instanceId);
  const ctxRoot = (0, import_path7.join)((0, import_os3.homedir)(), ".cortextos", instanceId);
  const orgBase = org ? (0, import_path7.join)(ctxRoot, "orgs", org) : ctxRoot;
  return {
    ctxRoot,
    inbox: (0, import_path7.join)(ctxRoot, "inbox", agentName),
    inflight: (0, import_path7.join)(ctxRoot, "inflight", agentName),
    processed: (0, import_path7.join)(ctxRoot, "processed", agentName),
    logDir: (0, import_path7.join)(ctxRoot, "logs", agentName),
    stateDir: (0, import_path7.join)(ctxRoot, "state", agentName),
    taskDir: (0, import_path7.join)(orgBase, "tasks"),
    approvalDir: (0, import_path7.join)(orgBase, "approvals"),
    analyticsDir: (0, import_path7.join)(orgBase, "analytics"),
    deliverablesDir: (0, import_path7.join)(orgBase, "deliverables")
  };
}
function getIpcPath(instanceId = "default") {
  validateInstanceId(instanceId);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return (0, import_path7.join)((0, import_os3.homedir)(), ".cortextos", instanceId, "daemon.sock");
}

// src/daemon/agent-process.ts
var AgentProcess = class {
  name;
  env;
  config;
  pty = null;
  sessionTimer = null;
  crashCount = 0;
  maxCrashesPerDay = 10;
  sessionStart = null;
  status = "stopped";
  stopping = false;
  // BUG-040 fix: persists across stop() return until handleExit clears it.
  // Required because BUG-032's CRLF + 5s wait can cause graceful shutdown to
  // exceed the 5s Promise.race timeout in stop(), which would otherwise reset
  // `stopping=false` BEFORE the PTY actually exits, then handleExit would fire
  // with stopping=false and trigger spurious crash recovery (a partial regression
  // of BUG-011). stopRequested survives the timeout and is only cleared either
  // by handleExit when an intentional exit fires, or by start() at the beginning
  // of a new lifecycle.
  stopRequested = false;
  // BUG-040 fix: monotonic generation counter incremented on each successful
  // start(). Each PTY's onExit closure captures the generation at spawn time
  // and bails out if the generation doesn't match — i.e. a NEW PTY has been
  // spawned since this old one was created. Without this guard, a late exit
  // from an old PTY can race past stopRequested and trigger crash recovery on
  // the new agent.
  lifecycleGeneration = 0;
  // Guard: only one cron verification waiter in-flight per agent at a time.
  // Rapid --continue restarts must not stack duplicate waiters. (Issue #182)
  cronVerificationPending = false;
  // BUG-011 fix: stop() awaits this promise (resolved by the onExit handler in start())
  // to guarantee the PTY exit has fired before stopping=false is reset. Without
  // this, the exit handler can fire after stopping=false and trigger spurious
  // crash recovery for an agent we just stopped intentionally.
  exitPromise = null;
  resolveExit = null;
  dedup;
  log;
  onStatusChange = null;
  constructor(name, env, config, log) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== void 0) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));
  }
  /**
   * Start the agent. Spawns Claude Code in a PTY.
   */
  async start() {
    if (this.status === "running") {
      this.log("Already running");
      return;
    }
    const delay = this.config.startup_delay || 0;
    if (delay > 0) {
      this.log(`Startup delay: ${delay}s`);
      await sleep2(delay * 1e3);
    }
    if (this.env.agentDir) {
      writeCortextosEnv(this.env.agentDir, this.env);
    }
    const mode = this.shouldContinue() ? "continue" : "fresh";
    const prompt = mode === "fresh" ? this.buildStartupPrompt() : this.buildContinuePrompt();
    this.log(`Starting in ${mode} mode`);
    this.status = "starting";
    this.stopRequested = false;
    const myGeneration = ++this.lifecycleGeneration;
    const logPath = (0, import_path8.join)(this.env.ctxRoot, "logs", this.name, "stdout.log");
    ensureDir((0, import_path8.join)(this.env.ctxRoot, "logs", this.name));
    this.log(`Log path: ${logPath}`);
    this.pty = this.config.runtime === "hermes" ? new HermesPTY(this.env, this.config, logPath) : new AgentPTY(this.env, this.config, logPath);
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.pty.onExit((exitCode, signal) => {
      if (myGeneration !== this.lifecycleGeneration) {
        this.log(`Ignoring late exit from previous lifecycle gen ${myGeneration} (current: ${this.lifecycleGeneration})`);
        return;
      }
      this.log(`Exited with code ${exitCode} signal ${signal}`);
      this.handleExit(exitCode);
      this.resolveExit?.();
      this.resolveExit = null;
    });
    try {
      await this.pty.spawn(mode, prompt);
      this.status = "running";
      this.sessionStart = /* @__PURE__ */ new Date();
      this.log(`Running (pid: ${this.pty.getPid()})`);
      this.startSessionTimer();
      this.notifyStatusChange();
    } catch (err) {
      this.log(`Failed to start: ${err}`);
      this.status = "crashed";
      this.notifyStatusChange();
    }
  }
  /**
   * Stop the agent gracefully.
   */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.stopRequested = true;
    this.log("Stopping...");
    this.clearSessionTimer();
    const pty = this.pty;
    this.pty = null;
    const exitPromise = this.exitPromise;
    if (pty) {
      try {
        if (this.config.runtime === "hermes") {
          pty.write("");
          await sleep2(3e3);
        } else {
          pty.write("");
          await sleep2(1e3);
          pty.write("/exit\r\n");
          await sleep2(5e3);
        }
      } catch {
      }
      if (pty.isAlive()) {
        try {
          pty.kill();
        } catch {
        }
      }
      if (exitPromise) {
        await Promise.race([exitPromise, sleep2(15e3)]);
      }
    }
    this.stopping = false;
    this.status = "stopped";
    this.notifyStatusChange();
    this.log("Stopped");
  }
  /**
   * Restart with --continue (session refresh).
   *
   * Delegates to stop() + start() so it inherits the BUG-011 race fix
   * automatically. This also eliminates a separate bug in the previous
   * inline implementation where the OLD pty's exit handler could fire
   * AFTER the NEW pty was set up, nulling out the wrong reference.
   * `start()` will pick up `continue` mode automatically because the
   * conversation directory still has .jsonl files (shouldContinue() is true).
   */
  async sessionRefresh() {
    this.log("Session refresh (--continue restart)");
    await this.stop();
    await this.start();
    this.log("Session refreshed");
  }
  /**
   * Inject a message into the agent's PTY.
   */
  injectMessage(content) {
    if (!this.pty || this.status !== "running") {
      return false;
    }
    if (this.dedup.isDuplicate(content)) {
      this.log("Dedup: skipping duplicate message");
      return false;
    }
    injectMessage((data) => this.pty?.write(data), content);
    return true;
  }
  /**
   * Check if the agent has bootstrapped (ready for messages).
   */
  isBootstrapped() {
    return this.pty?.getOutputBuffer().isBootstrapped() ?? false;
  }
  /**
   * Get current agent status.
   */
  getStatus() {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() || void 0,
      uptime: this.sessionStart ? Math.floor((Date.now() - this.sessionStart.getTime()) / 1e3) : void 0,
      sessionStart: this.sessionStart?.toISOString(),
      crashCount: this.crashCount,
      model: this.config.model
    };
  }
  /**
   * Register a status change handler.
   */
  onStatusChanged(handler) {
    this.onStatusChange = handler;
  }
  /**
   * Write raw data to the agent's PTY.
   * Used for TUI navigation (key sequences).
   */
  write(data) {
    if (this.pty) {
      this.pty.write(data);
    }
  }
  /**
   * Get the output buffer for reading agent output.
   */
  getOutputBuffer() {
    return this.pty?.getOutputBuffer();
  }
  /**
   * Get the agent directory (where config.json and .env live).
   */
  getAgentDir() {
    return this.env.agentDir;
  }
  /**
   * Get the current agent config (live reference — fields may be updated in-place).
   */
  getConfig() {
    return this.config;
  }
  // --- Private methods ---
  handleExit(exitCode) {
    this.pty = null;
    this.clearSessionTimer();
    if (this.isDaemonShuttingDown()) {
      return;
    }
    if (this.stopRequested || this.stopping) {
      this.stopRequested = false;
      return;
    }
    this.crashCount++;
    const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    this.resetCrashCountIfNewDay(today);
    if (this.crashCount >= this.maxCrashesPerDay) {
      this.log(`HALTED: exceeded ${this.maxCrashesPerDay} crashes today`);
      this.appendCrashToRestartsLog(exitCode, 0, "HALTED");
      this.status = "halted";
      this.notifyStatusChange();
      return;
    }
    const backoff = Math.min(5e3 * Math.pow(2, this.crashCount - 1), 3e5);
    this.log(`Crash recovery: restart in ${backoff / 1e3}s (crash #${this.crashCount})`);
    this.appendCrashToRestartsLog(exitCode, backoff, "CRASH");
    this.status = "crashed";
    this.notifyStatusChange();
    setTimeout(() => {
      if (this.status === "crashed") {
        this.start().catch((err) => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
  }
  shouldContinue() {
    if (this.config.runtime === "hermes") {
      const hermesHome = process.env["HERMES_HOME"];
      return hermesDbExists(hermesHome);
    }
    const forceFreshPath = (0, import_path8.join)(this.env.ctxRoot, "state", this.name, ".force-fresh");
    if ((0, import_fs8.existsSync)(forceFreshPath)) {
      try {
        const { unlinkSync: unlinkSync3 } = require("fs");
        unlinkSync3(forceFreshPath);
      } catch {
      }
      return false;
    }
    const launchDir = this.config.working_directory || this.env.agentDir;
    if (!launchDir) return false;
    const convDir = (0, import_path8.join)(
      (0, import_os4.homedir)(),
      ".claude",
      "projects",
      launchDir.split(import_path8.sep).join("-")
    );
    try {
      const files = require("fs").readdirSync(convDir);
      return files.some((f) => f.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }
  buildStartupPrompt() {
    const onboardedPath = (0, import_path8.join)(this.env.ctxRoot, "state", this.name, ".onboarded");
    const onboardingPath = (0, import_path8.join)(this.env.agentDir, "ONBOARDING.md");
    const heartbeatPath = (0, import_path8.join)(this.env.ctxRoot, "state", this.name, "heartbeat.json");
    let onboardingAppend = "";
    if (!(0, import_fs8.existsSync)(onboardedPath) && (0, import_fs8.existsSync)(heartbeatPath)) {
      try {
        const { writeFileSync: writeFileSync16 } = require("fs");
        writeFileSync16(onboardedPath, "", "utf-8");
      } catch {
      }
    }
    if (!(0, import_fs8.existsSync)(onboardedPath) && (0, import_fs8.existsSync)(onboardingPath)) {
      onboardingAppend = " IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol.";
    }
    const nowUtc = (/* @__PURE__ */ new Date()).toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const handoffBlock = this.consumeHandoffBlock();
    const isHandoffRestart = handoffBlock.length > 0;
    const handoffUxOverride = isHandoffRestart ? ` HANDOFF UX: This is a context handoff restart \u2014 your memory is intact via the handoff doc. CRITICAL: After reading the handoff document, your VERY FIRST tool call MUST be a Bash call running: cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID 'back \u2014 [what you were just working on]' \u2014 replace the brackets with one brief plain-English sentence about your current state. Do this BEFORE restoring crons, BEFORE running heartbeat, BEFORE any other tool call. No cron IDs, no status report, no cold-boot phrasing. Do NOT send "Booting up... one moment" (skip AGENTS.md step 1 entirely).` : "";
    const onlineMessage = isHandoffRestart ? "" : " After setting up crons, send a Telegram message to the user saying you are back online.";
    return `You are starting a new session. Current UTC time: ${nowUtc}. Read AGENTS.md and all bootstrap files listed there. Then restore your crons from config.json: CRITICAL DEDUP: Always call CronList BEFORE creating any cron. For each config.json entry, search the CronList output for its prompt text \u2014 if the prompt already appears, SKIP that cron entirely. For entries NOT already listed: for each entry with type "recurring" (or no type field), call CronCreate directly (do NOT use /loop \u2014 /loop will prompt the user about cloud scheduling which blocks boot in autonomous mode). Convert the interval to a cron expression: 1h\u2192"0 */1 * * *", 2h\u2192"0 */2 * * *", 4h\u2192"0 */4 * * *", 6h\u2192"0 */6 * * *", 12h\u2192"0 */12 * * *", 24h\u2192"0 0 * * *", Nm\u2192"*/N * * * *". Pass recurring:true. For entries with type "once": compare fire_at against the current UTC time \u2014 if fire_at is in the future call CronCreate (one-shot, no recurring flag), if in the past delete that entry from config.json.${reminderBlock}${deliverablesBlock}${handoffBlock}${handoffUxOverride}${onlineMessage}${onboardingAppend}`;
  }
  buildContinuePrompt() {
    const nowUtc = (/* @__PURE__ */ new Date()).toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. Restore your crons from config.json ONLY if missing. CRITICAL DEDUP: Call CronList FIRST. For each config.json entry, search the CronList output for its prompt text \u2014 if the prompt already appears, SKIP that cron. For entries NOT already listed: use CronCreate directly (do NOT use /loop \u2014 /loop will prompt about cloud scheduling which blocks autonomous boot). Convert interval to cron expression: 1h\u2192"0 */1 * * *", 6h\u2192"0 */6 * * *", 24h\u2192"0 0 * * *", Nm\u2192"*/N * * * *". Pass recurring:true for recurring entries, no recurring flag for once entries (only if fire_at is in the future). Rapid --continue restarts must not accumulate duplicates.${reminderBlock}${deliverablesBlock} Check inbox. Resume normal operations. After restoring crons and checking inbox, send a Telegram message to the user saying you are back online.`;
  }
  /**
   * Build a reminder block for the boot prompt.
   * If any pending reminders are overdue, include them so the agent handles them
   * even after a hard-restart that cleared in-memory cron state (#69).
   */
  buildReminderBlock() {
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      const overdue = getOverdueReminders(paths);
      if (overdue.length === 0) return "";
      const items = overdue.map(
        (r) => `  - [${r.id}] (due ${r.fire_at}): ${r.prompt}`
      ).join("\n");
      return ` You also have ${overdue.length} overdue persistent reminder(s) from before this restart \u2014 handle each one, then run: cortextos bus ack-reminder <id>
${items}`;
    } catch {
      return "";
    }
  }
  /**
   * Build a deliverable-standard instruction block for the boot prompt.
   * When require_deliverables is enabled in the org's context.json, agents
   * are told that every task submitted for review must have at least one
   * file attached via save-output. The instruction is injected dynamically
   * so existing agents pick up the rule on their next boot with zero file
   * changes, and toggling it off removes it from the next startup prompt.
   */
  buildDeliverablesBlock() {
    try {
      const contextPath = (0, import_path8.join)(this.env.frameworkRoot, "orgs", this.env.org, "context.json");
      if (!(0, import_fs8.existsSync)(contextPath)) return "";
      const ctx = JSON.parse((0, import_fs8.readFileSync)(contextPath, "utf-8"));
      if (!ctx.require_deliverables) return "";
      return ' DELIVERABLE STANDARD: Every task you submit for review MUST have at least one file deliverable attached via the save-output bus command. A task with zero file deliverables will be sent back. Attach files with: cortextos bus save-output <task-id> <file-path> --label "<descriptive label>". Labels must be human-readable at a glance: describe WHAT it is plus enough context to understand at a glance. Good: "Traffic Growth Plan \u2014 10 channels, 30-day launch sequence". Bad: "traffic-growth-plan.md" or "output-1". Notes are for context only, never file paths or URLs.';
    } catch {
      return "";
    }
  }
  /**
   * Consume the .handoff-doc-path marker (written by the context watchdog or the
   * agent itself via `cortextos bus hard-restart --handoff-doc <path>`).
   * Returns a boot-prompt fragment pointing the new session at the handoff doc,
   * or an empty string if no marker exists.
   * The marker is unlinked after reading so it fires only once per restart.
   */
  consumeHandoffBlock() {
    const markerPath = (0, import_path8.join)(this.env.ctxRoot, "state", this.name, ".handoff-doc-path");
    if (!(0, import_fs8.existsSync)(markerPath)) return "";
    try {
      const { unlinkSync: unlinkSync3 } = require("fs");
      const docPath = (0, import_fs8.readFileSync)(markerPath, "utf-8").trim();
      unlinkSync3(markerPath);
      if (!docPath || !(0, import_fs8.existsSync)(docPath)) return "";
      return ` CONTEXT HANDOFF: Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
    } catch {
      return "";
    }
  }
  startSessionTimer() {
    const DEFAULT_MAX_SESSION_S = 255600;
    const startedAt = Date.now();
    const initialMs = (this.config.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1e3;
    const scheduleCheck = (delayMs) => {
      this.sessionTimer = setTimeout(() => {
        let currentMaxMs = initialMs;
        try {
          const configPath = (0, import_path8.join)(this.env.agentDir, "config.json");
          if ((0, import_fs8.existsSync)(configPath)) {
            const cfg = JSON.parse((0, import_fs8.readFileSync)(configPath, "utf-8"));
            currentMaxMs = (cfg.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1e3;
          }
        } catch {
        }
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = currentMaxMs - elapsedMs;
        if (remainingMs > 5e3) {
          this.log(`Session timer: config updated to ${currentMaxMs / 1e3}s, rescheduling (${Math.round(remainingMs / 1e3)}s remaining)`);
          scheduleCheck(remainingMs);
          return;
        }
        this.log(`Session timer fired after ${Math.round(elapsedMs / 1e3)}s (limit: ${currentMaxMs / 1e3}s)`);
        this.sessionRefresh().catch((err) => this.log(`Session refresh failed: ${err}`));
      }, delayMs);
    };
    scheduleCheck(initialMs);
  }
  clearSessionTimer() {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }
  /**
   * Check whether the daemon is currently in its shutdown sequence.
   *
   * Returns true iff a `.daemon-stop` marker exists in this agent's state
   * dir AND was written within the last 60 seconds. The marker is written
   * by AgentManager.stopAll() before it begins iterating stopAgent() calls.
   * A stale marker older than 60s is treated as leftover from a prior
   * shutdown and ignored — real crashes must not be masked indefinitely.
   */
  isDaemonShuttingDown() {
    const marker = (0, import_path8.join)(this.env.ctxRoot, "state", this.name, ".daemon-stop");
    try {
      if (!(0, import_fs8.existsSync)(marker)) return false;
      const ageMs = Date.now() - (0, import_fs8.statSync)(marker).mtimeMs;
      return ageMs < 6e4;
    } catch {
      return false;
    }
  }
  /**
   * Append an unplanned-exit entry to restarts.log. Complements the planned
   * SELF-RESTART / HARD-RESTART entries written by src/bus/system.ts so that
   * a single file gives the complete restart history for an agent.
   *
   * Format matches bus/system.ts: `[ISO] <KIND>: <details>`. appendFileSync
   * uses write(2) with O_APPEND on Linux, which is atomic for writes under
   * PIPE_BUF (~4KB) — each CRASH line fits comfortably. All errors are
   * swallowed: logging must never break crash recovery.
   */
  appendCrashToRestartsLog(exitCode, backoffMs, kind) {
    try {
      const logDir = (0, import_path8.join)(this.env.ctxRoot, "logs", this.name);
      ensureDir(logDir);
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
      const details = kind === "HALTED" ? `exit_code=${exitCode} crash_count=${this.crashCount} max_crashes=${this.maxCrashesPerDay}` : `exit_code=${exitCode} crash_count=${this.crashCount} backoff_s=${backoffMs / 1e3}`;
      const logLine = `[${timestamp}] ${kind}: ${details}
`;
      (0, import_fs8.appendFileSync)((0, import_path8.join)(logDir, "restarts.log"), logLine, "utf-8");
    } catch {
    }
  }
  resetCrashCountIfNewDay(today) {
    const crashFile = (0, import_path8.join)(this.env.ctxRoot, "logs", this.name, ".crash_count_today");
    try {
      if ((0, import_fs8.existsSync)(crashFile)) {
        const content = (0, import_fs8.readFileSync)(crashFile, "utf-8").trim();
        const [storedDate, count] = content.split(":");
        if (storedDate === today) {
          this.crashCount = parseInt(count, 10) + 1;
        } else {
          this.crashCount = 1;
        }
      }
      ensureDir((0, import_path8.join)(this.env.ctxRoot, "logs", this.name));
      (0, import_fs8.writeFileSync)(crashFile, `${today}:${this.crashCount}`, "utf-8");
    } catch {
    }
  }
  notifyStatusChange() {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }
  /**
   * Schedule a background cron verification check.
   *
   * Waits for the agent to finish its startup sequence (detected via the
   * last_idle.flag written by the Stop hook after the agent's first turn
   * completes), then injects a lightweight prompt asking the agent to
   * verify its crons match config.json and restore any that are missing.
   *
   * Safe for both fresh starts and --continue restarts: the idle-wait
   * ensures we never inject mid-conversation.
   *
   * Fire-and-forget: errors are logged but never propagated.
   */
  scheduleCronVerification() {
    if (this.config.runtime === "hermes") return;
    const crons = this.config.crons;
    if (!crons || crons.length === 0) return;
    const recurringNames = crons.filter((c) => c.type !== "once" && c.type !== "disabled").map((c) => c.name);
    if (recurringNames.length === 0) return;
    if (this.cronVerificationPending) {
      this.log("Cron verification already pending \u2014 skipping duplicate");
      return;
    }
    const generation = this.lifecycleGeneration;
    this.cronVerificationPending = true;
    this.verifyCronsAfterIdle(recurringNames, generation).catch((err) => {
      this.log(`Cron verification failed (non-fatal): ${err}`);
    }).finally(() => {
      this.cronVerificationPending = false;
    });
  }
  /**
   * Starts a background gap-detection loop for recurring interval-based crons.
   * Reads cron-state.json every 10 minutes; injects a nudge if any cron has
   * been silent for >2x its expected interval.
   *
   * Fire-and-forget: errors are logged but never propagated.
   */
  scheduleGapDetection() {
    const crons = this.config.crons;
    if (!crons || crons.length === 0) return;
    const monitorable = crons.filter((c) => {
      if (c.type === "once" || c.type === "disabled") return false;
      if (c.interval && !isNaN(parseDurationMs(c.interval))) return true;
      if (c.cron) return true;
      return false;
    });
    if (monitorable.length === 0) return;
    const generation = this.lifecycleGeneration;
    const loopStartedAt = Date.now();
    this.runGapDetectionLoop(monitorable, generation, loopStartedAt).catch((err) => {
      this.log(`Cron gap detection failed (non-fatal): ${err}`);
    });
  }
  async runGapDetectionLoop(crons, generation, loopStartedAt) {
    const GAP_POLL_MS = 10 * 60 * 1e3;
    const GAP_MULTIPLIER = 2;
    const stateDir = (0, import_path8.join)(this.env.ctxRoot, "state", this.name);
    await sleep2(GAP_POLL_MS);
    while (true) {
      if (generation !== this.lifecycleGeneration || this.status !== "running") return;
      const now = Date.now();
      const state = readCronState(stateDir);
      for (const cronDef of crons) {
        const intervalMs = cronDef.interval ? parseDurationMs(cronDef.interval) : cronExpressionMinIntervalMs(cronDef.cron);
        const record = state.crons.find((r) => r.name === cronDef.name);
        let lastFireMs;
        if (!record) {
          lastFireMs = loopStartedAt;
        } else {
          lastFireMs = Date.parse(record.last_fire);
          if (isNaN(lastFireMs)) continue;
          lastFireMs = Math.max(lastFireMs, loopStartedAt);
        }
        const gapMs = now - lastFireMs;
        const threshold = intervalMs * GAP_MULTIPLIER;
        if (gapMs > threshold) {
          const gapMin = Math.round(gapMs / 6e4);
          const expectedMin = Math.round(intervalMs / 6e4);
          const restoreHint = cronDef.interval ? `If missing, restore it from config.json: /loop ${cronDef.interval} <cron prompt>.` : `If missing, restore it from config.json using the cron expression in your config.`;
          const nudge = `[SYSTEM] Cron gap detected for "${cronDef.name}": last fired ${gapMin} minutes ago (expected every ${expectedMin} minutes). Run CronList to verify the cron is still active. ${restoreHint}`;
          this.log(`Gap nudge: ${cronDef.name} silent ${gapMin}min (threshold: ${Math.round(threshold / 6e4)}min)`);
          if (this.pty && this.status === "running") {
            injectMessage((data) => this.pty?.write(data), nudge);
            await sleep2(3e4);
          }
        }
      }
      await sleep2(GAP_POLL_MS);
    }
  }
  async verifyCronsAfterIdle(expectedCrons, generation) {
    const stateDir = (0, import_path8.join)(this.env.ctxRoot, "state", this.name);
    const flagPath = (0, import_path8.join)(stateDir, "last_idle.flag");
    let bootIdleTs = 0;
    try {
      if ((0, import_fs8.existsSync)(flagPath)) {
        bootIdleTs = parseInt((0, import_fs8.readFileSync)(flagPath, "utf-8").trim(), 10);
      }
    } catch {
    }
    const maxWaitMs = 30 * 60 * 1e3;
    const pollMs = 15e3;
    const startTime = Date.now();
    let foundIdle = false;
    while (Date.now() - startTime < maxWaitMs) {
      if (generation !== this.lifecycleGeneration || this.status !== "running") {
        return;
      }
      await sleep2(pollMs);
      try {
        if ((0, import_fs8.existsSync)(flagPath)) {
          const currentIdleTs = parseInt((0, import_fs8.readFileSync)(flagPath, "utf-8").trim(), 10);
          if (currentIdleTs > bootIdleTs) {
            foundIdle = true;
            break;
          }
        }
      } catch {
      }
    }
    if (!foundIdle) {
      this.log("Cron verification: timed out waiting for idle flag, skipping injection");
      return;
    }
    if (generation !== this.lifecycleGeneration || this.status !== "running") {
      return;
    }
    const cronList = expectedCrons.join(", ");
    const verifyPrompt = `[SYSTEM] Cron verification: your config.json defines these recurring crons: ${cronList}. Run CronList now. If any are missing, restore them from config.json using /loop. This is an automated safety check.`;
    this.log(`Injecting cron verification (expecting: ${cronList})`);
    if (this.pty) {
      injectMessage((data) => this.pty?.write(data), verifyPrompt);
    }
  }
};
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/daemon/worker-process.ts
var import_path9 = require("path");
var import_fs9 = require("fs");
var WorkerProcess = class {
  name;
  dir;
  parent;
  pty = null;
  status = "starting";
  spawnedAt;
  exitCode;
  onDoneCallback = null;
  log;
  constructor(name, dir, parent, log) {
    this.name = name;
    this.dir = dir;
    this.parent = parent;
    this.spawnedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.log = log || ((msg) => console.log(`[worker:${name}] ${msg}`));
  }
  /**
   * Spawn the worker Claude Code session with the given task prompt.
   */
  async spawn(env, prompt) {
    try {
      (0, import_fs9.mkdirSync)((0, import_path9.join)(env.ctxRoot, "inbox", this.name), { recursive: true });
      (0, import_fs9.mkdirSync)((0, import_path9.join)(env.ctxRoot, "state", this.name), { recursive: true });
      (0, import_fs9.mkdirSync)((0, import_path9.join)(env.ctxRoot, "logs", this.name), { recursive: true });
    } catch {
    }
    const logPath = (0, import_path9.join)(env.ctxRoot, "logs", this.name, "stdout.log");
    this.pty = new AgentPTY(env, {}, logPath);
    this.pty.onExit((code) => {
      this.exitCode = code;
      this.status = code === 0 ? "completed" : "failed";
      this.log(`Exited with code ${code} \u2192 ${this.status}`);
      if (this.onDoneCallback) {
        this.onDoneCallback(this.name, code);
      }
      this.pty = null;
    });
    await this.pty.spawn("fresh", prompt);
    this.status = "running";
    this.log(`Running (pid: ${this.pty.getPid()}, dir: ${this.dir})`);
  }
  /**
   * Terminate the worker session.
   */
  async terminate() {
    if (!this.pty) return;
    this.log("Terminating...");
    try {
      this.pty.write("");
      await sleep3(500);
      this.pty.kill();
    } catch {
    }
    this.status = "completed";
    this.pty = null;
  }
  /**
   * Inject text into the worker's PTY (equivalent to tmux send-keys).
   * Use to nudge a stuck worker without restarting it.
   */
  inject(text) {
    if (!this.pty || this.status !== "running") return false;
    injectMessage((data) => this.pty?.write(data), text);
    return true;
  }
  /**
   * Get current worker status snapshot.
   */
  getStatus() {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() ?? void 0,
      dir: this.dir,
      parent: this.parent,
      spawnedAt: this.spawnedAt,
      exitCode: this.exitCode
    };
  }
  isFinished() {
    return this.status === "completed" || this.status === "failed";
  }
  /**
   * Register a callback that fires when the worker exits.
   */
  onDone(cb) {
    this.onDoneCallback = cb;
  }
};
function sleep3(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/daemon/fast-checker.ts
var import_fs15 = require("fs");
var import_child_process = require("child_process");
var import_path15 = require("path");
var import_crypto5 = require("crypto");

// src/bus/system.ts
var import_fs11 = require("fs");
var import_path11 = require("path");

// src/telegram/api.ts
var import_fs10 = require("fs");
var import_path10 = require("path");
var TelegramAPI = class {
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
    if (!(0, import_fs10.existsSync)(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }
    await this.rateLimit(String(chatId));
    const fileData = (0, import_fs10.readFileSync)(imagePath);
    const fileName = (0, import_path10.basename)(imagePath);
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
    if (!(0, import_fs10.existsSync)(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    await this.rateLimit(String(chatId));
    const fileData = (0, import_fs10.readFileSync)(filePath);
    const fileName = (0, import_path10.basename)(filePath);
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
      await new Promise((resolve) => setTimeout(resolve, 1e3 - elapsed));
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

// src/bus/system.ts
var MAX_FILE_SIZE = 10 * 1024 * 1024;
function hardRestart(paths, agentName, reason) {
  const resolvedReason = reason || "no reason specified";
  ensureDir(paths.stateDir);
  (0, import_fs11.writeFileSync)((0, import_path11.join)(paths.stateDir, ".force-fresh"), resolvedReason + "\n", "utf-8");
  (0, import_fs11.writeFileSync)((0, import_path11.join)(paths.stateDir, ".restart-planned"), resolvedReason + "\n", "utf-8");
  ensureDir(paths.logDir);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const logLine = `[${timestamp}] HARD-RESTART: ${resolvedReason}
`;
  (0, import_fs11.appendFileSync)((0, import_path11.join)(paths.logDir, "restarts.log"), logLine, "utf-8");
}

// src/bus/message.ts
var import_fs13 = require("fs");
var import_path13 = require("path");
var import_crypto4 = require("crypto");

// src/utils/lock.ts
var import_fs12 = require("fs");
var import_path12 = require("path");
function acquireLock(dir) {
  const lockDir = (0, import_path12.join)(dir, ".lock.d");
  const pidFile = (0, import_path12.join)(lockDir, "pid");
  try {
    (0, import_fs12.mkdirSync)(lockDir);
    (0, import_fs12.writeFileSync)(pidFile, String(process.pid));
    return true;
  } catch {
    try {
      const storedPid = parseInt((0, import_fs12.readFileSync)(pidFile, "utf-8").trim(), 10);
      if (isNaN(storedPid)) {
        (0, import_fs12.rmSync)(lockDir, { recursive: true, force: true });
        try {
          (0, import_fs12.mkdirSync)(lockDir);
          (0, import_fs12.writeFileSync)(pidFile, String(process.pid));
          return true;
        } catch {
          return false;
        }
      }
      try {
        process.kill(storedPid, 0);
        return false;
      } catch {
        (0, import_fs12.rmSync)(lockDir, { recursive: true, force: true });
        try {
          (0, import_fs12.mkdirSync)(lockDir);
          (0, import_fs12.writeFileSync)(pidFile, String(process.pid));
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      try {
        (0, import_fs12.rmSync)(lockDir, { recursive: true, force: true });
        (0, import_fs12.mkdirSync)(lockDir);
        (0, import_fs12.writeFileSync)(pidFile, String(process.pid));
        return true;
      } catch {
        return false;
      }
    }
  }
}
function releaseLock(dir) {
  const lockDir = (0, import_path12.join)(dir, ".lock.d");
  try {
    (0, import_fs12.rmSync)(lockDir, { recursive: true, force: true });
  } catch {
  }
}

// src/utils/random.ts
var import_crypto3 = require("crypto");
var ALPHA_NUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomString(length) {
  const bytes = (0, import_crypto3.randomBytes)(length * 2);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ALPHA_NUMERIC[bytes[i] % ALPHA_NUMERIC.length];
  }
  return result;
}

// src/bus/message.ts
function loadSigningKey(ctxRoot) {
  const keyPath = (0, import_path13.join)(ctxRoot, "config", "bus-signing-key");
  if (!(0, import_fs13.existsSync)(keyPath)) return null;
  try {
    return (0, import_fs13.readFileSync)(keyPath, "utf-8").trim();
  } catch {
    return null;
  }
}
function hmacSign(key, payload) {
  return (0, import_crypto4.createHmac)("sha256", key).update(payload).digest("hex");
}
function hmacVerify(key, payload, sig) {
  const expected = hmacSign(key, payload);
  try {
    return (0, import_crypto4.timingSafeEqual)(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
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
  const inboxDir = (0, import_path13.join)(paths.ctxRoot, "inbox", to);
  ensureDir(inboxDir);
  atomicWriteSync((0, import_path13.join)(inboxDir, filename), JSON.stringify(message));
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
    const files = (0, import_fs13.readdirSync)(inbox).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
    if (files.length === 0) {
      return [];
    }
    const signingKey = loadSigningKey(paths.ctxRoot);
    const messages = [];
    for (const file of files) {
      const srcPath = (0, import_path13.join)(inbox, file);
      try {
        const content = (0, import_fs13.readFileSync)(srcPath, "utf-8");
        const msg = JSON.parse(content);
        if (signingKey && msg.sig) {
          const valid = hmacVerify(signingKey, signPayload(msg.id, msg.from, msg.to, msg.text), msg.sig);
          if (!valid) {
            console.error(`[bus/message] SECURITY: Message ${msg.id} from '${msg.from}' failed HMAC verification \u2014 rejecting`);
            const errDir = (0, import_path13.join)(inbox, ".errors");
            ensureDir(errDir);
            try {
              (0, import_fs13.renameSync)(srcPath, (0, import_path13.join)(errDir, file));
            } catch {
            }
            continue;
          }
        } else if (signingKey && !msg.sig) {
          console.warn(`[bus/message] WARNING: Unsigned message ${msg.id} from '${msg.from}' \u2014 accepted (legacy)`);
        }
        const destPath = (0, import_path13.join)(inflight, file);
        (0, import_fs13.renameSync)(srcPath, destPath);
        messages.push(msg);
      } catch {
        const errDir = (0, import_path13.join)(inbox, ".errors");
        ensureDir(errDir);
        try {
          (0, import_fs13.renameSync)(srcPath, (0, import_path13.join)(errDir, file));
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
    files = (0, import_fs13.readdirSync)(inflight).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = (0, import_path13.join)(inflight, file);
    try {
      const content = (0, import_fs13.readFileSync)(filePath, "utf-8");
      const msg = JSON.parse(content);
      if (msg.id === messageId) {
        (0, import_fs13.renameSync)(filePath, (0, import_path13.join)(processed, file));
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
    files = (0, import_fs13.readdirSync)(inflightDir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = (0, import_path13.join)(inflightDir, file);
    try {
      const stat = (0, import_fs13.statSync)(filePath);
      const mtime = Math.floor(stat.mtimeMs / 1e3);
      if (now - mtime > thresholdSeconds) {
        (0, import_fs13.renameSync)(filePath, (0, import_path13.join)(inboxDir, file));
      }
    } catch {
    }
  }
}

// src/bus/approval.ts
var import_fs14 = require("fs");
var import_path14 = require("path");
function updateApproval(paths, approvalId, status, note) {
  const pendingDir = (0, import_path14.join)(paths.approvalDir, "pending");
  const filePath = (0, import_path14.join)(pendingDir, `${approvalId}.json`);
  try {
    const content = (0, import_fs14.readFileSync)(filePath, "utf-8");
    const approval = JSON.parse(content);
    approval.status = status;
    approval.updated_at = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    approval.resolved_at = approval.updated_at;
    approval.resolved_by = note || null;
    const destDir = (0, import_path14.join)(paths.approvalDir, "resolved");
    ensureDir(destDir);
    atomicWriteSync((0, import_path14.join)(destDir, `${approvalId}.json`), JSON.stringify(approval));
    const { unlinkSync: unlinkSync3 } = require("fs");
    unlinkSync3(filePath);
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

// src/daemon/fast-checker.ts
var FastChecker = class {
  agent;
  paths;
  running = false;
  pollInterval;
  log;
  typingLastSent = 0;
  // Hook-based typing: track when we last injected a Telegram message (ms)
  lastMessageInjectedAt = 0;
  // Track outbound message log size to detect when agent sends a reply
  outboundLogSize = 0;
  // Track stdout log size to detect when agent is actively producing output
  stdoutLogSize = -1;
  frameworkRoot;
  telegramApi;
  chatId;
  allowedUserId;
  // External Telegram handler (set by daemon)
  telegramMessages = [];
  // Persistent dedup: message hashes to prevent duplicate delivery
  seenHashes = /* @__PURE__ */ new Set();
  dedupFilePath = "";
  // SIGUSR1 wake: resolve to immediately wake from sleep
  wakeResolve = null;
  // Idle-session heartbeat watchdog
  heartbeatTimer = null;
  // Context monitor state
  ctxConfigMtime = 0;
  ctxWarningFiredAt = 0;
  // dedup: 15min cooldown between warnings
  ctxHandoffFiredAt = 0;
  // fires once per session (0 = not yet)
  ctxHandoffDeadlineAt = 0;
  // timestamp after which force-restart fires
  ctxLastSessionId = null;
  // detects new session → clears stale deadline
  ctxCircuitRestarts = [];
  // timestamps of recent context-triggered restarts
  ctxCircuitBrokenAt = null;
  // when circuit tripped (null = healthy)
  // Persisted to disk so --continue restarts don't reset the circuit breaker
  ctxCircuitFile = "";
  constructor(agent, paths, frameworkRoot, options = {}) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1e3;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserId = options.allowedUserId;
    this.dedupFilePath = (0, import_path15.join)(paths.stateDir, ".message-dedup-hashes");
    this.loadDedupHashes();
    this.ctxCircuitFile = (0, import_path15.join)(paths.stateDir, ".ctx-circuit.json");
    this.loadCtxCircuit();
  }
  /**
   * Start the polling loop.
   */
  async start() {
    this.running = true;
    this.log("Starting. Waiting for bootstrap...");
    const sigusr1Handler = () => {
      this.log("SIGUSR1 received - waking immediately");
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
    };
    if (process.platform !== "win32") {
      process.on("SIGUSR1", sigusr1Handler);
    }
    await this.waitForBootstrap();
    this.log("Bootstrap complete. Beginning poll loop.");
    const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1e3;
    const agentName = this.agent.name;
    this.heartbeatTimer = setInterval(() => {
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      (0, import_child_process.execFile)("cortextos", ["bus", "update-heartbeat", `[watchdog] ${agentName} alive \u2014 idle session ${ts}`], (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      });
    }, HEARTBEAT_INTERVAL_MS);
    while (this.running) {
      try {
        this.checkUrgentSignal();
        await this.pollCycle();
      } catch (err) {
        this.log(`Poll error: ${err}`);
      }
      await this.sleepInterruptible(this.pollInterval);
    }
    if (process.platform !== "win32") {
      process.removeListener("SIGUSR1", sigusr1Handler);
    }
  }
  /**
   * Stop the polling loop.
   */
  stop() {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  /**
   * Trigger immediate wake from sleep.
   * Cross-platform alternative to SIGUSR1, called by IPC 'wake' command.
   */
  wake() {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }
  /**
   * Queue a formatted Telegram message for injection.
   * Called by the daemon's Telegram handler.
   */
  queueTelegramMessage(formatted) {
    this.telegramMessages.push({ formatted, ackIds: [] });
  }
  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  async pollCycle() {
    let messageBlock = "";
    const ackIds = [];
    let hasTelegramMessage = false;
    while (this.telegramMessages.length > 0) {
      const msg = this.telegramMessages.shift();
      messageBlock += msg.formatted;
      hasTelegramMessage = true;
    }
    const inboxMessages = checkInbox(this.paths);
    for (const msg of inboxMessages) {
      messageBlock += this.formatInboxMessage(msg);
      ackIds.push(msg.id);
    }
    if (messageBlock) {
      const injected = this.agent.injectMessage(messageBlock);
      if (injected) {
        for (const id of ackIds) {
          ackInbox(this.paths, id);
        }
        this.log(`Injected ${messageBlock.length} bytes`);
        if (hasTelegramMessage) {
          this.lastMessageInjectedAt = Date.now();
        }
        await sleep4(5e3);
      }
    }
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
    }
    await this.checkContextStatus();
  }
  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  formatInboxMessage(msg) {
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : "";
    return `=== AGENT MESSAGE from ${msg.from}${replyNote} [msg_id: ${msg.id}] ===
\`\`\`
${msg.text}
\`\`\`
Reply using: cortextos bus send-message ${msg.from} normal '<your reply>' ${msg.id}

`;
  }
  /**
   * Format a Telegram text message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramTextMessage(from, chatId, text, frameworkRoot, replyToText, lastSentText, recentHistory) {
    let replyCx = "";
    if (replyToText) {
      replyCx = `[Replying to: "${replyToText.slice(0, 500)}"]
`;
    }
    let lastSentCtx = "";
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${lastSentText.slice(0, 500)}"]
`;
    }
    let historyCx = "";
    if (recentHistory) {
      historyCx = `[Recent conversation:]
${recentHistory}
`;
    }
    const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
    const body = isSlashCommand ? text.trim() : `\`\`\`
${text}
\`\`\``;
    return `=== TELEGRAM from [USER: ${from}] (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }
  /**
   * Format a Telegram message_reaction update for PTY injection.
   * Reactions are emoji additions/removals on existing messages — they
   * surface to the agent so it can follow up on positive acknowledgements
   * or clarify after a negative reaction.
   *
   * `newReaction` is the current reaction state (an empty list means the
   * user REMOVED their reaction). `oldReaction` lets the formatter
   * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
   * render as [custom_emoji] since we don't resolve the custom_emoji_id.
   */
  static formatTelegramReaction(from, chatId, messageId, oldReaction, newReaction) {
    const render = (list) => list.length === 0 ? "(none)" : list.map((r) => r.type === "emoji" ? r.emoji : "[custom_emoji]").join(" ");
    const removed = newReaction.length === 0 && oldReaction.length > 0;
    const label = removed ? `removed ${render(oldReaction)}` : render(newReaction);
    return `=== REACTION from [USER: ${from}] (chat_id:${chatId}) on message ${messageId}: ${label} ===

`;
  }
  /**
   * Format a Telegram photo message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramPhotoMessage(from, chatId, caption, imagePath) {
    return `=== TELEGRAM PHOTO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }
  /**
   * Format a Telegram document message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramDocumentMessage(from, chatId, caption, filePath, fileName) {
    return `=== TELEGRAM DOCUMENT from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }
  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVoiceMessage(from, chatId, filePath, duration) {
    const dur = duration !== void 0 ? duration : "unknown";
    return `=== TELEGRAM VOICE from ${from} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }
  /**
   * Format a Telegram video/video_note message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVideoMessage(from, chatId, caption, filePath, fileName, duration) {
    const dur = duration !== void 0 ? duration : "unknown";
    return `=== TELEGRAM VIDEO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
duration: ${dur}s
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }
  /**
   * Wait for the agent to finish bootstrapping.
   */
  async waitForBootstrap(timeoutMs = 3e4) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isBootstrapped()) {
        return;
      }
      await sleep4(2e3);
    }
    this.log("Bootstrap timeout - proceeding anyway");
  }
  /**
   * Send typing indicator, rate-limited to once every 4 seconds.
   */
  async sendTyping(api, chatId) {
    const now = Date.now();
    if (now - this.typingLastSent >= 4e3) {
      try {
        await api.sendChatAction(chatId, "typing");
      } catch {
      }
      this.typingLastSent = now;
    }
  }
  /**
   * Read the last-sent message file for conversation context.
   * Returns the content (up to 500 chars) or null if not available.
   */
  static readLastSent(stateDir, chatId) {
    const filePath = (0, import_path15.join)(stateDir, `last-telegram-${chatId}.txt`);
    try {
      if (!(0, import_fs15.existsSync)(filePath)) return null;
      const content = (0, import_fs15.readFileSync)(filePath, "utf-8");
      if (!content) return null;
      return content.slice(0, 500);
    } catch {
      return null;
    }
  }
  /**
   * Handle a callback from the org's activity-channel bot.
   *
   * Runs alongside the agent's primary bot callback handler when the agent
   * is the org's orchestrator (see agent-manager.ts for the wiring). Only
   * appr_(allow|deny)_<approvalId> prefixes are accepted here — the
   * activity-channel bot only ever posts approval buttons, so any other
   * callback is rejected. The responding API must be the activity-channel
   * API (not the agent's own bot) so answerCallbackQuery + editMessageText
   * target the right message on the right bot.
   */
  async handleActivityCallback(query, activityApi) {
    const data = stripControlChars(query.data || "");
    const callbackQueryId = query.id;
    if (this.allowedUserId !== void 0) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: activity-channel callback from unauthorized user ${fromUserId} - rejecting`);
        try {
          await activityApi.answerCallbackQuery(callbackQueryId, "Not authorized");
        } catch {
        }
        return;
      }
    }
    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (!apprMatch) {
      this.log(`activity-channel callback ignored (unknown prefix): ${data.slice(0, 40)}`);
      try {
        await activityApi.answerCallbackQuery(callbackQueryId, "Unknown button");
      } catch {
      }
      return;
    }
    await this.routeApprovalCallback(apprMatch[1], apprMatch[2], query, activityApi);
  }
  /**
   * Shared approval-callback resolution path. Called by both handleCallback
   * (agent's own bot) and handleActivityCallback (activity-channel bot).
   *
   * Resolves the approval via updateApproval (which moves the file from
   * pending/ to resolved/ and notifies the requesting agent via inbox),
   * answers the Telegram callback so the spinner stops, and edits the
   * original message to show who approved/denied for the audit trail.
   *
   * `api` is the TelegramAPI that owns the bot the callback came from —
   * answerCallbackQuery and editMessageText must target the same bot.
   */
  async routeApprovalCallback(decision, approvalId, query, api) {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;
    const status = decision === "allow" ? "approved" : "rejected";
    const firstName = query.from?.first_name;
    const username = query.from?.username;
    const auditWho = firstName && username ? `${firstName} (@${username})` : firstName ?? (username ? `@${username}` : `user ${query.from?.id ?? "unknown"}`);
    const auditNote = `via Telegram activity channel by ${auditWho}`;
    try {
      updateApproval(this.paths, approvalId, status, auditNote);
    } catch (err) {
      this.log(`Approval callback: updateApproval failed for ${approvalId}: ${err}`);
      if (api) {
        try {
          await api.answerCallbackQuery(callbackQueryId, "Approval not found or already resolved");
        } catch {
        }
      }
      return;
    }
    if (api) {
      try {
        await api.answerCallbackQuery(callbackQueryId, decision === "allow" ? "Approved" : "Denied");
      } catch {
      }
      if (chatId && messageId) {
        const label = decision === "allow" ? `\u2705 Approved by ${auditWho}` : `\u274C Denied by ${auditWho}`;
        try {
          await api.editMessageText(chatId, messageId, label);
        } catch {
        }
      }
    }
    this.log(`Approval callback: ${decision} for ${approvalId} by ${auditWho}`);
  }
  /**
   * Handle a Telegram inline button callback query.
   * Routes to permission, restart, or AskUserQuestion handlers.
   */
  async handleCallback(query) {
    const data = stripControlChars(query.data || "");
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;
    if (this.allowedUserId !== void 0) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: callback from unauthorized user ${fromUserId} - rejecting`);
        return;
      }
    }
    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (apprMatch) {
      await this.routeApprovalCallback(apprMatch[1], apprMatch[2], query, this.telegramApi);
      return;
    }
    const permMatch = data.match(/^perm_(allow|deny|continue)_([a-f0-9]+)$/);
    if (permMatch) {
      const [, decision, hexId] = permMatch;
      const hookDecision = decision === "continue" ? "deny" : decision;
      const responseFile = (0, import_path15.join)(this.paths.stateDir, `hook-response-${hexId}.json`);
      (0, import_fs15.writeFileSync)(responseFile, JSON.stringify({ decision: hookDecision }) + "\n", "utf-8");
      if (this.telegramApi) {
        try {
          await this.telegramApi.answerCallbackQuery(callbackQueryId, "Got it");
        } catch {
        }
        if (chatId && messageId) {
          const labelMap = { allow: "Approved", deny: "Denied", continue: "Continue in Chat" };
          try {
            await this.telegramApi.editMessageText(chatId, messageId, labelMap[decision] || decision);
          } catch {
          }
        }
      }
      this.log(`Permission callback: ${decision} for ${hexId}`);
      return;
    }
    const restartMatch = data.match(/^restart_(allow|deny)_([a-f0-9]+)$/);
    if (restartMatch) {
      const [, decision, hexId] = restartMatch;
      const responseFile = (0, import_path15.join)(this.paths.stateDir, `restart-response-${hexId}.json`);
      (0, import_fs15.writeFileSync)(responseFile, JSON.stringify({ decision }) + "\n", "utf-8");
      if (this.telegramApi) {
        try {
          await this.telegramApi.answerCallbackQuery(callbackQueryId, "Got it");
        } catch {
        }
        if (chatId && messageId) {
          const label = decision === "allow" ? "Restart Approved" : "Restart Denied";
          try {
            await this.telegramApi.editMessageText(chatId, messageId, label);
          } catch {
          }
        }
      }
      this.log(`Restart callback: ${decision} for ${hexId}`);
      return;
    }
    const askoptMatch = data.match(/^askopt_(\d+)_(\d+)$/);
    if (askoptMatch) {
      const qIdx = parseInt(askoptMatch[1], 10);
      const oIdx = parseInt(askoptMatch[2], 10);
      if (this.telegramApi) {
        try {
          await this.telegramApi.answerCallbackQuery(callbackQueryId, "Got it");
        } catch {
        }
        if (chatId && messageId) {
          try {
            await this.telegramApi.editMessageText(chatId, messageId, "Answered");
          } catch {
          }
        }
      }
      for (let k = 0; k < oIdx; k++) {
        this.agent.write(KEYS.DOWN);
        await sleep4(50);
      }
      await sleep4(100);
      this.agent.write(KEYS.ENTER);
      this.log(`AskUserQuestion: Q${qIdx} selected option ${oIdx}`);
      const askStatePath = (0, import_path15.join)(this.paths.stateDir, "ask-state.json");
      if ((0, import_fs15.existsSync)(askStatePath)) {
        try {
          const state = JSON.parse((0, import_fs15.readFileSync)(askStatePath, "utf-8"));
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            (0, import_fs15.writeFileSync)(askStatePath, JSON.stringify(state) + "\n", "utf-8");
            await sleep4(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep4(500);
            this.agent.write(KEYS.ENTER);
            this.log("AskUserQuestion: submitted all answers");
            try {
              (0, import_fs15.unlinkSync)(askStatePath);
            } catch {
            }
          }
        } catch {
        }
      }
      return;
    }
    const toggleMatch = data.match(/^asktoggle_(\d+)_(\d+)$/);
    if (toggleMatch) {
      const qIdx = parseInt(toggleMatch[1], 10);
      const oIdx = parseInt(toggleMatch[2], 10);
      if (this.telegramApi) {
        try {
          await this.telegramApi.answerCallbackQuery(callbackQueryId, "Toggled");
        } catch {
        }
      }
      const askStatePath = (0, import_path15.join)(this.paths.stateDir, "ask-state.json");
      if ((0, import_fs15.existsSync)(askStatePath)) {
        try {
          const state = JSON.parse((0, import_fs15.readFileSync)(askStatePath, "utf-8"));
          if (!state.multi_select_chosen) state.multi_select_chosen = [];
          const idx = state.multi_select_chosen.indexOf(oIdx);
          if (idx === -1) {
            state.multi_select_chosen.push(oIdx);
          } else {
            state.multi_select_chosen.splice(idx, 1);
          }
          (0, import_fs15.writeFileSync)(askStatePath, JSON.stringify(state) + "\n", "utf-8");
          if (this.telegramApi && chatId && messageId) {
            const chosen = [...state.multi_select_chosen].sort((a, b) => a - b);
            const chosenDisplay = chosen.map((i) => i + 1).join(", ");
            const question = state.questions?.[qIdx];
            const options = question?.options || [];
            const keyboard = options.map((opt, i) => [{
              text: opt || `Option ${i + 1}`,
              callback_data: `asktoggle_${qIdx}_${i}`
            }]);
            keyboard.push([{ text: "Submit Selections", callback_data: `asksubmit_${qIdx}` }]);
            const text = chosenDisplay ? `Selected: ${chosenDisplay}
Tap more options or Submit` : "Tap options to toggle, then tap Submit";
            try {
              await this.telegramApi.editMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
            } catch {
            }
          }
        } catch {
        }
      }
      this.log(`AskUserQuestion: Q${qIdx} toggled option ${oIdx}`);
      return;
    }
    const submitMatch = data.match(/^asksubmit_(\d+)$/);
    if (submitMatch) {
      const qIdx = parseInt(submitMatch[1], 10);
      if (this.telegramApi) {
        try {
          await this.telegramApi.answerCallbackQuery(callbackQueryId, "Submitted");
        } catch {
        }
        if (chatId && messageId) {
          try {
            await this.telegramApi.editMessageText(chatId, messageId, "Submitted");
          } catch {
          }
        }
      }
      const askStatePath = (0, import_path15.join)(this.paths.stateDir, "ask-state.json");
      if ((0, import_fs15.existsSync)(askStatePath)) {
        try {
          const state = JSON.parse((0, import_fs15.readFileSync)(askStatePath, "utf-8"));
          const chosenIndices = [...state.multi_select_chosen || []].sort((a, b) => a - b);
          const question = state.questions?.[qIdx];
          const totalOpts = question?.options?.length || 4;
          let currentPos = 0;
          for (const idx of chosenIndices) {
            const moves = idx - currentPos;
            for (let k = 0; k < moves; k++) {
              this.agent.write(KEYS.DOWN);
              await sleep4(50);
            }
            this.agent.write(KEYS.SPACE);
            await sleep4(50);
            currentPos = idx;
          }
          const submitPos = totalOpts + 1;
          const remaining = submitPos - currentPos;
          for (let k = 0; k < remaining; k++) {
            this.agent.write(KEYS.DOWN);
            await sleep4(50);
          }
          await sleep4(100);
          this.agent.write(KEYS.ENTER);
          this.log(`AskUserQuestion: Q${qIdx} submitted multi-select`);
          state.multi_select_chosen = [];
          (0, import_fs15.writeFileSync)(askStatePath, JSON.stringify(state) + "\n", "utf-8");
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            (0, import_fs15.writeFileSync)(askStatePath, JSON.stringify(state) + "\n", "utf-8");
            await sleep4(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep4(500);
            this.agent.write(KEYS.ENTER);
            this.log("AskUserQuestion: submitted all answers");
            try {
              (0, import_fs15.unlinkSync)(askStatePath);
            } catch {
            }
          }
        } catch {
        }
      }
      return;
    }
    this.log(`Unhandled callback data: ${data}`);
  }
  /**
   * Send the next AskUserQuestion to Telegram.
   * Reads ask-state.json and builds the question message and inline keyboard.
   */
  async sendNextQuestion(questionIdx) {
    if (!this.telegramApi || !this.chatId) {
      this.log("sendNextQuestion: no Telegram API or chatId configured");
      return;
    }
    const askStatePath = (0, import_path15.join)(this.paths.stateDir, "ask-state.json");
    if (!(0, import_fs15.existsSync)(askStatePath)) {
      this.log("sendNextQuestion: state file not found");
      return;
    }
    try {
      const state = JSON.parse((0, import_fs15.readFileSync)(askStatePath, "utf-8"));
      const totalQ = state.total_questions || 1;
      const question = state.questions?.[questionIdx];
      if (!question) {
        this.log(`sendNextQuestion: question ${questionIdx} not found`);
        return;
      }
      const qText = question.question || "Question";
      const qHeader = question.header || "";
      const qMulti = question.multiSelect === true;
      const qOptions = question.options || [];
      let msg = `QUESTION (${questionIdx + 1}/${totalQ}) - ${this.agent.name}:`;
      if (qHeader) msg += `
${qHeader}`;
      msg += `
${qText}
`;
      if (qMulti) {
        msg += "\n(Multi-select: tap options to toggle, then tap Submit)";
      }
      for (let i = 0; i < qOptions.length; i++) {
        msg += `
${i + 1}. ${qOptions[i] || `Option ${i + 1}`}`;
      }
      let keyboard;
      if (qMulti) {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `asktoggle_${questionIdx}_${i}`
        }]);
        keyboard.push([{ text: "Submit Selections", callback_data: `asksubmit_${questionIdx}` }]);
      } else {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `askopt_${questionIdx}_${i}`
        }]);
      }
      await this.telegramApi.sendMessage(this.chatId, msg, { inline_keyboard: keyboard });
      this.log(`Sent question ${questionIdx + 1}/${totalQ} to Telegram`);
    } catch (err) {
      this.log(`sendNextQuestion error: ${err}`);
    }
  }
  /**
   * Sleep that can be interrupted by SIGUSR1.
   */
  sleepInterruptible(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  /**
   * Check for .urgent-signal file and process it.
   */
  checkUrgentSignal() {
    const urgentPath = (0, import_path15.join)(this.paths.stateDir, ".urgent-signal");
    if ((0, import_fs15.existsSync)(urgentPath)) {
      try {
        const content = (0, import_fs15.readFileSync)(urgentPath, "utf-8").trim();
        this.log(`Urgent signal detected: ${content}`);
        (0, import_fs15.unlinkSync)(urgentPath);
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===
\`\`\`
${content}
\`\`\`

`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }
  /**
   * Read ctx thresholds from config.json with mtime-based caching (BUG-048 pattern).
   * Re-reads from disk only when the file has changed so dashboard updates take effect
   * within one poll cycle without a daemon restart.
   */
  getCtxThresholds() {
    try {
      const configPath = (0, import_path15.join)(this.agent.getAgentDir(), "config.json");
      const mtime = (0, import_fs15.statSync)(configPath).mtimeMs;
      if (mtime !== this.ctxConfigMtime) {
        const cfg = JSON.parse((0, import_fs15.readFileSync)(configPath, "utf-8"));
        const config2 = this.agent.getConfig();
        config2.ctx_warning_threshold = cfg.ctx_warning_threshold;
        config2.ctx_handoff_threshold = cfg.ctx_handoff_threshold;
        this.ctxConfigMtime = mtime;
      }
    } catch {
    }
    const config = this.agent.getConfig();
    return {
      warn: config.ctx_warning_threshold ?? 70,
      handoff: config.ctx_handoff_threshold ?? 80
    };
  }
  /**
   * Context monitor — called on every poll cycle.
   * Reads context_status.json written by the statusLine bridge hook and takes
   * action when thresholds are crossed.
   */
  async checkContextStatus() {
    const now = Date.now();
    if (this.ctxCircuitBrokenAt !== null) {
      if (now - this.ctxCircuitBrokenAt >= 30 * 6e4) {
        this.ctxCircuitBrokenAt = null;
        this.ctxCircuitRestarts = [];
        this.saveCtxCircuit();
        this.log("Context circuit breaker reset after 30min pause");
      } else {
        return;
      }
    }
    const statusPath = (0, import_path15.join)(this.paths.stateDir, "context_status.json");
    if (!(0, import_fs15.existsSync)(statusPath)) return;
    let pct = null;
    let exceeds200k = false;
    try {
      const raw = (0, import_fs15.readFileSync)(statusPath, "utf-8");
      const data = JSON.parse(raw);
      const age = now - new Date(data.written_at || 0).getTime();
      if (age > 10 * 6e4) return;
      pct = typeof data.used_percentage === "number" ? data.used_percentage : null;
      exceeds200k = Boolean(data.exceeds_200k_tokens);
      const incomingSessionId = typeof data.session_id === "string" ? data.session_id : null;
      if (incomingSessionId && incomingSessionId !== this.ctxLastSessionId) {
        if (this.ctxLastSessionId !== null) {
          this.ctxHandoffFiredAt = 0;
          this.ctxHandoffDeadlineAt = 0;
          this.ctxWarningFiredAt = 0;
          this.log(`New session detected (${incomingSessionId.slice(0, 8)}\u2026) \u2014 per-session ctx state reset`);
        }
        this.ctxLastSessionId = incomingSessionId;
      }
    } catch {
      return;
    }
    const recentOutput = this.agent.getOutputBuffer()?.getRecent(8e3) ?? "";
    if (/extra usage.*?1[Mm] context|conversation too long.*?compaction/i.test(recentOutput)) {
      this.log("Context overflow error detected in PTY output \u2014 force restarting");
      this.forceContextRestart("API overflow error in PTY output");
      return;
    }
    const { warn, handoff } = this.getCtxThresholds();
    if (this.agent.getConfig().ctx_handoff_threshold === void 0) return;
    const effectivePct = pct ?? (exceeds200k ? 101 : null);
    if (effectivePct === null) return;
    if (this.ctxHandoffDeadlineAt > 0 && now > this.ctxHandoffDeadlineAt) {
      this.log(`Handoff deadline exceeded (${Math.round(effectivePct)}%) \u2014 force restarting`);
      this.ctxHandoffDeadlineAt = 0;
      this.forceContextRestart(`ctx ${Math.round(effectivePct)}% \u2014 handoff not completed within 5min`);
      return;
    }
    if (effectivePct >= warn && now - this.ctxWarningFiredAt > 15 * 6e4) {
      this.ctxWarningFiredAt = now;
      const pctRound = Math.round(effectivePct);
      const statusSuffix = effectivePct >= handoff ? "Handoff in progress." : `Handoff triggers at ${handoff}%.`;
      this.agent.injectMessage(`[CONTEXT] Window at ${pctRound}%. ${statusSuffix}`);
      this.log(`Context warning fired at ${pctRound}%`);
    }
    if (effectivePct >= handoff && this.ctxHandoffFiredAt === 0) {
      this.ctxHandoffFiredAt = now;
      this.ctxHandoffDeadlineAt = now + 5 * 6e4;
      const statusPath2 = (0, import_path15.join)(this.paths.stateDir, "context_status.json");
      try {
        (0, import_fs15.writeFileSync)(statusPath2, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: (/* @__PURE__ */ new Date()).toISOString() }));
      } catch {
      }
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
      const handoffPrompt = `[CONTEXT HANDOFF REQUIRED] Context is at ${Math.round(effectivePct)}%. Write a handoff document to memory/handoffs/handoff-${ts}.md with these sections: ## Current Tasks, ## Next Actions, ## Active Crons, ## Key Context, ## Files Modified This Session. Then run: cortextos bus hard-restart --reason "context handoff at ${Math.round(effectivePct)}%" --handoff-doc <absolute path to the handoff doc you just wrote>. Do this NOW before the context window is exhausted.`;
      this.agent.injectMessage(handoffPrompt);
      this.log(`Handoff prompt injected at ${Math.round(effectivePct)}%`);
      try {
        (0, import_fs15.writeFileSync)((0, import_path15.join)(this.paths.stateDir, ".force-fresh"), "");
      } catch {
      }
    }
  }
  /**
   * Force a fresh hard restart for context exhaustion reasons.
   * Writes .force-fresh + .restart-planned, then triggers sessionRefresh().
   * The circuit breaker prevents runaway restart loops.
   */
  forceContextRestart(reason) {
    const now = Date.now();
    this.ctxCircuitRestarts = this.ctxCircuitRestarts.filter((t) => now - t < 15 * 6e4);
    if (this.ctxCircuitRestarts.length >= 3) {
      this.ctxCircuitBrokenAt = now;
      this.saveCtxCircuit();
      const msg = `Context circuit breaker TRIPPED for ${this.agent.name}: 3 restarts in 15min. Watchdog paused 30min. Check logs/${this.agent.name}/restarts.log for details.`;
      this.log(msg);
      if (this.telegramApi && this.chatId) {
        this.telegramApi.sendMessage(this.chatId, msg).catch(() => {
        });
      }
      return;
    }
    this.ctxCircuitRestarts.push(now);
    this.saveCtxCircuit();
    try {
      const handoffsDir = (0, import_path15.join)(this.agent.getAgentDir(), "memory", "handoffs");
      if ((0, import_fs15.existsSync)(handoffsDir)) {
        const cutoff = now - 15 * 6e4;
        const recent = (0, import_fs15.readdirSync)(handoffsDir).filter((f) => f.startsWith("handoff-") && f.endsWith(".md")).map((f) => ({ f, mtime: (0, import_fs15.statSync)((0, import_path15.join)(handoffsDir, f)).mtimeMs })).filter(({ mtime }) => mtime >= cutoff).sort((a, b) => b.mtime - a.mtime);
        if (recent.length > 0) {
          const docPath = (0, import_path15.join)(handoffsDir, recent[0].f);
          const markerPath = (0, import_path15.join)(this.paths.stateDir, ".handoff-doc-path");
          (0, import_fs15.writeFileSync)(markerPath, docPath, "utf-8");
          this.log(`Tier 3 restart: found recent handoff doc, writing marker \u2192 ${docPath}`);
        }
      }
    } catch {
    }
    this.ctxHandoffFiredAt = 0;
    this.ctxHandoffDeadlineAt = 0;
    this.ctxWarningFiredAt = 0;
    hardRestart(this.paths, this.agent.name, `CONTEXT-FORCE-RESTART: ${reason}`);
    const statusPath = (0, import_path15.join)(this.paths.stateDir, "context_status.json");
    try {
      (0, import_fs15.writeFileSync)(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: (/* @__PURE__ */ new Date()).toISOString() }));
    } catch {
    }
    this.agent.sessionRefresh().catch((err) => this.log(`Context restart failed: ${err}`));
  }
  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  hashMessage(text) {
    return (0, import_crypto5.createHash)("sha256").update(text).digest("hex");
  }
  /**
   * Check if message has been seen (dedup). Returns true if duplicate.
   */
  isDuplicate(text) {
    const hash = this.hashMessage(text);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    this.saveDedupHashes();
    return false;
  }
  /**
   * Load dedup hashes from persistent file.
   */
  loadDedupHashes() {
    try {
      if ((0, import_fs15.existsSync)(this.dedupFilePath)) {
        const content = (0, import_fs15.readFileSync)(this.dedupFilePath, "utf-8");
        const hashes = content.trim().split("\n").filter(Boolean);
        const recent = hashes.slice(-1e3);
        this.seenHashes = new Set(recent);
      }
    } catch {
      this.seenHashes = /* @__PURE__ */ new Set();
    }
  }
  /**
   * Save dedup hashes to persistent file.
   */
  saveDedupHashes() {
    try {
      const hashes = Array.from(this.seenHashes).slice(-1e3);
      (0, import_fs15.writeFileSync)(this.dedupFilePath, hashes.join("\n") + "\n", "utf-8");
    } catch {
    }
  }
  /**
   * Load circuit breaker state from disk.
   * Persisting this across --continue restarts is critical: without it,
   * the in-memory ctxCircuitRestarts array resets on every restart, making
   * the circuit breaker unable to count restarts and stop a restart loop.
   */
  loadCtxCircuit() {
    try {
      if (!(0, import_fs15.existsSync)(this.ctxCircuitFile)) return;
      const data = JSON.parse((0, import_fs15.readFileSync)(this.ctxCircuitFile, "utf-8"));
      this.ctxCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
      this.ctxCircuitBrokenAt = typeof data.brokenAt === "number" ? data.brokenAt : null;
    } catch {
    }
  }
  /**
   * Persist circuit breaker state to disk after every update.
   */
  saveCtxCircuit() {
    try {
      (0, import_fs15.writeFileSync)(this.ctxCircuitFile, JSON.stringify({
        restarts: this.ctxCircuitRestarts,
        brokenAt: this.ctxCircuitBrokenAt
      }), "utf-8");
    } catch {
    }
  }
  /**
   * Check if the agent is actively working on a response (typing indicator).
   *
   * Hook-based approach:
   *   - fast-checker records when it injected a message (lastMessageInjectedAt)
   *   - Stop hook writes a Unix timestamp to state/<agent>/last_idle.flag
   *   - Typing = message was injected AND last_idle.flag is older than injection
   *     AND injection was within the last 10 minutes
   *
   * This is accurate: typing starts when user sends a message, clears the
   * moment Claude finishes its turn (Stop fires). No false positives from TUI.
   */
  isAgentActive() {
    if (this.lastMessageInjectedAt === 0) return false;
    const now = Date.now();
    const tenMinMs = 10 * 60 * 1e3;
    if (now - this.lastMessageInjectedAt > tenMinMs) return false;
    const outboundPath = (0, import_path15.join)(this.paths.logDir, "outbound-messages.jsonl");
    try {
      if ((0, import_fs15.existsSync)(outboundPath)) {
        const { size } = require("fs").statSync(outboundPath);
        if (this.outboundLogSize === 0) {
          this.outboundLogSize = size;
        } else if (size > this.outboundLogSize) {
          this.outboundLogSize = size;
          this.lastMessageInjectedAt = 0;
          return false;
        }
      }
    } catch {
    }
    const flagPath = (0, import_path15.join)(this.paths.stateDir, "last_idle.flag");
    try {
      if (!(0, import_fs15.existsSync)(flagPath)) {
        return true;
      }
      const idleTs = parseInt((0, import_fs15.readFileSync)(flagPath, "utf-8").trim(), 10) * 1e3;
      return this.lastMessageInjectedAt > idleTs;
    } catch {
      return true;
    }
  }
};
function sleep4(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/telegram/poller.ts
var import_fs16 = require("fs");
var import_path16 = require("path");
var TelegramPoller = class {
  api;
  offset = 0;
  running = false;
  stateDir;
  offsetFileName;
  messageHandlers = [];
  callbackHandlers = [];
  reactionHandlers = [];
  pollInterval;
  /**
   * @param api Telegram API client scoped to a single bot token.
   * @param stateDir Directory for persisted poller state (offset, dedup).
   * @param pollInterval Milliseconds between getUpdates calls.
   * @param offsetFileSuffix Optional distinct suffix for the offset file.
   *   When omitted (default), offset persists to `.telegram-offset`. When
   *   provided, offset persists to `.telegram-offset-<suffix>`. Use this
   *   when running a second poller in the same stateDir against a
   *   different bot token (e.g. an activity-channel bot alongside the
   *   agent's own bot), so the two pollers do not clobber each other's
   *   offsets. Without this, two pollers sharing a stateDir would both
   *   write to `.telegram-offset` and lose track of which bot each
   *   offset belonged to.
   */
  constructor(api, stateDir, pollInterval = 1e3, offsetFileSuffix) {
    this.api = api;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.offsetFileName = offsetFileSuffix ? `.telegram-offset-${offsetFileSuffix}` : ".telegram-offset";
    this.loadOffset();
  }
  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }
  /**
   * Register a handler for callback queries.
   */
  onCallback(handler) {
    this.callbackHandlers.push(handler);
  }
  /**
   * Register a handler for message_reaction updates. These fire when a
   * user adds or removes an emoji reaction on a chat message the bot can
   * see. Requires the bot's getUpdates call to include `message_reaction`
   * in allowed_updates (handled by TelegramAPI.getUpdates).
   */
  onReaction(handler) {
    this.reactionHandlers.push(handler);
  }
  /**
   * Start the polling loop.
   */
  async start() {
    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error("[telegram-poller] Poll error:", err);
      }
      await sleep5(this.pollInterval);
    }
  }
  /**
   * Stop the polling loop.
   */
  stop() {
    this.running = false;
  }
  /**
   * Perform a single poll cycle.
   *
   * Offset-after-handler semantics: the offset only advances after every
   * registered handler for an update returns successfully. If any handler
   * throws, the update is left un-acknowledged (Telegram will re-deliver it
   * on the next `getUpdates` call) and the remainder of the batch is deferred
   * to preserve ordering. The offset is persisted after each successful
   * update so a crash mid-batch does not drop confirmed state.
   */
  async pollOnce() {
    const result = await this.api.getUpdates(this.offset, 1);
    if (!result?.result?.length) return;
    for (const update of result.result) {
      const nextOffset = update.update_id + 1;
      let handlerFailed = false;
      if (update.message) {
        for (const handler of this.messageHandlers) {
          try {
            handler(update.message);
          } catch (err) {
            console.error("[telegram-poller] Message handler error:", err);
            handlerFailed = true;
            break;
          }
        }
      }
      if (!handlerFailed && update.callback_query) {
        for (const handler of this.callbackHandlers) {
          try {
            handler(update.callback_query);
          } catch (err) {
            console.error("[telegram-poller] Callback handler error:", err);
            handlerFailed = true;
            break;
          }
        }
      }
      if (!handlerFailed && update.message_reaction) {
        for (const handler of this.reactionHandlers) {
          try {
            handler(update.message_reaction);
          } catch (err) {
            console.error("[telegram-poller] Reaction handler error:", err);
            handlerFailed = true;
            break;
          }
        }
      }
      if (handlerFailed) {
        return;
      }
      this.offset = nextOffset;
      this.saveOffset();
    }
  }
  /**
   * Load persisted offset from state file.
   */
  loadOffset() {
    const offsetFile = (0, import_path16.join)(this.stateDir, this.offsetFileName);
    try {
      if ((0, import_fs16.existsSync)(offsetFile)) {
        const content = (0, import_fs16.readFileSync)(offsetFile, "utf-8").trim();
        const parsed = parseInt(content, 10);
        if (!isNaN(parsed)) {
          this.offset = parsed;
        }
      }
    } catch {
    }
  }
  /**
   * Save current offset to state file.
   */
  saveOffset() {
    ensureDir(this.stateDir);
    const offsetFile = (0, import_path16.join)(this.stateDir, this.offsetFileName);
    try {
      (0, import_fs16.writeFileSync)(offsetFile, String(this.offset), "utf-8");
    } catch {
    }
  }
};
function sleep5(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/telegram/logging.ts
var import_fs17 = require("fs");
var import_path17 = require("path");
function logInboundMessage(ctxRoot, agentName, rawMessage) {
  const logDir = (0, import_path17.join)(ctxRoot, "logs", agentName);
  (0, import_fs17.mkdirSync)(logDir, { recursive: true });
  const entry = JSON.stringify({
    ...rawMessage,
    archived_at: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    agent: agentName
  });
  (0, import_fs17.appendFileSync)((0, import_path17.join)(logDir, "inbound-messages.jsonl"), entry + "\n", "utf-8");
}
function buildRecentHistory(ctxRoot, agentName, chatId, limit = 6) {
  const logDir = (0, import_path17.join)(ctxRoot, "logs", agentName);
  const inboundPath = (0, import_path17.join)(logDir, "inbound-messages.jsonl");
  const outboundPath = (0, import_path17.join)(logDir, "outbound-messages.jsonl");
  const chatIdStr = String(chatId);
  const entries = [];
  const readLines = (filePath, speaker) => {
    if (!(0, import_fs17.existsSync)(filePath)) return;
    try {
      const raw = (0, import_fs17.readFileSync)(filePath, "utf-8").trim();
      if (!raw) return;
      const lines = raw.split("\n").filter(Boolean);
      const tail = lines.slice(-(limit * 2));
      for (const line of tail) {
        try {
          const obj = JSON.parse(line);
          if (String(obj.chat_id) !== chatIdStr) continue;
          const text = (obj.text || "").trim();
          if (!text) continue;
          entries.push({ ts: obj.timestamp || obj.archived_at || "", speaker, text });
        } catch {
        }
      }
    } catch {
    }
  };
  readLines(inboundPath, process.env.ADMIN_USERNAME ?? "user");
  readLines(outboundPath, agentName);
  if (entries.length === 0) return null;
  entries.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  const recent = entries.slice(-limit);
  const formatted = recent.map((e) => {
    const preview = e.text.length > 200 ? e.text.slice(0, 200) + "..." : e.text;
    return "[" + e.speaker + "]: " + preview;
  });
  return formatted.join("\n");
}

// src/bus/metrics.ts
var import_fs18 = require("fs");
var import_path18 = require("path");
function collectTelegramCommands(scanDirs) {
  const seen = /* @__PURE__ */ new Set();
  const commands = [];
  for (const dir of scanDirs) {
    if (!(0, import_fs18.existsSync)(dir)) continue;
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
  const cmdDir = (0, import_path18.join)(dir, ".claude", "commands");
  if ((0, import_fs18.existsSync)(cmdDir)) {
    try {
      for (const f of (0, import_fs18.readdirSync)(cmdDir)) {
        if (f.endsWith(".md")) files.push((0, import_path18.join)(cmdDir, f));
      }
    } catch {
    }
  }
  const claudeSkillsDir = (0, import_path18.join)(dir, ".claude", "skills");
  if ((0, import_fs18.existsSync)(claudeSkillsDir)) {
    try {
      for (const entry of (0, import_fs18.readdirSync)(claudeSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = (0, import_path18.join)(claudeSkillsDir, entry.name, "SKILL.md");
          if ((0, import_fs18.existsSync)(skillFile)) files.push(skillFile);
        }
      }
    } catch {
    }
  }
  const skillsDir = (0, import_path18.join)(dir, "skills");
  if ((0, import_fs18.existsSync)(skillsDir)) {
    try {
      for (const entry of (0, import_fs18.readdirSync)(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = (0, import_path18.join)(skillsDir, entry.name, "SKILL.md");
          if ((0, import_fs18.existsSync)(skillFile)) files.push(skillFile);
        }
      }
    } catch {
    }
  }
  return files;
}
function parseSkillFrontmatter(filePath) {
  try {
    const content = (0, import_fs18.readFileSync)(filePath, "utf-8");
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
  const base = (0, import_path18.basename)(filePath);
  if (base === "SKILL.md") {
    return (0, import_path18.basename)((0, import_path18.dirname)(filePath));
  }
  return base.replace(/\.md$/, "");
}
function sanitizeCommand(name) {
  return name.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 32);
}

// src/telegram/media.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
function sanitizeFilename(name) {
  if (!name) return "unnamed_file";
  let sanitized = path.basename(name);
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!sanitized) return "unnamed_file";
  return sanitized.slice(0, 200);
}
function formatDate(unixTs) {
  const d = new Date(unixTs * 1e3);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
async function processMediaMessage(msg, api, downloadDir) {
  const chatId = msg.chat.id;
  const from = msg.from?.first_name || "Unknown";
  const date = msg.date || Math.floor(Date.now() / 1e3);
  const caption = msg.caption || "";
  ensureDir(downloadDir);
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const fileResponse = await api.getFile(largest.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;
    const baseName = path.basename(filePath);
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, "");
    const suffix = nameWithoutExt.slice(-11);
    const dateStr = formatDate(date);
    const localFile = path.join(downloadDir, `${dateStr}_${suffix}.jpg`);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);
    return {
      type: "photo",
      chat_id: chatId,
      from,
      text: caption,
      date,
      image_path: localFile
    };
  }
  if (msg.document) {
    const fileName = sanitizeFilename(msg.document.file_name);
    const fileResponse = await api.getFile(msg.document.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;
    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);
    return {
      type: "document",
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName
    };
  }
  if (msg.audio) {
    const defaultName = `audio_${date}.ogg`;
    const fileName = msg.audio.file_name ? sanitizeFilename(msg.audio.file_name) : defaultName;
    const fileResponse = await api.getFile(msg.audio.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;
    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);
    return {
      type: "audio",
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName,
      duration: msg.audio.duration
    };
  }
  if (msg.voice) {
    const fileName = `voice_${date}.ogg`;
    const fileResponse = await api.getFile(msg.voice.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;
    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);
    return {
      type: "voice",
      chat_id: chatId,
      from,
      text: "",
      date,
      file_path: localFile,
      duration: msg.voice.duration
    };
  }
  if (msg.video) {
    const defaultName = `video_${date}.mp4`;
    const fileName = msg.video.file_name ? sanitizeFilename(msg.video.file_name) : defaultName;
    const fileResponse = await api.getFile(msg.video.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;
    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);
    return {
      type: "video",
      chat_id: chatId,
      from,
      text: caption,
      date,
      file_path: localFile,
      file_name: fileName,
      duration: msg.video.duration
    };
  }
  if (msg.video_note) {
    const fileName = `videonote_${date}.mp4`;
    const fileResponse = await api.getFile(msg.video_note.file_id);
    const filePath = fileResponse?.result?.file_path;
    if (!filePath) return null;
    const localFile = path.join(downloadDir, fileName);
    const data = await api.downloadFile(filePath);
    fs.writeFileSync(localFile, data);
    return {
      type: "video_note",
      chat_id: chatId,
      from,
      text: "",
      date,
      file_path: localFile,
      duration: msg.video_note.duration
    };
  }
  return null;
}

// src/daemon/agent-manager.ts
var AgentManager = class {
  agents = /* @__PURE__ */ new Map();
  workers = /* @__PURE__ */ new Map();
  // Tracks agents that received a start request while still stopping.
  // stopAgent() honors these after cleanup completes so restart-all is race-free.
  pendingRestarts = /* @__PURE__ */ new Set();
  instanceId;
  ctxRoot;
  frameworkRoot;
  org;
  constructor(instanceId, ctxRoot, frameworkRoot, org) {
    this.instanceId = instanceId;
    this.ctxRoot = ctxRoot;
    this.frameworkRoot = frameworkRoot;
    this.org = org;
  }
  /**
   * Discover and start all enabled agents.
   */
  async discoverAndStart() {
    const agentDirs = this.discoverAgents();
    const instanceEnabled = this.readInstanceEnableList();
    for (const { name, dir, org, config } of agentDirs) {
      if (config.enabled === false) {
        console.log(`[agent-manager] Skipping disabled agent: ${name} (per-agent config.json)`);
        continue;
      }
      const entry = instanceEnabled[name];
      if (entry && entry.enabled === false) {
        console.log(`[agent-manager] Skipping disabled agent: ${name} (enabled-agents.json)`);
        continue;
      }
      await this.startAgent(name, dir, config, org);
    }
  }
  /**
   * Read the instance-level enabled-agents.json registry.
   * Returns an empty object if the file is missing or unreadable —
   * agents not present in the file default to enabled, matching the existing
   * default-on behavior of `discoverAndStart`.
   */
  readInstanceEnableList() {
    const enabledFile = (0, import_path19.join)(this.ctxRoot, "config", "enabled-agents.json");
    if (!(0, import_fs19.existsSync)(enabledFile)) return {};
    try {
      return JSON.parse((0, import_fs19.readFileSync)(enabledFile, "utf-8"));
    } catch {
      return {};
    }
  }
  /**
   * BUG-043 fix: resolve the canonical org for a given agent without
   * defaulting to the daemon's startup `this.org`.
   *
   * Resolution order:
   *   1. Explicit `org` argument (e.g. from `discoverAgents()` which knows
   *      which org a dir lives under)
   *   2. `enabled-agents.json[name].org` — set by `cortextos enable`/`add-agent`
   *   3. Filesystem scan: walk `frameworkRoot/orgs/*` looking for a dir
   *      named `name` — handles legacy enabled-agents.json entries that
   *      were written before the `org` field was added
   *   4. Legacy fallback: `this.org` (preserves single-org install behavior)
   *
   * Before this fix, all six `this.org` sites in `agent-manager.ts` would
   * short-circuit to the daemon's startup `CTX_ORG`, which silently broke
   * multi-org installs — agents in `lifeos` or `cointally` were invisible
   * to a daemon started with `CTX_ORG=testorg`.
   */
  resolveAgentOrg(name, explicitOrg) {
    if (explicitOrg) return explicitOrg;
    const enabledAgents = this.readInstanceEnableList();
    const entry = enabledAgents[name];
    if (entry?.org) return entry.org;
    const orgsBase = (0, import_path19.join)(this.frameworkRoot, "orgs");
    if ((0, import_fs19.existsSync)(orgsBase)) {
      try {
        const orgs = (0, import_fs19.readdirSync)(orgsBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        for (const org of orgs) {
          if ((0, import_fs19.existsSync)((0, import_path19.join)(orgsBase, org, "agents", name))) {
            return org;
          }
        }
      } catch {
      }
    }
    return this.org;
  }
  /**
   * Start a specific agent.
   *
   * BUG-043 fix: accepts an optional `org` parameter and uses
   * `resolveAgentOrg()` to find the correct org for path/env lookups
   * instead of falling back to `this.org`. This makes the daemon
   * multi-org aware — an install with lifeos + cointally + testorg will
   * spawn each agent in its correct org dir regardless of what
   * `CTX_ORG` the daemon was started with.
   */
  async startAgent(name, agentDir, config, org) {
    if (this.agents.has(name)) {
      console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: ${name} still in registry during startAgent \u2014 pendingRestarts queueing engaged. This should not happen with PR #11 in place.`);
      this.pendingRestarts.add(name);
      return;
    }
    const resolvedOrg = this.resolveAgentOrg(name, org);
    if (!agentDir || !(0, import_fs19.existsSync)(agentDir)) {
      const discovered = (0, import_path19.join)(this.frameworkRoot, "orgs", resolvedOrg, "agents", name);
      if ((0, import_fs19.existsSync)(discovered)) {
        agentDir = discovered;
      } else {
        console.error(`[agent-manager] Agent directory not found for ${name}: tried ${discovered}`);
        return;
      }
    }
    if (!config) {
      config = this.loadAgentConfig(agentDir);
    }
    const env = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir,
      org: resolvedOrg,
      projectRoot: this.frameworkRoot
    };
    const paths = resolvePaths(name, this.instanceId, resolvedOrg);
    const log = (msg) => {
      console.log(`[${name}] ${msg}`);
    };
    const agentEnvFile = (0, import_path19.join)(agentDir, ".env");
    let telegramApi;
    let chatId;
    let allowedUserId;
    let botToken;
    if ((0, import_fs19.existsSync)(agentEnvFile)) {
      const envContent = (0, import_fs19.readFileSync)(agentEnvFile, "utf-8");
      const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
      const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
      const allowedUserMatch = envContent.match(/^ALLOWED_USER=(.+)$/m);
      botToken = botTokenMatch?.[1]?.trim();
      chatId = chatIdMatch?.[1]?.trim();
      allowedUserId = allowedUserMatch?.[1]?.trim() || void 0;
      if (botToken && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
        log(`WARNING: BOT_TOKEN format invalid (expected: 123456:ABC...). Telegram will not start.`);
        botToken = void 0;
      }
      if (allowedUserId && !/^\d+$/.test(allowedUserId)) {
        log(`SECURITY: ALLOWED_USER is not a numeric ID. Telegram user IDs are numbers (e.g. 123456789). Refusing to enable Telegram. Fix the .env file.`);
        allowedUserId = void 0;
      }
      if (botToken && !allowedUserId) {
        log(`SECURITY: BOT_TOKEN is set but ALLOWED_USER is missing. Refusing to enable Telegram. Set ALLOWED_USER to your numeric Telegram user ID in .env, or remove BOT_TOKEN to start the agent without Telegram.`);
        botToken = void 0;
      }
      if (botToken && chatId) {
        telegramApi = new TelegramAPI(botToken);
        log(`Telegram configured (chat_id: ****${String(chatId).slice(-4)}, allowed_user: enabled)`);
      }
    }
    const agentProcess = new AgentProcess(name, env, config, log);
    const checker = new FastChecker(agentProcess, paths, this.frameworkRoot, {
      log,
      telegramApi,
      chatId,
      allowedUserId: allowedUserId ? parseInt(allowedUserId, 10) : void 0
    });
    if (telegramApi && chatId) {
      const tgApi = telegramApi;
      const tgChatId = chatId;
      let prevStatus = null;
      agentProcess.onStatusChanged((status) => {
        if (status.status === "crashed") {
          const crashNum = status.crashCount ?? "?";
          tgApi.sendMessage(tgChatId, `Agent ${name} crashed (crash #${crashNum}) \u2014 auto-restarting`).catch(() => {
          });
        } else if (status.status === "halted") {
          tgApi.sendMessage(tgChatId, `Agent ${name} HALTED \u2014 exceeded crash limit. Restart manually with: cortextos start ${name}`).catch(() => {
          });
        } else if (status.status === "running" && prevStatus === "crashed") {
          tgApi.sendMessage(tgChatId, `Agent ${name} recovered and is back online`).catch(() => {
          });
        }
        prevStatus = status.status;
      });
    }
    this.agents.set(name, { process: agentProcess, checker });
    await agentProcess.start();
    agentProcess.scheduleCronVerification();
    agentProcess.scheduleGapDetection();
    checker.start().catch((err) => {
      console.error(`[${name}] Fast checker error:`, err);
    });
    if (telegramApi && botToken) {
      const scanDirs = [agentDir, this.frameworkRoot].filter(Boolean);
      const commands = collectTelegramCommands(scanDirs);
      registerTelegramCommands(botToken, commands).then((result) => {
        if (result.status === "ok") {
          log(`Telegram commands registered (${result.count} commands)`);
        }
      }).catch(() => {
      });
    }
    if (telegramApi && chatId) {
      const stateDir = (0, import_path19.join)(this.ctxRoot, "state", name);
      const poller = new TelegramPoller(telegramApi, stateDir);
      poller.onMessage((msg) => {
        if (allowedUserId) {
          const allowedId = parseInt(allowedUserId, 10);
          if (msg.from?.id !== allowedId) {
            log(`Ignoring message from unauthorized user (allowed_user gate)`);
            return;
          }
        }
        const from = stripControlChars(msg.from?.first_name || msg.from?.username || "Unknown");
        const msgChatId = msg.chat?.id;
        const effectiveChatId = msgChatId ?? chatId ?? "";
        const stateDir2 = (0, import_path19.join)(this.ctxRoot, "state", name);
        logInboundMessage(this.ctxRoot, name, {
          message_id: msg.message_id,
          from: msg.from?.id,
          from_name: from,
          chat_id: msgChatId,
          text: stripControlChars(msg.text || msg.caption || ""),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        const isMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
        if (isMedia && telegramApi) {
          const downloadDir = (0, import_path19.join)(agentDir, "telegram-images");
          processMediaMessage(msg, telegramApi, downloadDir).then((media) => {
            if (!media) {
              log("Media processing returned null - falling back to text format");
              const text2 = stripControlChars(msg.caption || "");
              const formatted3 = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text2, this.frameworkRoot);
              if (!checker.isDuplicate(formatted3)) checker.queueTelegramMessage(formatted3);
              return;
            }
            const launchDir = config?.working_directory || agentDir;
            const toRel = (p) => p ? (0, import_path19.relative)(launchDir, p) : "";
            const relImagePath = toRel(media.image_path);
            const relFilePath = toRel(media.file_path);
            log(`[DEBUG] media.type=${media.type} image_path=${JSON.stringify(relImagePath)} file_path=${JSON.stringify(relFilePath)}`);
            let formatted2;
            if (media.type === "photo") {
              formatted2 = FastChecker.formatTelegramPhotoMessage(from, effectiveChatId, media.text, relImagePath);
            } else if (media.type === "document") {
              formatted2 = FastChecker.formatTelegramDocumentMessage(from, effectiveChatId, media.text, relFilePath, media.file_name);
            } else if (media.type === "voice" || media.type === "audio") {
              formatted2 = FastChecker.formatTelegramVoiceMessage(from, effectiveChatId, relFilePath, media.duration);
            } else {
              formatted2 = FastChecker.formatTelegramVideoMessage(from, effectiveChatId, media.text, relFilePath, media.file_name || "", media.duration);
            }
            if (checker.isDuplicate(formatted2)) {
              log("Duplicate Telegram media message suppressed");
              return;
            }
            log(`Media message received: type=${media.type}, path=${media.image_path || media.file_path}`);
            checker.queueTelegramMessage(formatted2);
          }).catch((err) => {
            log(`Media processing error: ${err} - falling back to text format`);
            const text2 = stripControlChars(msg.caption || "");
            const formatted2 = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text2, this.frameworkRoot);
            if (!checker.isDuplicate(formatted2)) checker.queueTelegramMessage(formatted2);
          });
          return;
        }
        const text = stripControlChars(msg.text || "");
        const lastSent = FastChecker.readLastSent(stateDir2, effectiveChatId);
        const replyToText = buildReplyContext(msg.reply_to_message);
        const recentHistory = buildRecentHistory(this.ctxRoot, name, effectiveChatId, 6) ?? void 0;
        const formatted = FastChecker.formatTelegramTextMessage(
          from,
          effectiveChatId,
          text,
          this.frameworkRoot,
          replyToText,
          lastSent ?? void 0,
          recentHistory
        );
        if (checker.isDuplicate(formatted)) {
          log("Duplicate Telegram message suppressed");
          return;
        }
        checker.queueTelegramMessage(formatted);
      });
      poller.onCallback((query) => {
        checker.handleCallback(query).catch((err) => {
          log(`Callback handling error: ${err}`);
        });
      });
      poller.onReaction((reaction) => {
        if (allowedUserId) {
          const allowedId = parseInt(allowedUserId, 10);
          if (reaction.user?.id !== allowedId) {
            log("Ignoring reaction from unauthorized user (allowed_user gate)");
            return;
          }
        }
        const from = stripControlChars(reaction.user?.first_name || reaction.user?.username || "Unknown");
        const reactionChatId = reaction.chat?.id ?? chatId ?? "";
        const formatted = FastChecker.formatTelegramReaction(
          from,
          reactionChatId,
          reaction.message_id,
          reaction.old_reaction ?? [],
          reaction.new_reaction ?? []
        );
        if (checker.isDuplicate(formatted)) {
          log("Duplicate Telegram reaction suppressed");
          return;
        }
        checker.queueTelegramMessage(formatted);
      });
      poller.start().catch((err) => {
        log(`Telegram poller error: ${err}`);
      });
      const entry = this.agents.get(name);
      if (entry) entry.poller = poller;
      log("Telegram poller started");
      await this.maybeStartActivityChannelPoller(name, org, agentDir, log);
    }
  }
  /**
   * If this agent is the org's orchestrator AND the org has an
   * activity-channel.env configured, start a second TelegramPoller bound
   * to ACTIVITY_BOT_TOKEN. Callbacks route to fast-checker's
   * handleActivityCallback. Safe no-op in every other case — if the
   * context.json is missing/corrupt, the orchestrator field is empty,
   * this agent is not the orchestrator, or the activity-channel.env
   * is absent/unreadable/missing credentials, this method returns
   * without starting anything.
   */
  async maybeStartActivityChannelPoller(name, org, agentDir, log) {
    if (!org) return;
    const orgDir = (0, import_path19.join)(this.frameworkRoot, "orgs", org);
    let orchestratorName;
    try {
      const contextJson = (0, import_fs19.readFileSync)((0, import_path19.join)(orgDir, "context.json"), "utf-8");
      orchestratorName = JSON.parse(contextJson).orchestrator;
    } catch {
      return;
    }
    if (!orchestratorName || orchestratorName !== name) return;
    const activityEnvPath = (0, import_path19.join)(orgDir, "activity-channel.env");
    let activityBotToken;
    let activityChatId;
    try {
      const content = (0, import_fs19.readFileSync)(activityEnvPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key === "ACTIVITY_BOT_TOKEN") activityBotToken = value;
        if (key === "ACTIVITY_CHAT_ID") activityChatId = value;
      }
    } catch {
      return;
    }
    if (!activityBotToken || !activityChatId) {
      log("Activity-channel env present but missing BOT_TOKEN or CHAT_ID \u2014 skipping poller");
      return;
    }
    const activityApi = new TelegramAPI(activityBotToken);
    const stateDir = (0, import_path19.join)(this.ctxRoot, "state", name);
    const activityPoller = new TelegramPoller(activityApi, stateDir, 1e3, "activity");
    activityPoller.onCallback((query) => {
      const entry2 = this.agents.get(name);
      if (!entry2) return;
      entry2.checker.handleActivityCallback(query, activityApi).catch((err) => {
        log(`Activity-channel callback error: ${err}`);
      });
    });
    activityPoller.onMessage((msg) => {
      const from = stripControlChars(msg.from?.first_name || msg.from?.username || "Unknown");
      const text = stripControlChars(msg.text || msg.caption || "");
      log(`[activity-channel inbound] from ${from}: ${text.slice(0, 120)}`);
    });
    activityPoller.start().catch((err) => {
      log(`Activity-channel poller error: ${err}`);
    });
    const entry = this.agents.get(name);
    if (entry) entry.activityPoller = activityPoller;
    log(`Activity-channel poller started (chat ${activityChatId})`);
  }
  /**
   * Stop a specific agent.
   */
  async stopAgent(name) {
    const entry = this.agents.get(name);
    if (!entry) {
      console.log(`[agent-manager] Agent ${name} not found`);
      return;
    }
    if (entry.poller) entry.poller.stop();
    if (entry.activityPoller) entry.activityPoller.stop();
    entry.checker.stop();
    await entry.process.stop();
    this.agents.delete(name);
    if (this.pendingRestarts.has(name)) {
      console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: pendingRestarts fired for ${name} \u2014 race condition leaked through. Honoring queued restart as safety net.`);
      this.pendingRestarts.delete(name);
      console.log(`[agent-manager] Honoring queued restart for ${name}`);
      this.startAgent(name, "").catch(
        (err) => console.error(`[agent-manager] Queued restart failed for ${name}:`, err)
      );
    }
  }
  /**
   * Restart a specific agent.
   *
   * Delegates to stopAgent + startAgent to guarantee a full teardown and
   * rebuild of every per-agent resource: AgentProcess, FastChecker, TelegramAPI,
   * TelegramPoller, crash callback, and slash-command registration. Fresh
   * credentials are re-read from {agentDir}/.env on each restart.
   *
   * agentDir is auto-discovered by startAgent() from frameworkRoot/orgs/{org}/agents/{name}.
   * Participates in the pendingRestarts race protection used by restart-all.
   */
  async restartAgent(name) {
    if (!this.agents.has(name)) {
      console.log(`[agent-manager] Agent ${name} not found \u2014 cannot restart`);
      return;
    }
    console.log(`[agent-manager] Restarting ${name}`);
    await this.stopAgent(name);
    await this.startAgent(name, "");
    console.log(`[agent-manager] Restart complete for ${name}`);
  }
  /**
   * Stop all agents.
   *
   * BUG-034 partial fix: writes a `.daemon-stop` marker file in each agent's
   * state dir BEFORE stopping it. The SessionEnd crash-alert hook
   * (src/hooks/hook-crash-alert.ts) reads this marker and reports a clean
   * `🛑 daemon shutdown` notification instead of a false `🚨 CRASH` alarm.
   * Without this, every `pm2 restart cortextos-daemon` (or `pm2 stop`)
   * generates a false crash alarm per agent — trust-destroying.
   *
   * Pattern matches src/cli/bus.ts:1283-1289 and PR #12 (BUG-036). Markers
   * are written synchronously before the async stop loop starts, so by the
   * time `pty.kill()` runs, every agent already has its marker on disk.
   */
  async stopAll() {
    const names = [...this.agents.keys()];
    for (const name of names) {
      try {
        const stateDir = (0, import_path19.join)(this.ctxRoot, "state", name);
        (0, import_fs19.mkdirSync)(stateDir, { recursive: true });
        (0, import_fs19.writeFileSync)((0, import_path19.join)(stateDir, ".daemon-stop"), "daemon shutdown (SIGTERM)");
      } catch (err) {
        console.error(`[agent-manager] Failed to write .daemon-stop marker for ${name}: ${err}`);
      }
    }
    for (const name of names) {
      try {
        await this.stopAgent(name);
      } catch (err) {
        console.error(`[agent-manager] Error stopping ${name}:`, err);
      }
    }
  }
  /**
   * Get status of all agents.
   */
  getAllStatuses() {
    const statuses = [];
    for (const [, entry] of this.agents) {
      statuses.push(entry.process.getStatus());
    }
    return statuses;
  }
  /**
   * Get status of a specific agent.
   */
  getAgentStatus(name) {
    const entry = this.agents.get(name);
    return entry ? entry.process.getStatus() : null;
  }
  /**
   * Get the FastChecker for an agent (for Telegram message routing).
   */
  getFastChecker(name) {
    return this.agents.get(name)?.checker || null;
  }
  /**
   * Get all agent names.
   */
  getAgentNames() {
    return [...this.agents.keys()];
  }
  // --- Worker management ---
  /**
   * Spawn an ephemeral worker session for a parallelized task.
   */
  async spawnWorker(name, dir, prompt, parent, model) {
    if (this.workers.has(name)) {
      throw new Error(`Worker "${name}" is already running`);
    }
    if (this.agents.has(name)) {
      throw new Error(`"${name}" is already a registered agent name`);
    }
    const log = (msg) => console.log(`[worker:${name}] ${msg}`);
    const worker = new WorkerProcess(name, dir, parent, log);
    const env = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir: dir,
      org: this.org,
      projectRoot: this.frameworkRoot
    };
    const config = model ? { model } : {};
    this.workers.set(name, worker);
    worker.onDone((workerName) => {
      setTimeout(() => {
        if (this.workers.get(workerName)?.isFinished()) {
          this.workers.delete(workerName);
        }
      }, 3e4);
    });
    await worker.spawn({ ...env, ...model ? {} : {} }, prompt);
  }
  /**
   * Terminate a running worker session.
   */
  async terminateWorker(name) {
    const worker = this.workers.get(name);
    if (!worker) {
      throw new Error(`Worker "${name}" not found`);
    }
    await worker.terminate();
    this.workers.delete(name);
  }
  /**
   * Inject text into a running worker's PTY (nudge / stuck-state recovery).
   */
  injectWorker(name, text) {
    const worker = this.workers.get(name);
    if (!worker) return false;
    return worker.inject(text);
  }
  /**
   * Get status of all workers (running + recently completed).
   */
  listWorkers() {
    return [...this.workers.values()].map((w) => w.getStatus());
  }
  /**
   * Get status of a specific worker.
   */
  getWorkerStatus(name) {
    return this.workers.get(name)?.getStatus() ?? null;
  }
  /**
   * Discover agents from the organization directory structure.
   *
   * BUG-043 fix: iterate over EVERY org under `frameworkRoot/orgs/*`,
   * not just `this.org`. Before this fix, a daemon started with
   * `CTX_ORG=testorg` would only discover agents in `orgs/testorg/agents/`
   * — agents in `orgs/lifeos/agents/` and `orgs/cointally/agents/` were
   * effectively invisible to the daemon and could never be auto-spawned
   * from a cold start. Multi-org installs silently half-worked.
   *
   * The returned tuple now includes an `org` field so `discoverAndStart()`
   * can pass the correct org to `startAgent()` and downstream path
   * lookups via `resolveAgentOrg()`.
   */
  discoverAgents() {
    const agents = [];
    const orgsBase = (0, import_path19.join)(this.frameworkRoot, "orgs");
    if (!(0, import_fs19.existsSync)(orgsBase)) return agents;
    let orgNames = [];
    try {
      orgNames = (0, import_fs19.readdirSync)(orgsBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return agents;
    }
    for (const org of orgNames) {
      const agentsBase = (0, import_path19.join)(orgsBase, org, "agents");
      if (!(0, import_fs19.existsSync)(agentsBase)) continue;
      try {
        const dirs = (0, import_fs19.readdirSync)(agentsBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        for (const name of dirs) {
          const dir = (0, import_path19.join)(agentsBase, name);
          const config = this.loadAgentConfig(dir);
          agents.push({ name, dir, org, config });
        }
      } catch {
      }
    }
    return agents;
  }
  /**
   * Load agent config from config.json.
   */
  loadAgentConfig(agentDir) {
    const configPath = (0, import_path19.join)(agentDir, "config.json");
    try {
      if ((0, import_fs19.existsSync)(configPath)) {
        return JSON.parse((0, import_fs19.readFileSync)(configPath, "utf-8"));
      }
    } catch {
    }
    return {};
  }
};
function buildReplyContext(replyMsg) {
  if (!replyMsg) return void 0;
  if (replyMsg.text) return stripControlChars(replyMsg.text);
  if (replyMsg.caption) return stripControlChars(replyMsg.caption);
  if (replyMsg.video) return "[video]";
  if (replyMsg.video_note) return "[video note]";
  if (replyMsg.photo) return "[photo]";
  if (replyMsg.voice) return "[voice message]";
  if (replyMsg.audio) return "[audio]";
  if (replyMsg.document) return `[document: ${replyMsg.document.file_name ?? "file"}]`;
  return void 0;
}

// src/daemon/ipc-server.ts
var import_net = require("net");
var import_fs20 = require("fs");
var import_path20 = require("path");
var WORKER_NAME_REGEX = /^[a-z0-9_-]+$/;
var IPCServer = class {
  server = null;
  socketPath;
  agentManager;
  constructor(agentManager, instanceId = "default") {
    this.agentManager = agentManager;
    this.socketPath = getIpcPath(instanceId);
  }
  /**
   * Start listening for IPC connections.
   */
  async start() {
    if (process.platform !== "win32" && (0, import_fs20.existsSync)(this.socketPath)) {
      try {
        (0, import_fs20.unlinkSync)(this.socketPath);
      } catch {
      }
    }
    return new Promise((resolve, reject) => {
      this.server = (0, import_net.createServer)((socket) => {
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
          try {
            const request = JSON.parse(data);
            data = "";
            this.handleRequest(request, socket);
          } catch {
          }
        });
        socket.on("error", () => {
        });
      });
      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          try {
            (0, import_fs20.unlinkSync)(this.socketPath);
          } catch {
          }
          this.server.listen(this.socketPath, () => {
            console.log(`[ipc] Listening on ${this.socketPath} (recovered from stale socket)`);
            resolve();
          });
        } else {
          reject(err);
        }
      });
      this.server.listen(this.socketPath, () => {
        if (process.platform !== "win32") {
          try {
            (0, import_fs20.chmodSync)(this.socketPath, 384);
          } catch {
          }
        }
        console.log(`[ipc] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }
  /**
   * Stop the IPC server.
   */
  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (process.platform !== "win32" && (0, import_fs20.existsSync)(this.socketPath)) {
      try {
        (0, import_fs20.unlinkSync)(this.socketPath);
      } catch {
      }
    }
  }
  /**
   * Handle an incoming IPC request.
   */
  handleRequest(request, socket) {
    const agentTag = request.agent ? ` ${request.agent}` : "";
    console.log(`[ipc] ${request.type}${agentTag} from ${request.source || "unknown"}`);
    let response;
    try {
      switch (request.type) {
        case "status":
          response = {
            success: true,
            data: this.agentManager.getAllStatuses()
          };
          break;
        case "list-agents":
          response = {
            success: true,
            data: this.agentManager.getAgentNames()
          };
          break;
        case "start-agent":
          if (!request.agent) {
            response = { success: false, error: "Agent name required" };
          } else {
            this.agentManager.startAgent(
              request.agent,
              request.data?.dir || ""
            ).catch((err) => console.error(`Failed to start ${request.agent}:`, err));
            response = { success: true, data: `Starting ${request.agent}` };
          }
          break;
        case "stop-agent":
          if (!request.agent) {
            response = { success: false, error: "Agent name required" };
          } else {
            this.agentManager.stopAgent(request.agent).catch((err) => console.error(`Failed to stop ${request.agent}:`, err));
            response = { success: true, data: `Stopping ${request.agent}` };
          }
          break;
        case "restart-agent":
          if (!request.agent) {
            response = { success: false, error: "Agent name required" };
          } else {
            this.agentManager.restartAgent(request.agent).catch((err) => console.error(`Failed to restart ${request.agent}:`, err));
            response = { success: true, data: `Restarting ${request.agent}` };
          }
          break;
        case "wake":
          if (request.agent) {
            const checker = this.agentManager.getFastChecker(request.agent);
            if (checker) {
              checker.wake();
              response = { success: true, data: "Woke fast checker" };
            } else {
              response = { success: false, error: `Agent ${request.agent} not found` };
            }
          } else {
            response = { success: false, error: "Agent name required" };
          }
          break;
        case "spawn-worker": {
          const d = request.data;
          if (!d?.name || !d?.dir || !d?.prompt) {
            response = { success: false, error: "spawn-worker requires: name, dir, prompt" };
          } else if (!WORKER_NAME_REGEX.test(d.name) || d.name.length > 64) {
            response = { success: false, error: "Invalid worker name" };
          } else {
            const resolvedDir = (0, import_path20.resolve)(d.dir);
            const ctxRoot = process.env.CTX_ROOT ? (0, import_path20.resolve)(process.env.CTX_ROOT) : "";
            const cwd = (0, import_path20.resolve)(process.cwd());
            const underCtxRoot = ctxRoot && (resolvedDir === ctxRoot || resolvedDir.startsWith(ctxRoot + "/"));
            const underCwd = resolvedDir === cwd || resolvedDir.startsWith(cwd + "/");
            if (!underCtxRoot && !underCwd) {
              response = { success: false, error: "Invalid worker dir" };
            } else {
              this.agentManager.spawnWorker(d.name, resolvedDir, d.prompt, d.parent, d.model).catch((err) => console.error(`[ipc] spawn-worker failed:`, err));
              response = { success: true, data: `Spawning worker ${d.name}` };
            }
          }
          break;
        }
        case "terminate-worker": {
          const workerName = request.data?.name;
          if (!workerName) {
            response = { success: false, error: "terminate-worker requires: name" };
          } else {
            this.agentManager.terminateWorker(workerName).catch((err) => console.error(`[ipc] terminate-worker failed:`, err));
            response = { success: true, data: `Terminating worker ${workerName}` };
          }
          break;
        }
        case "list-workers":
          response = { success: true, data: this.agentManager.listWorkers() };
          break;
        case "inject-worker": {
          const injectName = request.data?.name;
          const injectText = request.data?.text;
          if (!injectName || !injectText) {
            response = { success: false, error: "inject-worker requires: name, text" };
          } else {
            const ok = this.agentManager.injectWorker(injectName, injectText);
            response = ok ? { success: true, data: `Injected into worker ${injectName}` } : { success: false, error: `Worker ${injectName} not found or not running` };
          }
          break;
        }
        default:
          response = { success: false, error: `Unknown command: ${request.type}` };
      }
    } catch (err) {
      response = { success: false, error: String(err) };
    }
    try {
      socket.write(JSON.stringify(response));
      socket.end();
    } catch {
    }
  }
};

// src/daemon/index.ts
var import_fs21 = require("fs");
var import_child_process2 = require("child_process");
var import_path21 = require("path");
var import_os5 = require("os");
var CRASH_HISTORY_MAX = 20;
var CRASH_LOOP_WINDOW_MS = 15 * 60 * 1e3;
var CRASH_LOOP_THRESHOLD = 3;
var CRASH_LOOP_COOLDOWN_MS = 30 * 60 * 1e3;
var TELEGRAM_SEND_TIMEOUT_MS = 3e3;
function crashHistoryPath(ctxRoot) {
  return (0, import_path21.join)(ctxRoot, "state", ".daemon-crash-history.json");
}
function readCrashHistory(ctxRoot) {
  const p = crashHistoryPath(ctxRoot);
  if (!(0, import_fs21.existsSync)(p)) return { crashes: [] };
  try {
    const parsed = JSON.parse((0, import_fs21.readFileSync)(p, "utf-8"));
    return { crashes: parsed.crashes ?? [], lastAlertAt: parsed.lastAlertAt };
  } catch {
    return { crashes: [] };
  }
}
function writeCrashHistory(ctxRoot, history) {
  try {
    ensureDir((0, import_path21.join)(ctxRoot, "state"));
    (0, import_fs21.writeFileSync)(crashHistoryPath(ctxRoot), JSON.stringify(history, null, 2), "utf-8");
  } catch {
    console.error("[daemon] Failed to persist crash history (non-fatal)");
  }
}
function recordCrash(ctxRoot, errStr) {
  const history = readCrashHistory(ctxRoot);
  history.crashes.push({ ts: (/* @__PURE__ */ new Date()).toISOString(), err: errStr.slice(0, 2e3) });
  if (history.crashes.length > CRASH_HISTORY_MAX) {
    history.crashes = history.crashes.slice(-CRASH_HISTORY_MAX);
  }
  writeCrashHistory(ctxRoot, history);
  return history;
}
function shouldSendCrashLoopAlert(history) {
  const now = Date.now();
  const windowStart = now - CRASH_LOOP_WINDOW_MS;
  const recent = history.crashes.filter((c) => Date.parse(c.ts) >= windowStart).length;
  if (recent < CRASH_LOOP_THRESHOLD) return false;
  if (history.lastAlertAt) {
    const cooldownEnd = Date.parse(history.lastAlertAt) + CRASH_LOOP_COOLDOWN_MS;
    if (now < cooldownEnd) return false;
  }
  return true;
}
function countRecentCrashes(history) {
  const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
  return history.crashes.filter((c) => Date.parse(c.ts) >= windowStart).length;
}
function writeDaemonCrashedMarkers(ctxRoot) {
  const stateDir = (0, import_path21.join)(ctxRoot, "state");
  if (!(0, import_fs21.existsSync)(stateDir)) return;
  let names;
  try {
    names = (0, import_fs21.readdirSync)(stateDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return;
  }
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  for (const name of names) {
    try {
      (0, import_fs21.writeFileSync)((0, import_path21.join)(stateDir, name, ".daemon-crashed"), ts, "utf-8");
    } catch {
    }
  }
}
function getOperatorChatCreds(frameworkRoot) {
  const envChat = process.env.CTX_OPERATOR_CHAT_ID;
  const envToken = process.env.CTX_OPERATOR_BOT_TOKEN;
  if (envChat && envToken && /^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
    return { chatId: envChat, botToken: envToken };
  }
  try {
    const orgsRoot = (0, import_path21.join)(frameworkRoot, "orgs");
    if (!(0, import_fs21.existsSync)(orgsRoot)) return null;
    const orgs = (0, import_fs21.readdirSync)(orgsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = (0, import_path21.join)(orgsRoot, org.name, "agents");
      if (!(0, import_fs21.existsSync)(agentsRoot)) continue;
      const agents = (0, import_fs21.readdirSync)(agentsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const a of agents) {
        const envFile = (0, import_path21.join)(agentsRoot, a.name, ".env");
        if (!(0, import_fs21.existsSync)(envFile)) continue;
        try {
          const content = (0, import_fs21.readFileSync)(envFile, "utf-8");
          const tokenMatch = content.match(/^BOT_TOKEN=(.+)$/m);
          const chatMatch = content.match(/^CHAT_ID=(.+)$/m);
          if (!tokenMatch || !chatMatch) continue;
          const botToken = tokenMatch[1].trim();
          const chatId = envChat || chatMatch[1].trim();
          if (/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
            return { chatId, botToken };
          }
        } catch {
        }
      }
    }
  } catch {
  }
  return null;
}
function sendCrashLoopAlertBestEffort(frameworkRoot, crashCount, errStr) {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error("[daemon] Crash-loop alert: no operator chat configured (set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)");
    return false;
  }
  const message = `\u{1F6A8} CRITICAL: cortextos daemon is crash-looping
${crashCount} crashes in 15 minutes
Last error: ${errStr.slice(0, 500)}
Next alert in 30 min if the pattern continues.`;
  try {
    const r = (0, import_child_process2.spawnSync)("curl", [
      "-s",
      "--max-time",
      "3",
      "-X",
      "POST",
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      "-d",
      `chat_id=${creds.chatId}`,
      "--data-urlencode",
      `text=${message}`
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: "pipe" });
    if (r.status === 0) {
      console.error("[daemon] Crash-loop alert sent to operator chat");
      return true;
    }
    console.error("[daemon] Crash-loop alert send failed (non-fatal)");
    return false;
  } catch {
    return false;
  }
}
function handleFatal(tag, err, ctxRoot, frameworkRoot, doExit) {
  const errStr = err instanceof Error ? err.stack || err.message : String(err);
  console.error(`[daemon] FATAL ${tag} \u2014 exiting for PM2 respawn`);
  console.error(errStr);
  writeDaemonCrashedMarkers(ctxRoot);
  const history = recordCrash(ctxRoot, errStr);
  if (shouldSendCrashLoopAlert(history)) {
    const recent = countRecentCrashes(history);
    if (sendCrashLoopAlertBestEffort(frameworkRoot, recent, errStr)) {
      history.lastAlertAt = (/* @__PURE__ */ new Date()).toISOString();
      writeCrashHistory(ctxRoot, history);
    }
  }
  if (doExit) process.exit(1);
}
var Daemon = class {
  agentManager = null;
  ipcServer = null;
  instanceId;
  ctxRoot;
  constructor() {
    this.instanceId = process.env.CTX_INSTANCE_ID || "default";
    this.ctxRoot = (0, import_path21.join)((0, import_os5.homedir)(), ".cortextos", this.instanceId);
  }
  async start() {
    if (process.platform !== "win32") {
      process.umask(63);
    }
    console.log(`[daemon] Starting cortextOS daemon (instance: ${this.instanceId})`);
    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || "";
    const org = process.env.CTX_ORG || "";
    if (!frameworkRoot) {
      console.error("[daemon] CTX_FRAMEWORK_ROOT not set");
      process.exit(1);
    }
    const pidFile = (0, import_path21.join)(this.ctxRoot, "daemon.pid");
    ensureDir(this.ctxRoot);
    (0, import_fs21.writeFileSync)(pidFile, String(process.pid), "utf-8");
    if (process.platform !== "win32") {
      try {
        (0, import_fs21.chmodSync)(pidFile, 384);
      } catch {
      }
    }
    this.agentManager = new AgentManager(this.instanceId, this.ctxRoot, frameworkRoot, org);
    this.ipcServer = new IPCServer(this.agentManager, this.instanceId);
    await this.ipcServer.start();
    await this.agentManager.discoverAndStart();
    console.log(`[daemon] Running (pid: ${process.pid})`);
    const shutdown = async () => {
      console.log("[daemon] Shutting down...");
      try {
        if (this.agentManager) {
          await this.agentManager.stopAll();
        }
      } catch (err) {
        console.error("[daemon] Error during shutdown:", err);
      }
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      try {
        const { unlinkSync: unlinkSync3 } = require("fs");
        unlinkSync3(pidFile);
      } catch {
      }
      process.exit(0);
    };
    let shuttingDown = false;
    const handleSignal = () => {
      if (shuttingDown) {
        console.log("[daemon] Shutdown already in progress, ignoring signal");
        return;
      }
      shuttingDown = true;
      shutdown().catch((err) => {
        console.error("[daemon] Fatal shutdown error:", err);
        process.exit(1);
      });
    };
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
    const ctxRootForHandler = this.ctxRoot;
    const frameworkRootForHandler = frameworkRoot;
    process.on("uncaughtException", (err) => {
      handleFatal("uncaughtException", err, ctxRootForHandler, frameworkRootForHandler, true);
    });
    process.on("unhandledRejection", (reason) => {
      handleFatal("unhandledRejection", reason, ctxRootForHandler, frameworkRootForHandler, false);
    });
    console.log("[daemon] Fatal-error handlers registered (uncaughtException + unhandledRejection)");
    if (process.env.CTX_DEBUG_ALLOW_CRASH_TRIGGER === "1") {
      process.on("SIGUSR2", () => {
        console.error("[daemon] SIGUSR2 received \u2014 inducing test crash (CTX_DEBUG_ALLOW_CRASH_TRIGGER=1)");
        throw new Error("Simulated daemon crash via SIGUSR2 (test harness)");
      });
      console.log("[daemon] SIGUSR2 crash trigger ENABLED (debug mode)");
    }
    process.on("exit", () => {
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      try {
        const { unlinkSync: unlinkSync3 } = require("fs");
        unlinkSync3(pidFile);
      } catch {
      }
    });
  }
};
if (require.main === module) {
  const daemon = new Daemon();
  daemon.start().catch((err) => {
    console.error("[daemon] Fatal error:", err);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CRASH_HISTORY_MAX,
  CRASH_LOOP_COOLDOWN_MS,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  countRecentCrashes,
  crashHistoryPath,
  readCrashHistory,
  recordCrash,
  shouldSendCrashLoopAlert,
  writeCrashHistory,
  writeDaemonCrashedMarkers
});
//# sourceMappingURL=daemon.js.map