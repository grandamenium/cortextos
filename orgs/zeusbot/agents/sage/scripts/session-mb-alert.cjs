'use strict';
// Fleet-side session_mb bloat alert.
// Edge-triggered, deduped on stable org_id:agent_name key, clears on recovery.
// Threshold: 60MB — sits in natural gap (48MB rosa → 74MB portia), 31MB lead
// before ~91MB historical stall (wally Jun 13).

const { createClient } = require('/Users/zelda/cortextos/dashboard/node_modules/@supabase/supabase-js');
const fs = require('fs');
const { execSync } = require('child_process');

const THRESHOLD_MB = 60;
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
    // Stable dedup key: org_id (UUID) + agent name — never contains a ticking value.
    const key = `${r.org_id}:${agentName}`;
    const org = orgSlug[r.org_id] || r.org_id?.slice(0, 8);
    const mb = typeof r.session_mb === 'number' ? r.session_mb : parseFloat(r.session_mb);

    if (mb > THRESHOLD_MB) {
      if (!newState[key]) {
        // New crossing — fire alert (operator-only, never customer).
        const severity = mb > 91 ? 'CRITICAL' : 'WARNING';
        const msg = `[session_mb ${severity}] ${agentName} (${org}) = ${mb}MB — over ${THRESHOLD_MB}MB threshold.`
          + (mb > 91 ? ' Already past ~91MB historical stall point — hard-restart recommended.' : ' ~' + (91 - mb).toFixed(0) + 'MB lead time before stall.');
        sendToZeus(msg);
        newState[key] = { alerted_at: new Date().toISOString(), first_mb: mb };
        alertsFired++;
        console.log(`ALERT: ${key} = ${mb}MB`);
      } else {
        console.log(`dedup: ${key} = ${mb}MB (already alerted, current=${mb}MB)`);
      }
    } else {
      if (newState[key]) {
        // Recovered below threshold — clear so future crossing re-alerts.
        delete newState[key];
        cleared++;
        console.log(`CLEARED: ${key} recovered to ${mb}MB`);
      }
    }
  }

  writeState(newState);
  console.log(`session-mb-alert done. Checked ${(hbRes.data||[]).length} agents. Threshold: ${THRESHOLD_MB}MB. Alerts: ${alertsFired}. Cleared: ${cleared}. Active state keys: ${Object.keys(newState).length}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
