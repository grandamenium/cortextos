'use strict';
// Fleet-side session_mb bloat alert.
// Edge-triggered per severity tier, deduped on stable org_id:agent_name:severity key.
// Two tiers: WARNING >45MB (catch before slowness — agents slow at ~50MB), CRITICAL >91MB (historical stall point).
// Fires once per tier-crossing, clears per-tier on recovery, so portia 74→92 fires WARNING
// then a fresh CRITICAL without needing the WARNING to clear first.

const { createClient } = require('/Users/zelda/cortextos/dashboard/node_modules/@supabase/supabase-js');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const path = require('path');

const WARN_MB = 45;
const CRIT_MB = 91;
// Max targeted restarts per WARNING key before escalating to zeus instead of restarting.
// 3 = enough headroom for genuine fast-bloaters (typically clears in 1-2 cycles) while bounding
// the runaway-loop risk — 4 cycles × 2h ≥ 8h of unchecked escalation before human review.
// After MAX_RESTARTS: alert zeus, skip restart, let zeus decide (manual restart or investigate).
const MAX_RESTARTS = 3;
// Max heartbeat age for a new-crossing restart. Supabase session_mb is stale until the agent writes
// a fresh HB post-restart. 60min = 1.1× observed max HB cadence (56min); older HBs are suspect.
// Bounds the new-crossing path against state-cleared (F7 race / manual clear) stale-data restarts.
const NEW_CROSSING_HB_MAX_AGE_MS = 60 * 60 * 1000;
const CTX_ROOT = process.env.CTX_ROOT || `/Users/zelda/.cortextos/${process.env.CTX_INSTANCE_ID || 'default'}`;
const AGENT_NAME = process.env.CTX_AGENT_NAME || 'sage';
const STATE_FILE = `${CTX_ROOT}/state/${AGENT_NAME}/.session-mb-alert-state.json`;
const DRY_RUN = process.argv.includes('--dry-run');
// In dry-run mode, use a separate temp state file so transitions persist between runs
// without touching the real state. Pass --dry-state <path> to override.
const dryStateIdx = process.argv.indexOf('--dry-state');
const DRY_STATE_FILE = DRY_RUN
  ? (dryStateIdx >= 0 ? process.argv[dryStateIdx + 1] : '/tmp/session-mb-alert-test-state.json')
  : STATE_FILE;
const ACTIVE_STATE_FILE = DRY_RUN ? DRY_STATE_FILE : STATE_FILE;

function readState() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_STATE_FILE, 'utf-8')); } catch { return {}; }
}

function writeState(s) {
  fs.writeFileSync(ACTIVE_STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
  if (DRY_RUN) console.log(`[dry-run] state written to ${ACTIVE_STATE_FILE}`);
}

function sendToZeus(msg) {
  if (DRY_RUN) { console.log(`[dry-run] WOULD SEND: ${msg}`); return; }
  const escaped = msg.replace(/'/g, "'\\''");
  execSync(`cortextos bus send-message zeus urgent '${escaped}'`, { stdio: 'pipe' });
}

// Spawn a targeted bloat-restart for a single agent (non-blocking, detached).
// Called on every new WARNING crossing — fast-bloaters self-clear within ~30min.
// bloat-restart.cjs applies mid-task guard + lockfile + in-voice heads-up internally.
//
// AUTO-RESTART enabled for LOCAL FLEET only (sage/apollo/hermes via restartFleetMac).
// Customer boxes are handled by BLOCKED_ORGS below — no per-agent restart until daemon upgrade.
const AUTO_RESTART_ENABLED = true;

// (b)+(c): Org slugs on old-daemon boxes where per-agent restart is BUG-011-blocked.
// Mirrors the inverse of UPGRADED_CUSTOMER_BOXES in bloat-restart.cjs (empty set there = all blocked here).
// For blocked orgs: initial WARNING alert fires once (useful), then quiet 2h dedup — no
// restart triggers, no count increments, no count-cap escalations.
// Remove an org here AFTER daemon upgrade verified + box added to UPGRADED_CUSTOMER_BOXES.
const BLOCKED_ORGS = new Set(['portner-shure', 'new-blue-sky']);

function triggerTargetedRestart(agentName, org, mb) {
  if (DRY_RUN) {
    console.log(`[dry-run] WOULD trigger targeted restart: ${agentName} (${org}) ${mb.toFixed(1)}MB`);
    return;
  }
  if (!AUTO_RESTART_ENABLED) {
    console.log(`auto-restart DISABLED (BUG-011): ${agentName} (${org}) ${mb.toFixed(1)}MB — skipping restart, alerting zeus`);
    sendToZeus(`[session_mb] auto-restart skipped for ${agentName} (${org}) = ${mb.toFixed(1)}MB (BUG-011 hold — manual restart needed until race-clean sequence confirmed).`);
    return;
  }
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'bloat-restart.cjs'), '--target', agentName, '--org', org, '--mb', String(mb)],
    { detached: true, stdio: 'ignore', env: process.env }
  );
  child.unref();
  console.log(`triggered targeted restart: ${agentName} (${org}) ${mb.toFixed(1)}MB [pid ${child.pid}]`);
}

