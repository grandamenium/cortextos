'use strict';
// Fleet-side preventive session-bloat restart.
// External trigger — agent never restarts itself (avoids PTY race class).
//
// TWO modes:
//   Fleet mode (daily 4am): scans all agents; restarts those over RESTART_MB (40MB).
//     Backstop for slow-drifter accumulators.
//   Targeted mode (on-WARN trigger): called by session-mb-alert.cjs on a new WARN
//     crossing. Restarts a single named agent immediately.
//     Fast-bloaters (e.g. navy) self-clear within ~30min of crossing 45MB, not at 4am.
//
// Safety gates (both modes):
//   1. Mid-task guard: skip if heartbeat.current_task non-empty.
//      FORCE_MB=80 escape: if mb>=80 AND mid-task, force restart with in-voice heads-up.
//   2. Per-agent lockfile (/tmp/bloat-restart-<agent>.lock): prevents double-restart of
//      the same agent from 4am fleet run + on-WARN collision, or two rapid on-WARN fires.
//      Stale locks (crash during restart) removed after 5min (> max op time ~90s).
//   3. Fail-loud on SSH failure: alerts zeus; never silently skips a bloated agent.
//   4. 10-min stagger between restarts in fleet mode.
//   5. headsUpIfDaytime: if 8am-6pm ET, sends in-voice Telegram heads-up before restart.
//      Routes per-org via CUSTOMER_CHANNELS. Off-hours = silent.
//
// Known edge: if on-WARN fires during the 4am fleet stagger window for the same agent,
// the agent may be restarted twice. Impact is benign (double fresh-boot, no work loss).

const { createClient } = require('/Users/zelda/cortextos/dashboard/node_modules/@supabase/supabase-js');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESTART_MB = 40;   // fleet-mode threshold — backstop for slow-drifters
const FORCE_MB   = 80;   // perpetual-defer escape: force restart even if mid-task
const DRY_RUN = process.argv.includes('--dry-run');
const HOME = process.env.HOME;

// Targeted mode args (set when called by session-mb-alert on new WARN crossing)
const targetIdx = process.argv.indexOf('--target');
const orgIdx    = process.argv.indexOf('--org');
const mbIdx     = process.argv.indexOf('--mb');
const TARGET_AGENT = targetIdx >= 0 ? (process.argv[targetIdx + 1] || null) : null;
const TARGET_ORG   = orgIdx    >= 0 ? (process.argv[orgIdx    + 1] || null) : null;
const TARGET_MB    = mbIdx     >= 0 ? parseFloat(process.argv[mbIdx + 1])   : null;

