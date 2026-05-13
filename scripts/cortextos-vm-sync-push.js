#!/usr/bin/env node
/**
 * cortextos-vm-sync-push.js
 *
 * Runs every 5 min (cron). Reads local cortextOS state and pushes it to
 * the RGOS cortextos-vm-sync edge function so the AgentOps dashboard has
 * live numbers.
 *
 * Data sources:
 *   ~/.cortextos/<instance>/state/<agent>/heartbeat.json  — agent status
 *   ~/.cortextos/<instance>/tasks/task_*.json             — task transitions
 *   ~/.cortextos/<instance>/analytics/events/<subdir>/YYYY-MM-DD.jsonl — activity events
 *   ~/.cortextos/<instance>/logs/<agent>/crashes.log      — crash events
 *
 * Watermark file: ~/.cortextos/<instance>/state/vm-sync-watermark.json
 * Records last_synced ISO timestamp; only transitions/events AFTER that time
 * are sent to avoid duplicate inserts.
 *
 * Auth: X-Internal-Secret header (INTERNAL_CRON_SECRET from secrets.env)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ────────────────────────────────────────────────────────────────────

const INSTANCE_ID = process.env.CTX_INSTANCE_ID || "default";
const CTX_ROOT = path.join(os.homedir(), ".cortextos", INSTANCE_ID);
const STATE_DIR = path.join(CTX_ROOT, "state");
const TASKS_DIR = path.join(CTX_ROOT, "tasks");
const EVENTS_DIR = path.join(CTX_ROOT, "analytics", "events");
const LOGS_DIR = path.join(CTX_ROOT, "logs");
const WATERMARK_FILE = path.join(STATE_DIR, "vm-sync-watermark.json");

// Load secrets from org secrets.env
const SECRETS_ENV = path.join(
  os.homedir(),
  "cortextos",
  "orgs",
  "revops-global",
  "secrets.env",
);

function loadSecrets() {
  const secrets = {};
  // First apply process.env
  Object.assign(secrets, process.env);
  // Then overlay secrets.env
  if (fs.existsSync(SECRETS_ENV)) {
    const lines = fs.readFileSync(SECRETS_ENV, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      secrets[key] = val;
    }
  }
  return secrets;
}

const secrets = loadSecrets();
const SUPABASE_URL = secrets.SUPABASE_RGOS_URL || secrets.SUPABASE_URL;
const INTERNAL_SECRET = secrets.INTERNAL_CRON_SECRET;

if (!SUPABASE_URL || !INTERNAL_SECRET) {
  console.error(
    "[vm-sync-push] Missing SUPABASE_RGOS_URL or INTERNAL_CRON_SECRET — aborting",
  );
  process.exit(1);
}

const EDGE_URL = `${SUPABASE_URL}/functions/v1/cortextos-vm-sync`;

// ── Watermark ─────────────────────────────────────────────────────────────────

function loadWatermark() {
  try {
    if (fs.existsSync(WATERMARK_FILE)) {
      return JSON.parse(fs.readFileSync(WATERMARK_FILE, "utf8"));
    }
  } catch (_) {}
  // Default: 1 hour ago so first run doesn't flood with old data
  return { last_synced: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
}

function saveWatermark(ts) {
  fs.writeFileSync(WATERMARK_FILE, JSON.stringify({ last_synced: ts }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function readJsonlFile(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Token / cost collection ───────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const MODEL_PRICING = {
  opus:   { inputPerM: 15,  outputPerM: 75,  cacheWritePerM: 3.75, cacheReadPerM: 1.50 },
  sonnet: { inputPerM: 3,   outputPerM: 15,  cacheWritePerM: 3.75, cacheReadPerM: 0.30 },
  haiku:  { inputPerM: 0.8, outputPerM: 4,   cacheWritePerM: 1.00, cacheReadPerM: 0.08 },
};

function resolvePricingKey(model) {
  const lower = (model || "").toLowerCase();
  if (lower.includes("opus"))  return "opus";
  if (lower.includes("haiku")) return "haiku";
  return "sonnet";
}

function calcCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens) {
  const p = MODEL_PRICING[resolvePricingKey(model)] || MODEL_PRICING.sonnet;
  return Math.round((
    (inputTokens      / 1e6) * p.inputPerM +
    (outputTokens     / 1e6) * p.outputPerM +
    (cacheWriteTokens / 1e6) * p.cacheWritePerM +
    (cacheReadTokens  / 1e6) * p.cacheReadPerM
  ) * 1e6) / 1e6;
}

/**
 * Scan ~/.claude/projects/ for JSONL files belonging to an agent directory
 * (dirs ending in "agents-<agentName>") and aggregate today's token usage.
 * Returns { date, input_tokens, output_tokens, cache_creation_tokens, cost_usd }
 * or null if no data found.
 */
