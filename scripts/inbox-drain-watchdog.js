#!/usr/bin/env node
/**
 * inbox-drain-watchdog.js
 *
 * Scans all agent inbox directories under ~/.cortextos/<instance>/inbox/.
 * Alerts via cortextos bus send-message to orchestrator if any agent has
 * more than ALERT_THRESHOLD unprocessed messages older than STALE_MINUTES.
 *
 * Motivation: codex inbox sat with 118 unread messages for 27h due to a
 * stale lock file (cortextos PR #187). This watchdog catches the symptom
 * (accumulating unprocessed messages) regardless of root cause.
 *
 * Usage: node inbox-drain-watchdog.js
 * Schedule: every 5-10 minutes via config.json cron.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ALERT_THRESHOLD = 10;       // messages in inbox before alerting
const STALE_MINUTES   = 30;       // minimum age of oldest message before alerting
const ALERT_AGENT     = 'orchestrator'; // who to notify

const CTX_INSTANCE_ID = process.env.CTX_INSTANCE_ID || 'default';
const CTX_ROOT        = process.env.CTX_ROOT        || path.join(os.homedir(), '.cortextos', CTX_INSTANCE_ID);
const CTX_FRAMEWORK   = process.env.CTX_FRAMEWORK_ROOT || path.join(os.homedir(), 'cortextos');
const CTX_AGENT       = process.env.CTX_AGENT_NAME  || 'dev';
const CTX_ORG         = process.env.CTX_ORG         || 'revops-global';

const INBOX_ROOT      = path.join(CTX_ROOT, 'inbox');
const CLI             = path.join(CTX_FRAMEWORK, 'dist', 'cli.js');

// Inboxes that exist for system/legacy reasons but have no live consumer agent.
// Messages here are not actionable — suppress alerts rather than spam orchestrator.
const SKIP_INBOXES = new Set(['root']);

// State file to track which alerts have been sent (avoid spam)
const STATE_FILE      = path.join(CTX_ROOT, 'state', CTX_AGENT, 'inbox-watchdog-state.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { alerted: {} }; // alerted: { agentName: lastAlertIso }
  }
}

function writeState(state) {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[watchdog] Failed to write state:', e.message);
  }
}

function getMessageAgeMinutes(file) {
  // Filename format: <priority>-<timestamp_ms>-from-<agent>-<nonce>.json
  const match = file.match(/^\d+-(\d+)-/);
  if (match) {
    const ms = parseInt(match[1], 10);
    return (Date.now() - ms) / 60_000;
  }
  // Fallback: stat the file
  try {
    const stat = fs.statSync(file);
    return (Date.now() - stat.mtimeMs) / 60_000;
  } catch {
    return 0;
  }
}

function hasStaleMessages(inboxDir, threshold) {
  try {
    const files = fs.readdirSync(inboxDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'));
    if (files.length < ALERT_THRESHOLD) return null;

    // Find oldest message age
    let oldestAge = 0;
    for (const f of files) {
      const age = getMessageAgeMinutes(path.join(inboxDir, f));
      if (age > oldestAge) oldestAge = age;
    }

    if (oldestAge >= STALE_MINUTES) {
      return { count: files.length, oldestMinutes: Math.round(oldestAge) };
    }
    return null;
  } catch {
    return null;
  }
}

function sendAlert(agent, count, oldestMinutes) {
  const msg = `WATCHDOG: ${agent} inbox has ${count} unprocessed messages, oldest ${oldestMinutes}min. Likely blocked check-inbox (lock/path/crash). Investigate: ls ~/.cortextos/${CTX_INSTANCE_ID}/inbox/${agent}/ and check for .lock.d`;
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: CTX_FRAMEWORK,
    CTX_ROOT,
    CTX_INSTANCE_ID,
    CTX_AGENT_NAME: CTX_AGENT,
    CTX_ORG,
  };
  const result = spawnSync('node', [CLI, 'bus', 'send-message', ALERT_AGENT, 'urgent', msg], {
    encoding: 'utf-8',
    timeout: 10_000,
    env,
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    console.error('[watchdog] Failed to send alert:', result.stderr || result.stdout);
  } else {
    console.log(`[watchdog] Alert sent for ${agent}: ${count} msgs, oldest ${oldestMinutes}min`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(INBOX_ROOT)) {
    console.log('[watchdog] Inbox root not found:', INBOX_ROOT);
    return;
  }

  const agents = fs.readdirSync(INBOX_ROOT)
    .filter(name => {
      if (SKIP_INBOXES.has(name)) return false;
      const p = path.join(INBOX_ROOT, name);
      return fs.statSync(p).isDirectory() && !name.startsWith('.');
    });

  const state  = readState();
  const now    = new Date().toISOString();
  let   alerts = 0;

  for (const agent of agents) {
    const inboxDir = path.join(INBOX_ROOT, agent);
    const stale    = hasStaleMessages(inboxDir, ALERT_THRESHOLD);

    if (!stale) {
      // Clear stale alert state if inbox is healthy again
      if (state.alerted[agent]) {
        console.log(`[watchdog] ${agent} inbox healthy — clearing alert state`);
        delete state.alerted[agent];
      }
      continue;
    }

    // Suppress duplicate alerts within 30 minutes
    const lastAlert = state.alerted[agent];
    if (lastAlert) {
      const minutesSinceLast = (Date.now() - new Date(lastAlert).getTime()) / 60_000;
      if (minutesSinceLast < STALE_MINUTES) {
        console.log(`[watchdog] ${agent}: already alerted ${Math.round(minutesSinceLast)}min ago, suppressing`);
        continue;
      }
    }

    sendAlert(agent, stale.count, stale.oldestMinutes);
    state.alerted[agent] = now;
    alerts++;
  }

  writeState(state);
  console.log(`[watchdog] Scan complete: ${agents.length} agents checked, ${alerts} alerts sent`);
}

main();