// ---------------------------------------------------------------------------
// Box routing — SSH target + orphan-safe restart script per org.
//
// restartScript(agentName): returns a self-contained shell command using the
// apollo-proven stop-first sequence (live-verified on wally 2026-06-24):
//   1. 'cortextos stop <agent>' FIRST — halts daemon auto-respawn + kills daemon-tracked proc.
//      MUST be first: kill-first without stop races the daemon respawn (daemon detects
//      the killed proc and immediately re-spawns it → back to multiple processes).
//   2. Find and kill -9 any surviving stragglers via proc-cwd readlink — these are
//      orphans the daemon lost track of (no pidfile) that stop couldn't reach.
//   3. 'cortextos start <agent>' — daemon-managed clean spawn (out-of-band, no --continue).
//   4. Verify: new_count==1 (exactly one new process via proc-cwd).
//
// restartOnBox() SSHes once with this script, parses the VERIFY: line,
// and fail-louds (alerts zeus, returns false) if the post-restart state is not
// exactly: new_count=1 (single live process).
// ---------------------------------------------------------------------------
const BOX_ROUTES = {
  'portner-shure': {
    sshArgs: [
      '-i', `${HOME}/.ssh/cortextos_pilot_hostinger`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=20',
      '-o', `ProxyCommand=ssh -i ${HOME}/.ssh/cortextos_pilot_hostinger -W %h:%p zeusops@2.25.174.204`,
      'zeusops@2.25.173.240',
    ],
    restartScript: (agentName) => {
      const dir = `/home/zeusops/cortextos/orgs/portner-shure/agents/${agentName}`;
      // pgrep -u zeusops scopes to the box user that owns all portner-shure agents.
      // Exact CWD match isolates this agent from other agents (portia/rosa/navy are siblings).
      const parts = [
        `find_pids() { for p in $(pgrep -u zeusops -x claude 2>/dev/null); do cwd=$(readlink /proc/$p/cwd 2>/dev/null); [ "$cwd" = "${dir}" ] && echo $p; done; }`,
        // Step 1: Stop FIRST — halts daemon auto-respawn, kills daemon-tracked proc
        `cortextos stop ${agentName} 2>&1`,
        `sleep 3`,
        // Step 2: Kill orphans daemon stop missed (no-pidfile stragglers)
        `surv=$(find_pids); [ -n "$surv" ] && { echo "KILL-STRAGGLERS: [$surv]"; kill -9 $surv 2>/dev/null; sleep 2; }; true`,
        // Capture old pids for VERIFY comparison (after the kill to get the full set)
        `old_pids=$(echo "$surv" | tr '\\n' ' ')`,
        // Step 3: Clean daemon-managed spawn (out-of-band, not in-band hard-restart)
        `cortextos start ${agentName} 2>&1`,
        `sleep 8`,
        // Step 4: Verify
        `new_pids=$(find_pids | tr '\\n' ' ')`,
        `new_count=$(find_pids | wc -l | tr -d ' ')`,
        `echo "VERIFY: old_pids=[$old_pids] new_pids=[$new_pids] new_count=$new_count"`,
      ];
      return parts.join('; ');
    },
  },
  'new-blue-sky': {
    sshArgs: [
      '-i', `${HOME}/.ssh/cortextos_pilot_hostinger`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=20',
      '-o', `ProxyCommand=ssh -i ${HOME}/.ssh/cortextos_pilot_hostinger -W %h:%p zeusops@2.25.174.204`,
      'root@2.25.159.173',
    ],
    restartScript: (agentName) => {
      const dir = `/home/ctx/cortextos/orgs/new-blue-sky/agents/${agentName}`;
      const bin = '/home/ctx/.npm-global/bin/cortextos';
      // Script runs inside su - ctx -c '...' — no single quotes in the body (safe for the wrapper).
      const script = [
        `find_pids() { for p in $(pgrep -x claude 2>/dev/null); do cwd=$(readlink /proc/$p/cwd 2>/dev/null); [ "$cwd" = "${dir}" ] && echo $p; done; }`,
        `${bin} stop ${agentName} 2>&1`,
        `sleep 3`,
        `surv=$(find_pids); [ -n "$surv" ] && { echo "KILL-STRAGGLERS: [$surv]"; kill -9 $surv 2>/dev/null; sleep 2; }; true`,
        `old_pids=$(echo "$surv" | tr '\\n' ' ')`,
        `${bin} start ${agentName} 2>&1`,
        `sleep 8`,
        `new_pids=$(find_pids | tr '\\n' ' ')`,
        `new_count=$(find_pids | wc -l | tr -d ' ')`,
        `echo "VERIFY: old_pids=[$old_pids] new_pids=[$new_pids] new_count=$new_count"`,
      ].join('; ');
      // Gate D: the su -c wrapper breaks if the body has any literal single-quote.
      // Enforce here rather than relying only on the comment above.
      if (script.includes("'")) {
        throw new Error(`new-blue-sky restartScript body contains a single-quote character — su -c '...' wrapper would break. Escape or rewrite the offending part.`);
      }
      return `su - ctx -c '${script}'`;
    },
  },
};