function readDailyTokensForAgent(agentName) {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;

  const today = todayDateStr();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let found = false;

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch (_) {
    return null;
  }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    // Match dirs like "-home-...-agents-dev" or "-home-...-agents-orchestrator"
    if (!dir.name.endsWith(`-agents-${agentName}`) && !dir.name.endsWith(`-agents-${agentName}-`)) continue;

    const projectPath = path.join(CLAUDE_PROJECTS_DIR, dir.name);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    } catch (_) {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(projectPath, file);
      const lines = readJsonlFile(filePath);

      for (const entry of lines) {
        const ts = entry.timestamp;
        if (!ts || !ts.startsWith(today)) continue;

        const msg = entry.message || entry;
        const model = msg.model;
        if (!model) continue;

        const usage = msg.usage || {};
        const inp  = usage.input_tokens ?? msg.input_tokens ?? 0;
        const out  = usage.output_tokens ?? msg.output_tokens ?? 0;
        const cw   = usage.cache_creation_input_tokens ?? 0;
        const cr   = usage.cache_read_input_tokens ?? 0;
        if (inp === 0 && out === 0 && cw === 0 && cr === 0) continue;

        inputTokens      += inp;
        outputTokens     += out;
        cacheWriteTokens += cw;
        cacheReadTokens  += cr;
        costUsd          += msg.costUSD ?? calcCost(model, inp, out, cw, cr);
        found = true;
      }
    }
  }

  if (!found) return null;
  return {
    date: today,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheWriteTokens,
    cost_usd: Math.round(costUsd * 1e6) / 1e6,
  };
}

// ── Data collection ───────────────────────────────────────────────────────────

/** List all agent names from state dir (skip non-agent entries) */
function listAgentNames() {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs
    .readdirSync(STATE_DIR)
    .filter((name) => {
      const p = path.join(STATE_DIR, name);
      if (!fs.statSync(p).isDirectory()) return false;
      // Skip known non-agent dirs
      if (["vm-sync-watermark.json", "audit"].includes(name)) return false;
      // Must have heartbeat.json to be a real agent
      return fs.existsSync(path.join(p, "heartbeat.json"));
    });
}

/** Read heartbeat for an agent */
function readHeartbeat(agentName) {
  const hb = safeReadJson(
    path.join(STATE_DIR, agentName, "heartbeat.json"),
  );
  if (!hb) return null;
  return {
    status: hb.status || "unknown",
    last_seen: hb.last_heartbeat || hb.updated_at || null,
  };
}

/** Read all tasks and find transitions since watermark */
function readTaskTransitions(sinceTsStr) {
  // Group transitions by agent
  const byAgent = {};
  if (!fs.existsSync(TASKS_DIR)) return byAgent;

  const sinceTs = new Date(sinceTsStr).getTime();
  const files = fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"));

  for (const file of files) {
    const task = safeReadJson(path.join(TASKS_DIR, file));
    if (!task) continue;

    const updatedAt = task.updated_at || task.created_at;
    if (!updatedAt) continue;

    const updatedTs = new Date(updatedAt).getTime();
    if (updatedTs <= sinceTs) continue;

    const agent = task.assigned_to || "unknown";
    if (!byAgent[agent]) byAgent[agent] = [];

    byAgent[agent].push({
      task_id: task.id,
      from_status: null, // cortextOS tasks don't store previous status
      to_status: task.status || "unknown",
      at: updatedAt,
      note: task.title ? task.title.slice(0, 120) : null,
    });
  }

  return byAgent;
}

/** Count tasks completed/failed today per agent */
function readTaskCountsToday() {
  const byAgent = {};
  if (!fs.existsSync(TASKS_DIR)) return byAgent;

  const today = todayDateStr();
  const files = fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"));

  for (const file of files) {
    const task = safeReadJson(path.join(TASKS_DIR, file));
    if (!task) continue;

    const completedAt = task.completed_at || task.updated_at || "";
    if (!completedAt.startsWith(today)) continue;

    const agent = task.assigned_to || "unknown";
    if (!byAgent[agent]) byAgent[agent] = { completed: 0, failed: 0 };

    if (task.status === "completed") byAgent[agent].completed++;
    else if (task.status === "failed" || task.status === "cancelled")
      byAgent[agent].failed++;
  }

  return byAgent;
}

