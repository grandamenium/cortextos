#!/usr/bin/env node
/**
 * cortextos-budget-check.js
 *
 * Runs hourly (cron). Reads monthly Anthropic API spend from Claude JSONL files
 * per agent, compares against per-agent budgets in orgs/<org>/budgets.json,
 * and sends threshold alerts to the orchestrator (for Telegram relay).
 *
 * Thresholds: 50% / 75% / 90% → soft alert via orchestrator
 *             100% → critical alert (+ hard-pause marker if hard_pause_enabled=true in budgets.json)
 *
 * First-boot safety: on the first run for a given month (no watermark), the
 * watermark is seeded with current percentages and a summary is written to
 * state/budget-summary-<YYYY-MM>.json. This prevents an alert storm from
 * pre-existing overruns on deploy. Only NEW threshold crossings after deploy
 * trigger alerts.
 *
 * Watermark: ~/.cortextos/<instance>/state/budget-alert-watermark.json
 * { "YYYY-MM": { "agent": last_notified_threshold_pct } }
 *
 * Hard-pause marker: ~/.cortextos/<instance>/state/<agent>/budget-paused
 * Only written if hard_pause_enabled=true in budgets.json AND threshold crosses
 * 100% in a non-first-boot run.
 */

"use strict";

const fs             = require("fs");
const path           = require("path");
const os             = require("os");
const { execFileSync } = require("child_process");

// ── Config ────────────────────────────────────────────────────────────────────