// ---------------------------------------------------------------------------
// Customer channels — in-voice Telegram heads-up before daytime restarts.
// headsUpRemoteCmd(escapedMsg): SSH remote command to send via the org's customer-facing bot.
// No entry = no heads-up (fleet-mac agents like sage/apollo have no customer channel).
//
// Key invariant: always route via the org's known CUSTOMER-FACING bot (portia for P&S,
// wally for new-blue-sky). These are the only bots the customers have /started.
// Per-agent bot tokens differ — worker agents (rosa, navy, etc.) have their OWN tokens
// that customers have NOT /started → silent Telegram 403. Use the customer-facing bot only.
// send-telegram reads .env directly (no live PTY required) so portia can announce its own
// restart: heads-up SSH completes before the restart SSH fires.
// ---------------------------------------------------------------------------
const CUSTOMER_CHANNELS = {
  'portner-shure': {
    // Jordan direct chat (8696301271). Always via portia's bot (8981319328) — the bot
    // Jordan has /started. Rosa's bot (8997669197) is separate; Jordan has NOT /started it.
    headsUpRemoteCmd: (escapedMsg) =>
      `cd /home/zeusops/cortextos/orgs/portner-shure/agents/portia && ` +
      `CTX_AGENT_NAME=portia CTX_ORG=portner-shure cortextos bus send-telegram 8696301271 '${escapedMsg}'`,
  },
  'new-blue-sky': {
    // Yarianne direct chat (6419885464) via wally bot — the only agent on this box.
    // No second agent available; alertZeus is the floor (no separate BOT_TOKEN stored in sage).
    // R5: escapedMsg is double-quoted inside su -c '...'. Safe ONLY because msg is a static
    // hardcoded string with no $, `, or " characters. If message copy ever gains those chars,
    // switch to base64 decode: send-telegram ... "$(echo <b64> | base64 -d)" instead.
    headsUpRemoteCmd: (escapedMsg) =>
      `su - ctx -c 'cd /home/ctx/cortextos/orgs/new-blue-sky/agents/wally && ` +
      `CTX_AGENT_NAME=wally CTX_ORG=new-blue-sky /home/ctx/.npm-global/bin/cortextos bus send-telegram 6419885464 "${escapedMsg}"'`,
  },
};

// ---------------------------------------------------------------------------
// Per-agent lockfile — prevents double-restart of the same agent
// ---------------------------------------------------------------------------

function lockFilePath(agentName) {
  return path.join(os.tmpdir(), `bloat-restart-${agentName}.lock`);
}

function acquireLock(agentName) {
  const lp = lockFilePath(agentName);
  try {
    const stat = fs.statSync(lp);
    const ageSec = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSec > 300) {
      // Stale lock from a prior crash — safe to remove and proceed (5min > max op time ~90s)
      if (!DRY_RUN) fs.unlinkSync(lp);
      console.log(`lock: removed stale lock for ${agentName} (age ${Math.round(ageSec / 60)}min)`);
    } else {
      console.log(`SKIP: lock held for ${agentName} (age ${Math.round(ageSec / 60)}min) — already restarting`);
      return false;
    }
  } catch { /* no lock file — fine, proceed */ }
  if (DRY_RUN) { console.log(`[dry-run] WOULD acquire lock: ${agentName}`); return true; }
  fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return true;
}