/** Read activity events since watermark from event JSONL files */
function readEventsSince(sinceTsStr) {
  const sinceTs = new Date(sinceTsStr).getTime();
  const byAgent = {};

  const eventSubdirs = fs.existsSync(EVENTS_DIR)
    ? fs.readdirSync(EVENTS_DIR).filter((d) => {
        return fs.statSync(path.join(EVENTS_DIR, d)).isDirectory();
      })
    : [];

  const dates = [yesterdayDateStr(), todayDateStr()];

  for (const subdir of eventSubdirs) {
    for (const date of dates) {
      const file = path.join(EVENTS_DIR, subdir, `${date}.jsonl`);
      const lines = readJsonlFile(file);

      for (const evt of lines) {
        const ts = evt.timestamp || evt.at || evt.created_at;
        if (!ts) continue;
        if (new Date(ts).getTime() <= sinceTs) continue;

        // Filter to non-heartbeat events — heartbeats are handled via heartbeat.json
        const category = evt.category || "";
        const event = evt.event || "";
        if (category === "heartbeat" && event === "heartbeat") continue;

        const agentName = evt.agent || "unknown";
        if (!byAgent[agentName]) byAgent[agentName] = [];

        byAgent[agentName].push({
          type: event || category || "event",
          at: ts,
          reason: evt.metadata?.reason || evt.metadata?.status || evt.metadata?.task || null,
          level: evt.severity || "info",
        });
      }
    }
  }

  return byAgent;
}

/** Read crash logs for all agents since watermark */
function readCrashEventsSince(sinceTsStr) {
  const sinceTs = new Date(sinceTsStr).getTime();
  const byAgent = {};

  if (!fs.existsSync(LOGS_DIR)) return byAgent;

  const agentDirs = fs.readdirSync(LOGS_DIR).filter((d) => {
    return fs.statSync(path.join(LOGS_DIR, d)).isDirectory();
  });

  for (const agentName of agentDirs) {
    const crashFile = path.join(LOGS_DIR, agentName, "crashes.log");
    if (!fs.existsSync(crashFile)) continue;

    const lines = fs.readFileSync(crashFile, "utf8").split("\n").filter(Boolean);

    for (const line of lines) {
      // Format: 2026-04-14T19:41:42.588Z type=planned-restart reason=...
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+Z)/);
      if (!tsMatch) continue;

      const ts = tsMatch[1];
      if (new Date(ts).getTime() <= sinceTs) continue;

      const typeMatch = line.match(/type=([^\s]+)/);
      const reasonMatch = line.match(/reason=(.+?)(?:\s+last_task=|$)/);

      if (!byAgent[agentName]) byAgent[agentName] = [];
      byAgent[agentName].push({
        type: typeMatch ? typeMatch[1] : "crash",
        at: ts,
        reason: reasonMatch ? reasonMatch[1].trim() : null,
        level: "error",
      });
    }
  }

  return byAgent;
}

// ── Build payload ─────────────────────────────────────────────────────────────