const INSTANCE_ID   = process.env.CTX_INSTANCE_ID || "default";
const CTX_ROOT      = path.join(os.homedir(), ".cortextos", INSTANCE_ID);
const STATE_DIR     = path.join(CTX_ROOT, "state");
const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
const FRAMEWORK_ROOT  = path.join(os.homedir(), "cortextos");
const ORG             = process.env.CTX_ORG || "revops-global";
const BUDGETS_FILE    = path.join(FRAMEWORK_ROOT, "orgs", ORG, "budgets.json");
const WATERMARK_FILE  = path.join(STATE_DIR, "budget-alert-watermark.json");

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[budget-check] ${msg}`); }

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function safeWriteJson(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); } catch (_) {}
}

function monthStr() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

function monthPrefix() {
  return monthStr() + "-"; // "YYYY-MM-" for timestamp filtering
}

const MODEL_PRICING = {
  opus:   { inputPerM: 15,  outputPerM: 75,  cacheWritePerM: 3.75, cacheReadPerM: 1.50 },
  sonnet: { inputPerM: 3,   outputPerM: 15,  cacheWritePerM: 3.75, cacheReadPerM: 0.30 },
  haiku:  { inputPerM: 0.8, outputPerM: 4,   cacheWritePerM: 1.00, cacheReadPerM: 0.08 },
};

function pricingKey(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("opus"))  return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

function calcCost(model, inp, out, cw, cr) {
  const p = MODEL_PRICING[pricingKey(model)] || MODEL_PRICING.sonnet;
  return (inp / 1e6) * p.inputPerM +
         (out / 1e6) * p.outputPerM +
         (cw  / 1e6) * p.cacheWritePerM +
         (cr  / 1e6) * p.cacheReadPerM;
}

/**
 * Aggregate Anthropic API cost for an agent for the current calendar month.
 * JSONL files are UUID-named; entries are filtered by timestamp prefix.
 */
function readMonthlySpend(agentName) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return 0;

  const prefix = monthPrefix();
  let totalCost = 0;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch (_) { return 0; }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    if (!dir.name.endsWith(`-agents-${agentName}`) &&
        !dir.name.endsWith(`-agents-${agentName}-`)) continue;

    const projectPath = path.join(CLAUDE_PROJECTS, dir.name);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    } catch (_) { continue; }

    for (const file of files) {
      let lines;
      try {
        lines = fs.readFileSync(path.join(projectPath, file), "utf8")
          .split("\n").filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      } catch (_) { continue; }

      for (const entry of lines) {
        const ts = entry.timestamp || entry.created_at || "";
        if (ts && !ts.startsWith(prefix)) continue;
        const msg   = entry.message || entry;
        const model = msg.model;
        if (!model) continue;
        const usage = msg.usage || {};
        const inp   = usage.input_tokens ?? msg.input_tokens ?? 0;
        const out   = usage.output_tokens ?? msg.output_tokens ?? 0;
        const cw    = usage.cache_creation_input_tokens ?? 0;
        const cr    = usage.cache_read_input_tokens ?? 0;
        if (inp === 0 && out === 0 && cw === 0 && cr === 0) continue;
        totalCost += msg.costUSD ?? calcCost(model, inp, out, cw, cr);
      }
    }
  }

  return Math.round(totalCost * 100) / 100;
}

// ── Alert dispatch ────────────────────────────────────────────────────────────

function sendToOrchestrator(msg) {
  try {
    execFileSync("cortextos", ["bus", "send-message", "orchestrator", "normal", msg], {
      timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    log(`WARNING: could not send to orchestrator: ${err.message}`);
  }
}

function writePausedMarker(agentName) {
  const markerPath = path.join(STATE_DIR, agentName, "budget-paused");
  try {
    fs.mkdirSync(path.join(STATE_DIR, agentName), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString() + "\n", "utf8");
    log(`Hard-pause marker written for ${agentName}`);
  } catch (err) {
    log(`WARNING: could not write pause marker for ${agentName}: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(BUDGETS_FILE)) {
    log(`budgets.json not found at ${BUDGETS_FILE} — nothing to do`);
    return;
  }

  const budgetsConfig = safeReadJson(BUDGETS_FILE);
  if (!budgetsConfig) { log("Failed to parse budgets.json"); return; }

  const budgets        = budgetsConfig.monthly_budgets_usd || {};
  const thresholds     = (budgetsConfig.alert_thresholds_pct || [50, 75, 90, 100])
    .map((t) => t / 100).sort((a, b) => a - b);
  const hardPauseAt    = (budgetsConfig.hard_pause_at_pct || 100) / 100;
  const hardPauseEnabled = budgetsConfig.hard_pause_enabled === true; // must be explicitly opted in

  const watermark  = safeReadJson(WATERMARK_FILE) || {};
  const month      = monthStr();
  const firstBoot  = !watermark[month]; // true if we haven't seeded this month yet
  if (!watermark[month]) watermark[month] = {};

  const agentNames = Object.keys(budgets);
  if (agentNames.length === 0) { log("No agents in budgets.json"); return; }

  log(`Checking ${agentNames.length} agents for ${month} (first-boot=${firstBoot})`);

  let watermarkDirty = false;
  const summary = [];

  for (const agent of agentNames) {
    const budget = budgets[agent];
    if (!budget || budget <= 0) continue;

    const spent  = readMonthlySpend(agent);
    const pct    = spent / budget;
    const pctStr = (pct * 100).toFixed(1);

    summary.push({ agent, spent, budget, pct_used: pct });

    const crossedThresholds = thresholds.filter((t) => pct >= t);
    if (crossedThresholds.length === 0) {
      log(`  ${agent}: $${spent.toFixed(2)} / $${budget} (${pctStr}%) — OK`);
      if (firstBoot) { watermark[month][agent] = 0; watermarkDirty = true; }
      continue;
    }

    const highestCrossed    = Math.max(...crossedThresholds);
    const highestCrossedPct = Math.round(highestCrossed * 100);
    const lastNotifiedPct   = watermark[month][agent] ?? -1;

    if (firstBoot) {
      // Seed watermark silently — don't alert for pre-existing overruns on first boot
      log(`  ${agent}: $${spent.toFixed(2)} / $${budget} (${pctStr}%) — seeding watermark at ${highestCrossedPct}% (first-boot, no alert)`);
      watermark[month][agent] = highestCrossedPct;
      watermarkDirty = true;
      continue;
    }

    if (highestCrossedPct <= lastNotifiedPct) {
      log(`  ${agent}: $${spent.toFixed(2)} / $${budget} (${pctStr}%) — threshold ${highestCrossedPct}% already notified`);
      continue;
    }

    // New threshold crossed — alert
    const actuallyPausing = hardPauseEnabled && pct >= hardPauseAt;
    const level = actuallyPausing        ? "HARD PAUSE" :
                  highestCrossedPct >= 100 ? "CRITICAL"  :
                  highestCrossedPct >= 90  ? "CRITICAL"  :
                  highestCrossedPct >= 75  ? "WARNING"   : "INFO";

    const hardPauseNote = actuallyPausing
      ? " Hard-pause marker written — new dispatches blocked until Greg unlocks."
      : (pct >= hardPauseAt ? " Set hard_pause_enabled=true in budgets.json to activate auto-pause." : "");

    const alertMsg =
      `[BUDGET ${level}] ${agent}: $${spent.toFixed(2)} / $${budget} monthly cap (${pctStr}%).${hardPauseNote}`;

    log(`  ${agent}: ALERT — ${alertMsg}`);
    // Budget alerts are API-offset tracking (not real cash spend per Greg 2026-05-18).
    // Keep log metric but suppress orchestrator/Telegram relay.

    if (hardPauseEnabled && pct >= hardPauseAt) {
      writePausedMarker(agent);
    }

    watermark[month][agent] = highestCrossedPct;
    watermarkDirty = true;
  }

  // On first-boot, write a human-readable summary report
  if (firstBoot) {
    const summaryPath = path.join(STATE_DIR, `budget-summary-${month}.json`);
    safeWriteJson(summaryPath, { month, generated_at: new Date().toISOString(), agents: summary });
    log(`First-boot summary written to ${summaryPath}`);
  }

  if (watermarkDirty) {
    safeWriteJson(WATERMARK_FILE, watermark);
    log("Watermark updated");
  }

  log("Done");
}

main().catch((err) => {
  console.error(`[budget-check] Fatal: ${err.message}`);
  process.exit(1);
});