function releaseLock(agentName) {
  if (DRY_RUN) return;
  try { fs.unlinkSync(lockFilePath(agentName)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Daytime detection (EDT = UTC-4, conservative; switch to EST UTC-5 Nov-Mar)
// ---------------------------------------------------------------------------
function isDaytimeET() {
  const hourET = (new Date().getUTCHours() - 4 + 24) % 24;
  return hourET >= 8 && hourET < 18;
}

// ---------------------------------------------------------------------------
// In-voice heads-up before daytime restart
// ---------------------------------------------------------------------------
function headsUpIfDaytime(agentName, orgSlug, forced = false) {
  if (!isDaytimeET()) return;
  const channel = CUSTOMER_CHANNELS[orgSlug];
  if (!channel) {
    console.log(`headsUp: no channel configured for org "${orgSlug}" — skipping`);
    return;
  }
  const route = BOX_ROUTES[orgSlug];
  if (!route) return;

  // Customer-voice copy: no internal agent names. Message comes from the org's
  // customer-facing bot so the customer reads it as "their assistant" speaking.
  const suffix = forced ? ' (performance maintenance)' : '';
  const msg = `Quick maintenance update — running a brief system refresh${suffix}. Back in just a moment!`;
  const escapedMsg = msg.replace(/'/g, "'\\''");
  if (DRY_RUN) { console.log(`[dry-run] WOULD send heads-up to ${orgSlug} (${agentName} restart): ${msg}`); return; }
  try {
    execFileSync('ssh', [...route.sshArgs, channel.headsUpRemoteCmd(escapedMsg)], { stdio: 'pipe', timeout: 20000 });
    console.log(`headsUp: sent to ${orgSlug} (${agentName} restart)`);
  } catch (e) {
    alertZeus(`[bloat-restart] headsUp FAILED for ${orgSlug}: ${e.message.slice(0, 100)}. Restart will proceed, customer not notified.`);
  }
}

// ---------------------------------------------------------------------------
// Parse VERIFY: line output from restartScript — done-on-EFFECT, not done-on-command-sent.
// Returns { ok: true, newPid } or { ok: false, reason }.
// ---------------------------------------------------------------------------
function parseRestartVerify(output, agentName) {
  const lines = (output || '').split('\n');
  const line = lines.find(l => l.startsWith('VERIFY:'));
  if (!line) {
    return { ok: false, reason: `no VERIFY line in output — script may have failed early. stdout: ${(output || '').slice(0, 300)}` };
  }
  const newCountM = line.match(/new_count=(\d+)/);
  const newPidsM  = line.match(/new_pids=\[([^\]]*)\]/);
  const oldPidsM  = line.match(/old_pids=\[([^\]]*)\]/);
  const newCount = newCountM ? parseInt(newCountM[1], 10) : -1;
  const newPids  = newPidsM  ? newPidsM[1].trim()  : '';
  const oldPids  = oldPidsM  ? oldPidsM[1].trim()  : '';
  if (newCount !== 1) {
    return { ok: false, reason: `expected 1 process after restart, got ${newCount}. old=[${oldPids}] new=[${newPids}]` };
  }
  const newPid = newPids.split(/\s+/).filter(Boolean)[0] || '';
  if (oldPids.split(/\s+/).filter(Boolean).includes(newPid)) {
    return { ok: false, reason: `new PID (${newPid}) is the same as an old PID — old process was not replaced` };
  }
  return { ok: true, newPid };
}

// ---------------------------------------------------------------------------
// Alert zeus
// ---------------------------------------------------------------------------
function alertZeus(msg) {
  if (DRY_RUN) { console.log(`[dry-run] WOULD ALERT ZEUS: ${msg}`); return; }
  try {
    const escaped = msg.replace(/'/g, "'\\''");
    execSync(`cortextos bus send-message zeus urgent '${escaped}'`, { stdio: 'pipe', timeout: 15000 });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Restart helpers — both use kill-first + verify-after (done-on-EFFECT)
// ---------------------------------------------------------------------------
const FLEET_MAC_AGENTS = new Set(['sage', 'apollo', 'hermes']);

// BUG-011 GUARD: customer boxes must be EXPLICITLY upgraded before per-agent restartOnBox
// is safe. Old-daemon (JBODE-mhhs/ZeusOS, ~42 behind grandamenium) ignores
// enabled-agents.json in-memory → stop/start re-corrupts to double-process (live-verified
// apollo 2026-06-24). Fail-safe: unknown or old-daemon box = BLOCKED; only confirmed-
// upgraded boxes (stopRequested + atomic-disable ported + deployed) go in this set.
// Add a box here AFTER the daemon upgrade is verified on that customer box.
// Keeping this empty lets us safely re-enable AUTO_RESTART_ENABLED for the local fleet
// while customer boxes stay blocked until individually upgraded (Bode-gated morning item).
const UPGRADED_CUSTOMER_BOXES = new Set([]);

// Fleet-mac: apollo-proven stop-first sequence, then verify.
// Async because we need sleep() between stop/start/verify.
async function restartFleetMac(agentName, reason = 'preventive-daily-clear') {
  if (DRY_RUN) { console.log(`[dry-run] fleet-mac restart: ${agentName} reason=${reason}`); return true; }
  try {
    const ctxRoot = process.env.CTX_ROOT || `/Users/zelda/.cortextos/${process.env.CTX_INSTANCE_ID || 'default'}`;
    const pidFile = path.join(ctxRoot, 'state', agentName, 'agent.pid');
    let oldPid = null;
    try { oldPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10) || null; } catch { /* no pidfile */ }
    console.log(`fleet-mac restart: ${agentName} oldPid=${oldPid}`);

    // Step 1: Daemon stop FIRST — halts auto-respawn, kills daemon-tracked proc.
    // kill-first without stop races daemon respawn (daemon detects killed proc → re-spawns immediately).
    execFileSync('cortextos', ['stop', agentName], { stdio: 'pipe', timeout: 30000 });
    await sleep(3000);

    // Step 2a: Kill daemon-tracked straggler if stop didn't reach it.
    // G-6 gate fix: split 0-check and SIGKILL into separate try-catches — if the
    // 0-check passes (process alive) but SIGKILL fails with EPERM (PID reuse race or
    // permission error), the original merged catch silently swallowed it. Now we alert
    // zeus on any SIGKILL failure that isn't ESRCH (already dead).
    if (oldPid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch { /* already dead */ }
      if (alive) {
        try { process.kill(oldPid, 'SIGKILL'); } catch (e) {
          if (e.code !== 'ESRCH') alertZeus(`[bloat-restart] fleet-mac: SIGKILL failed on old pid ${oldPid} (${agentName}): ${e.code} — straggler may still be alive`);
        }
      }
      await sleep(1000);
    }
    // Step 2b: macOS has no /proc — use lsof to sweep ALL remaining claude orphans
    // matching this agent's dir (guards against multi-orphan cases like the wally 2-process bug).
    // Path pattern: /agents/<agentName> is unique per-agent across the fleet-mac org tree.
    // G-1 gate fix: use path-boundary regex, not substring, to avoid matching
    // sibling agent names (e.g. 'sage' matching '/agents/sage-worker').
    const orphanPathRe = new RegExp(`/agents/${agentName}(?:[/\\s]|$)`);
    try {
      const allPids = execFileSync('pgrep', ['-x', 'claude'], { stdio: 'pipe', timeout: 5000 }).toString().trim().split('\n').filter(Boolean);
      for (const p of allPids) {
        const pid = parseInt(p, 10);
        if (!pid || pid === process.pid) continue;
        try {
          const lsofOut = execFileSync('lsof', ['-p', String(pid), '-a', '-d', 'cwd'], { stdio: 'pipe', timeout: 5000 }).toString();
          if (orphanPathRe.test(lsofOut)) {
            process.kill(pid, 'SIGKILL');
            console.log(`fleet-mac: killed orphan claude pid ${pid} (agent ${agentName})`);
          }
        } catch { /* pid may have died */ }
      }
    } catch { /* pgrep found nothing — fine */ }
    await sleep(1000);

    // Step 3: Clean daemon-managed spawn (cortextos start = out-of-band, no --continue)
    execFileSync('cortextos', ['start', agentName], { stdio: 'pipe', timeout: 30000 });
    await sleep(8000);

    // Step 4: Verify — new pidfile must exist, new PID alive, different from old
    let newPid = null;
    try { newPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10) || null; } catch { /* no pidfile yet */ }
    if (!newPid) {
      alertZeus(`[bloat-restart] fleet-mac VERIFY FAILED: ${agentName} — no new pidfile after restart. Manual check needed.`);
      return false;
    }
    if (newPid === oldPid) {
      alertZeus(`[bloat-restart] fleet-mac VERIFY FAILED: ${agentName} — new PID (${newPid}) same as old. Old process may not have died.`);
      return false;
    }
    try { process.kill(newPid, 0); } catch {
      alertZeus(`[bloat-restart] fleet-mac VERIFY FAILED: ${agentName} — new PID ${newPid} not alive after restart.`);
      return false;
    }
    console.log(`fleet-mac restart VERIFIED ✓: ${agentName} old=${oldPid} new=${newPid}`);
    return true;
  } catch (e) {
    alertZeus(`[bloat-restart] FAILED to restart fleet-mac agent ${agentName}: ${e.message}`);
    return false;
  }
}

// On-box: SSH orphan-safe restart script, parse VERIFY: line, fail-loud on any miss.
// Script kills ALL matching PIDs (proc-cwd), force-kills stragglers, then triggers daemon
// hard-restart. One SSH call — script blocks until verify completes (up to ~25s).
function restartOnBox(agentName, orgSlug, reason = 'preventive-daily-clear') {
  // BUG-011: only attempt per-agent SSH restart on boxes confirmed upgraded (in
  // UPGRADED_CUSTOMER_BOXES). All others — including known P&S/new-blue-sky — are
  // hard-skipped: old-daemon ignores enabled-agents.json in-memory, re-corrupts to
  // double-process. Alert zeus to trigger a full pm2 daemon-restart instead.
  // Remove a box from this gate by adding it to UPGRADED_CUSTOMER_BOXES after upgrade
  // is verified (stopRequested + atomic-disable confirmed on that box's daemon).
  if (!UPGRADED_CUSTOMER_BOXES.has(orgSlug)) {
    // (b)+(d): quiet log only — this is intentional/expected, not a failure.
    // zeus was already alerted on the WARNING new-crossing; repeating here every 2h = noise.
    // Returns 'blocked' so the fleet-mode summary shows "Skipped (blocked, needs upgrade): N"
    // instead of "Failed: N" — an allowlist-skip is correct designed behavior, not an error.
    console.log(`[bloat-restart] SKIP per-agent restart for ${agentName} (${orgSlug}) — box not on upgraded list (BUG-011, daemon upgrade pending).`);
    return 'blocked';
  }
  const route = BOX_ROUTES[orgSlug];
  if (!route) {
    alertZeus(`[bloat-restart] No SSH route for org "${orgSlug}" — agent ${agentName} not restarted. Add route to BOX_ROUTES.`);
    return false;
  }
  if (DRY_RUN) { console.log(`[dry-run] SSH restart: ${agentName} (${orgSlug}) reason=${reason}`); return true; }
  let output = '';
  try {
    output = execFileSync('ssh', [...route.sshArgs, route.restartScript(agentName, reason)],
      { stdio: 'pipe', timeout: 90000 }).toString();
    console.log(`ssh restart output (${agentName}):\n${output.trim()}`);
  } catch (e) {
    // Capture any partial output even on non-zero exit
    output = (e.stdout || '').toString() + (e.stderr || '').toString();
    if (!output.includes('VERIFY:')) {
      alertZeus(
        `[bloat-restart] SSH FAILED for ${agentName} (${orgSlug}) — bastion/box unreachable? ` +
        `Agent NOT restarted. Manual restart needed. Error: ${e.message.slice(0, 200)}`
      );
      return false;
    }
    console.log(`ssh exited non-zero but has VERIFY line — parsing. output:\n${output.trim()}`);
  }
  const result = parseRestartVerify(output, agentName);
  if (!result.ok) {
    alertZeus(`[bloat-restart] VERIFY FAILED for ${agentName} (${orgSlug}): ${result.reason}. Manual cleanup needed.`);
    return false;
  }
  console.log(`bloat-restart [on-box] VERIFIED ✓: ${agentName} (${orgSlug}) newPid=${result.newPid}`);
  return true;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------------
// TARGETED MODE — single agent, on-WARN trigger
// ---------------------------------------------------------------------------
async function restartTargeted(db, orgSlugMap) {
  const agentName = TARGET_AGENT;
  const org       = TARGET_ORG;
  const mb        = TARGET_MB;
  console.log(`bloat-restart [targeted]: ${agentName} (${org}) ${mb != null ? mb + 'MB' : 'mb-unknown'}`);

  if (!acquireLock(agentName)) return;  // already restarting this agent

  try {
    // Re-query current_task for fresh mid-task guard (don't trust caller's snapshot)
    const orgId = Object.entries(orgSlugMap).find(([, slug]) => slug === org)?.[0];
    const { data: hbRows, error } = await db
      .from('heartbeats')
      .select('current_task, org_id, agents(name)');

    // F3 fix: fail-CLOSED on query error — skip restart to protect mid-task agents.
    // The 4am fleet backstop will catch it. An unnecessary delay is always safer
    // than killing an agent mid-task during a transient DB outage.
    if (error) {
      console.error(`targeted: heartbeat query failed: ${error.message} — failing closed, skipping restart`);
      alertZeus(`[bloat-restart] targeted restart for ${agentName} (${org}) SKIPPED: Supabase query error (${error.message.slice(0, 100)}). Will retry on next WARN crossing.`);
      return;
    }

    // F5 fix: no cross-org name fallback — if org-filtered lookup misses, log and proceed
    // with unknown task state (treat as idle) rather than matching a different org's agent.
    const row = (hbRows || []).find(r =>
      r.agents?.name === agentName && (orgId == null || r.org_id === orgId)
    );
    if (!row) {
      console.log(`targeted: no heartbeat row found for ${agentName} (${org}) — treating current_task as empty, proceeding`);
    }

    const currentTask = row?.current_task || '';

    if (currentTask.trim().length > 0) {
      if (mb != null && mb >= FORCE_MB) {
        // FORCE_MB escape: perpetual-defer safety valve — restart despite mid-task
        console.log(`FORCE-RESTART: ${agentName} (${org}) ${mb}MB >= FORCE_MB=${FORCE_MB}, mid-task="${currentTask}"`);
        headsUpIfDaytime(agentName, org, true /* forced */);
      } else {
        console.log(`SKIP (mid-task): ${agentName} (${org}) = ${mb}MB — current_task="${currentTask}". Next warn-cycle will retry.`);
        return;
      }
    } else {
      headsUpIfDaytime(agentName, org, false);
    }

    const ok = FLEET_MAC_AGENTS.has(agentName)
      ? await restartFleetMac(agentName, 'on-warn-bloat-clear')
      : restartOnBox(agentName, org, 'on-warn-bloat-clear');

    console.log(`bloat-restart [targeted]: ${agentName} ${ok ? 'DONE ✓' : 'FAILED ✗'}`);
  } finally {
    releaseLock(agentName);
  }
}

// ---------------------------------------------------------------------------
// FLEET MODE — daily 4am backstop for slow-drifters
// ---------------------------------------------------------------------------
async function restartFleet(db, orgSlugMap) {
  const { data: hbData, error: hbErr } = await db
    .from('heartbeats')
    .select('session_mb, current_task, org_id, agents(name)')
    .not('session_mb', 'is', null);

  if (hbErr) { console.error('heartbeats query failed:', hbErr.message); process.exit(1); }

  const candidates = [];
  for (const r of hbData || []) {
    const agentName = r.agents?.name;
    if (!agentName || r.session_mb == null) continue;
    const mb = typeof r.session_mb === 'number' ? r.session_mb : parseFloat(r.session_mb);
    if (mb < RESTART_MB) continue;

    const org = orgSlugMap[r.org_id] || r.org_id?.slice(0, 8);
    const currentTask = r.current_task || '';

    if (currentTask.trim().length > 0) {
      console.log(`SKIP (mid-task): ${agentName} (${org}) = ${mb}MB — current_task="${currentTask}". Will retry next cycle.`);
      continue;
    }
    candidates.push({ agentName, org, mb });
  }

  console.log(`bloat-restart [fleet]: ${candidates.length} candidates over ${RESTART_MB}MB.`);

  let restarted = 0;
  let failed = 0;
  let lockSkipped = 0;   // F6 fix: distinguish benign lock-contention from real failures
  let skippedBlocked = 0; // (d) BUG-011 allowlist skips — intentional, not a failure

  for (let i = 0; i < candidates.length; i++) {
    const { agentName, org, mb } = candidates[i];

    if (!acquireLock(agentName)) {
      // Lock held by a concurrent on-WARN restart — agent already being cleared, not a failure
      lockSkipped++;
      continue;
    }

    try {
      console.log(`RESTART: ${agentName} (${org}) = ${mb}MB`);
      headsUpIfDaytime(agentName, org, false);

      const result = FLEET_MAC_AGENTS.has(agentName)
        ? await restartFleetMac(agentName, 'preventive-daily-clear')
        : restartOnBox(agentName, org, 'preventive-daily-clear');

      if (result === true) restarted++;
      else if (result === 'blocked') skippedBlocked++;
      else failed++;
    } finally {
      releaseLock(agentName);
    }

    if (i < candidates.length - 1) {
      console.log('Staggering 10min before next restart...');
      if (!DRY_RUN) await sleep(10 * 60 * 1000);
    }
  }

  console.log(`bloat-restart [fleet] done. Restarted: ${restarted}. Lock-skipped (already in progress): ${lockSkipped}. Skipped (blocked, needs upgrade): ${skippedBlocked}. Failed: ${failed}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const url = process.env.FLEET_SUPABASE_URL;
  const key = process.env.FLEET_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('FLEET_SUPABASE_URL + FLEET_SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: orgData, error: orgErr } = await db.from('orgs').select('id,slug');
  if (orgErr) { console.error('orgs query failed:', orgErr.message); process.exit(1); }
  const orgSlugMap = Object.fromEntries((orgData || []).map(o => [o.id, o.slug]));

  if (TARGET_AGENT && TARGET_ORG) {
    await restartTargeted(db, orgSlugMap);
  } else {
    await restartFleet(db, orgSlugMap);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