function buildPayload(watermark) {
  const sinceTs = watermark.last_synced;

  const agentNames = listAgentNames();
  const taskTransitions = readTaskTransitions(sinceTs);
  const taskCounts = readTaskCountsToday();
  const activityEvents = readEventsSince(sinceTs);
  const crashEvents = readCrashEventsSince(sinceTs);

  // Collect all unique agent names that have any data
  const allAgents = new Set([
    ...agentNames,
    ...Object.keys(taskTransitions),
    ...Object.keys(activityEvents),
    ...Object.keys(crashEvents),
  ]);

  const agents = [];

  for (const agentName of allAgents) {
    const hb = agentNames.includes(agentName) ? readHeartbeat(agentName) : null;

    // Merge activity + crash events
    const events = [
      ...(activityEvents[agentName] || []),
      ...(crashEvents[agentName] || []),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    const transitions = taskTransitions[agentName] || [];
    const counts = taskCounts[agentName] || { completed: 0, failed: 0 };

    const daily = readDailyTokensForAgent(agentName);

    const agentPayload = { name: agentName };

    if (hb) agentPayload.heartbeat = hb;
    if (daily) agentPayload.daily = daily;
    if (events.length > 0) agentPayload.events = events;
    if (transitions.length > 0) agentPayload.task_transitions = transitions;
    if (counts.completed > 0) agentPayload.tasks_completed_today = counts.completed;
    if (counts.failed > 0) agentPayload.tasks_failed_today = counts.failed;

    agents.push(agentPayload);
  }

  return {
    generated_at: new Date().toISOString(),
    agents,
  };
}

// ── Rotation events (direct REST write) ───────────────────────────────────────

/**
 * Read planned-restart / context-rotation entries from crash logs since watermark
 * and write them to orch_rotation_events directly via Supabase REST.
 * The cortextos-vm-sync edge function doesn't handle this table.
 */
async function syncRotationEvents(sinceTsStr) {
  const sinceTs = new Date(sinceTsStr).getTime();
  if (!fs.existsSync(LOGS_DIR)) return;

  const supabaseUrl = SUPABASE_URL;
  const serviceKey = secrets.SUPABASE_RGOS_SERVICE_KEY;
  if (!serviceKey) return;

  const agentDirs = fs.readdirSync(LOGS_DIR).filter((d) => {
    return fs.statSync(path.join(LOGS_DIR, d)).isDirectory();
  });

  const rows = [];

  for (const agentName of agentDirs) {
    const crashFile = path.join(LOGS_DIR, agentName, "crashes.log");
    if (!fs.existsSync(crashFile)) continue;

    const lines = fs.readFileSync(crashFile, "utf8").split("\n").filter(Boolean);

    for (const line of lines) {
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+Z)/);
      if (!tsMatch) continue;

      const rotationAt = tsMatch[1];
      if (new Date(rotationAt).getTime() <= sinceTs) continue;

      const typeMatch = line.match(/type=([^\s]+)/);
      const reasonMatch = line.match(/reason=(.+?)(?:\s+last_task=|$)/);
      const taskMatch = line.match(/last_task=(.+?)$/);

      const eventType = typeMatch ? typeMatch[1] : "crash";
      const isUnplannedCrash = eventType === "crash";

      rows.push({
        agent_id: agentName,
        checkpoint_id: null,
        checkpoint_size: null,
        rotation_at: rotationAt,
        resume_at: null,
        resume_success: isUnplannedCrash ? false : null,
        task_id: null,
        notes: [
          `type=${eventType}`,
          reasonMatch ? `reason=${reasonMatch[1].trim()}` : null,
          taskMatch ? `last_task=${taskMatch[1].trim().slice(0, 100)}` : null,
        ].filter(Boolean).join(" | "),
      });
    }
  }

  if (rows.length === 0) return;

  // Deduplicate by checkpoint_id via upsert
  const res = await fetch(`${supabaseUrl}/rest/v1/orch_rotation_events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const text = await res.text();
    console.warn(`[vm-sync-push] rotation events write failed ${res.status}: ${text.slice(0, 200)}`);
  } else {
    console.log(`[vm-sync-push] Wrote ${rows.length} rotation events`);
  }
}

// ── HTTP push ─────────────────────────────────────────────────────────────────

async function push(payload) {
  const res = await fetch(EDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": INTERNAL_SECRET,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Edge function error ${res.status}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }
  return data;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const watermark = loadWatermark();
  console.log(`[vm-sync-push] Syncing since ${watermark.last_synced}`);

  const payload = buildPayload(watermark);
  const agentCount = payload.agents.length;
  const eventCount = payload.agents.reduce((s, a) => s + (a.events?.length || 0), 0);
  const transitionCount = payload.agents.reduce(
    (s, a) => s + (a.task_transitions?.length || 0),
    0,
  );

  const totalCostUsd = payload.agents.reduce((s, a) => s + (a.daily?.cost_usd || 0), 0);
  const agentsWithTokens = payload.agents.filter((a) => a.daily).length;

  console.log(
    `[vm-sync-push] Payload: ${agentCount} agents, ${eventCount} events, ${transitionCount} transitions, ` +
    `${agentsWithTokens} with tokens ($${totalCostUsd.toFixed(4)} today)`,
  );

  if (agentCount === 0) {
    console.log("[vm-sync-push] Nothing to sync — skipping push");
    saveWatermark(payload.generated_at);
    return;
  }

  try {
    const result = await push(payload);
    console.log("[vm-sync-push] Success:", JSON.stringify(result).slice(0, 500));

    // Write rotation events directly to orch_rotation_events
    await syncRotationEvents(watermark.last_synced);

    saveWatermark(payload.generated_at);
  } catch (err) {
    console.error("[vm-sync-push] Push failed:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[vm-sync-push] Fatal:", err);
  process.exit(1);
});