async function main() {
  const url = process.env.FLEET_SUPABASE_URL;
  const key = process.env.FLEET_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('FLEET_SUPABASE_URL + FLEET_SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }

  const db = createClient(url, key, { auth: { persistSession: false } });

  const [hbRes, orgRes] = await Promise.all([
    db.from('heartbeats').select('session_mb,org_id,last_heartbeat,agents(name)').not('session_mb', 'is', null),
    db.from('orgs').select('id,slug'),
  ]);
  if (hbRes.error) { console.error('heartbeats query failed:', hbRes.error.message); process.exit(1); }
  if (orgRes.error) { console.error('orgs query failed:', orgRes.error.message); process.exit(1); }

  const orgSlug = Object.fromEntries((orgRes.data || []).map(o => [o.id, o.slug]));
  const state = readState();
  const newState = { ...state };
  let alertsFired = 0;
  let cleared = 0;

  for (const r of hbRes.data || []) {
    const agentName = r.agents?.name;
    if (!agentName || r.session_mb == null) continue;
    const org = orgSlug[r.org_id] || r.org_id?.slice(0, 8);
    const mb = typeof r.session_mb === 'number' ? r.session_mb : parseFloat(r.session_mb);
    const hbTimestamp = r.last_heartbeat || null;  // ISO string — when Supabase last saw a HB from this agent

    // Check each severity tier independently — separate dedup keys, separate edges.
    const tiers = [
      { label: 'critical', threshold: CRIT_MB },
      { label: 'warning',  threshold: WARN_MB },
    ];

    // When above the critical threshold, critical owns the alert channel.
    // Warning fires silently (state-tracked for clear-on-recovery) but sends NO message —
    // prevents a double-alert when an agent jumps straight past 91MB.
    const criticalActive = mb > CRIT_MB;

    for (const { label, threshold } of tiers) {
      const key = `${r.org_id}:${agentName}:${label}`;

      if (mb > threshold) {
        if (!newState[key]) {
          const suppressAlert = label === 'warning' && criticalActive;
          if (!suppressAlert) {
            const leadMb = Math.max(0, CRIT_MB - mb).toFixed(0);
            const msg = label === 'critical'
              ? `[session_mb CRITICAL] ${agentName} (${org}) = ${mb}MB — past ${CRIT_MB}MB historical stall point. Archive+fresh-restart recommended.`
              : `[session_mb WARNING] ${agentName} (${org}) = ${mb}MB — over ${WARN_MB}MB threshold. ~${leadMb}MB before stall risk.`;
            sendToZeus(msg);
            alertsFired++;
            console.log(`ALERT ${label.toUpperCase()}: ${agentName} (${org}) = ${mb}MB`);
          } else {
            console.log(`arm-silent warning (critical owns): ${agentName} (${org}) = ${mb}MB`);
          }
          // On every new WARNING crossing, trigger an immediate targeted restart.
          // (b)+(c): BLOCKED_ORGS skip restart + don't count — daemon upgrade pending.
          // Guard: skip if HB is older than NEW_CROSSING_HB_MAX_AGE_MS — protects against
          // stale-new-crossing (F7 race / manual state clear) where Supabase still shows
          // the pre-restart session_mb. F2 retry path catches it once HB refreshes.
          if (label === 'warning') {
            if (BLOCKED_ORGS.has(org)) {
              console.log(`new-crossing skip-blocked (BUG-011, daemon upgrade pending): ${agentName} (${org}) = ${mb}MB`);
              newState[key] = { alerted_at: new Date().toISOString(), first_mb: mb, restart_count: 0, last_hb_at_trigger: hbTimestamp };
            } else {
              const newCrossingFresh = !hbTimestamp || (Date.now() - new Date(hbTimestamp).getTime() < NEW_CROSSING_HB_MAX_AGE_MS);
              if (newCrossingFresh) {
                triggerTargetedRestart(agentName, org, mb);
              } else {
                console.log(`new-crossing (stale HB ${hbTimestamp}, ${Math.round((Date.now() - new Date(hbTimestamp).getTime()) / 60000)}min old): ${agentName} (${org}) = ${mb}MB — skip restart, waiting for fresh HB`);
              }
              newState[key] = { alerted_at: new Date().toISOString(), first_mb: mb, restart_count: 1, last_restart_triggered_at: new Date().toISOString(), last_hb_at_trigger: hbTimestamp, session_mb_at_trigger: mb };
            }
          } else {
            newState[key] = { alerted_at: new Date().toISOString(), first_mb: mb, restart_count: 0, last_hb_at_trigger: hbTimestamp };
          }
        } else {
          // F2: perpetual-defer retry — if above threshold >2h, re-trigger restart.
          if (label === 'warning') {
            // (b)+(c): BLOCKED_ORGS — quiet 2h dedup, no restart, no count, no zeus.
            if (BLOCKED_ORGS.has(org)) {
              const lastBlocked = newState[key].last_blocked_at;
              const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
              if (!lastBlocked || lastBlocked < twoHoursAgo) {
                console.log(`dedup skip-blocked (pending upgrade): ${agentName} (${org}) = ${mb}MB`);
                newState[key] = { ...newState[key], last_blocked_at: new Date().toISOString() };
              } else {
                console.log(`dedup skip-blocked: ${agentName} (${org}) = ${mb}MB`);
              }
            } else {
              const lastTriggered = newState[key].last_restart_triggered_at;
              const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
              if (!lastTriggered || lastTriggered < twoHoursAgo) {
                // Staleness-check (2 cases):
                // Case 1: HB-ts predates last restart → Supabase shows pre-restart session_mb.
                // Case 2: HB-ts fresh post-restart BUT session_mb didn't decrease →
                //   old daemon doesn't write new session_mb on restart; value stays high.
                //   Neither case reflects the new post-restart session → skip, wait for refresh.
                const hbFresh = !hbTimestamp || !lastTriggered || hbTimestamp > lastTriggered;
                const mbDecreased = newState[key].session_mb_at_trigger == null || mb < newState[key].session_mb_at_trigger * 0.9;
                const measurementFresh = hbFresh && mbDecreased;
                if (!measurementFresh) {
                  const staleReason = !hbFresh
                    ? `HB ${hbTimestamp} predates restart ${lastTriggered}`
                    : `session_mb ${mb.toFixed(1)}MB unchanged from pre-restart ${(newState[key].session_mb_at_trigger || 0).toFixed(1)}MB (old daemon didn't refresh)`;
                  console.log(`dedup warning (stale: ${staleReason}): ${agentName} (${org}) = ${mb}MB — skip restart, waiting for refresh`);
                } else {
                  // Fresh measurement — increment count and act.
                  const restartCount = (newState[key].restart_count || 0) + 1;
                  if (restartCount > MAX_RESTARTS) {
                    // Persistent genuine bloat — escalate to zeus, stop auto-restart.
                    const msg = `[session_mb] ${agentName} (${org}) = ${mb}MB — restarted ${restartCount - 1}x, still above ${WARN_MB}MB. Persistent bloat — manual review needed.`;
                    console.log(`ESCALATE (${restartCount - 1}x restarted): ${agentName} (${org}) = ${mb}MB — alerting zeus, skip auto-restart`);
                    sendToZeus(msg);
                  } else {
                    console.log(`dedup warning (retry-restart #${restartCount} of ${MAX_RESTARTS}): ${agentName} (${org}) = ${mb}MB`);
                    triggerTargetedRestart(agentName, org, mb);
                  }
                  // Only advance timer + count when action is taken (restart or escalation).
                  newState[key] = { ...newState[key], restart_count: restartCount, last_restart_triggered_at: new Date().toISOString(), session_mb_at_trigger: mb };
                }
              } else {
                console.log(`dedup warning (count=${newState[key].restart_count || 0}): ${agentName} (${org}) = ${mb}MB`);
              }
            }
          } else {
            console.log(`dedup ${label}: ${agentName} (${org}) = ${mb}MB`);
          }
        }
      } else {
        if (newState[key]) {
          delete newState[key];
          cleared++;
          console.log(`CLEARED ${label}: ${agentName} (${org}) recovered to ${mb}MB`);
        }
      }
    }
  }

  writeState(newState);
  console.log(`session-mb-alert done. Checked ${(hbRes.data||[]).length} agents. Alerts: ${alertsFired}. Cleared: ${cleared}. Active state keys: ${Object.keys(newState).length}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
