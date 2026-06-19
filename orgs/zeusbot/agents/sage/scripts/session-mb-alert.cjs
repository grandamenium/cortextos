'use strict';
// Fleet-side session_mb bloat alert.
// Edge-triggered per severity tier, deduped on stable org_id:agent_name:severity key.
// Two tiers: WARNING >60MB (lead time), CRITICAL >91MB (historical stall point).
// Fires once per tier-crossing, clears per-tier on recovery, so portia 74→92 fires WARNING
// then a fresh CRITICAL without needing the WARNING to clear first.

const { createClient } = require('/Users/zelda/cortextos/dashboard/node_modules/@supabase/supabase-js');
const fs = require('fs');
const { execSync } = require('child_process');

const WARN_MB = 60;
const CRIT_MB = 91;
const CTX_ROOT = process.env.CTX_ROOT || `/Users/zelda/.cortextos/${process.env.CTX_INSTANCE_ID || 'default'}`;
const AGENT_NAME = process.env.CTX_AGENT_NAME || 'sage';
const STATE_FILE = `${CTX_ROOT}/state/${AGENT_NAME}/.session-mb-alert-state.json`;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}

function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

function sendToZeus(msg) {
  const escaped = msg.replace(/'/g, "'\\''");
  execSync(`cortextos bus send-message zeus urgent '${escaped}'`, { stdio: 'pipe' });
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
            const leadMb = (CRIT_MB - mb).toFixed(0);
            const msg = label === 'critical'
              ? `[session_mb CRITICAL] ${agentName} (${org}) = ${mb}MB — past ${CRIT_MB}MB historical stall point. Archive+fresh-restart recommended.`
              : `[session_mb WARNING] ${agentName} (${org}) = ${mb}MB — over ${WARN_MB}MB threshold. ~${leadMb}MB before stall risk.`;
            sendToZeus(msg);
            alertsFired++;
            console.log(`ALERT ${label.toUpperCase()}: ${agentName} (${org}) = ${mb}MB`);
          } else {
            console.log(`arm-silent warning (critical owns): ${agentName} (${org}) = ${mb}MB`);
          }
          newState[key] = { alerted_at: new Date().toISOString(), first_mb: mb };
        } else {
          console.log(`dedup ${label}: ${agentName} (${org}) = ${mb}MB`);
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
