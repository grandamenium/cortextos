#!/usr/bin/env node
/*
 * daemon-ops.js - direct (pm2-free) control for the Ops Command daemon.
 *
 * WHY NOT PM2 (proven in the 2026-07-21 dry run): pm2 stop/delete HANG on
 * Windows, kill_timeout SIGKILL doesn't enforce, and autorestart resurrects the
 * daemon after a manual kill. So we run the daemon as a plain detached node
 * process (isolated from the yt-* pm2 setup) and hard-kill its PID tree to stop.
 *
 * Trade-off (accepted): no autorestart. A daemon crash mid-window leaves the
 * fleet down until the next 19:00 start - safer on 3.7GB than a crash-loop
 * (ADR-0008). Hard-kill means agent exits log as crashes (cosmetic).
 *
 * Safety (per Sol Phase-2-v2 review): PID resolution is identity-verified (the
 * pid must be a live `node ... daemon.js` process) so a stale/reused pid can
 * never spawn a duplicate or taskkill an unrelated process; the health gate
 * waits for real agent bootstrap, not merely a written daemon.pid.
 *
 * Usage:  node daemon-ops.js start [ecosystemPath]
 *         node daemon-ops.js stop
 * Exit:   0 ok - 4 app/ecosystem not found - 5 started-but-not-healthy
 *         - 6 stop-not-confirmed-down - 7 pid identity unverifiable (refused).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const APP_NAME = 'cortextos-daemon';
const ctxRoot = process.env.CTX_ROOT || path.join(os.homedir(), '.cortextos', 'default');
const logDir = path.join(ctxRoot, 'logs');
const daemonOutLog = path.join(logDir, 'daemon-out.log');
const daemonPidFile = path.join(ctxRoot, 'daemon.pid');       // daemon writes its own process.pid
const launcherPidFile = path.join(ctxRoot, 'ops-daemon.pid'); // we write child.pid at spawn
const BOOT_MARKER = 'Bootstrap complete';
const HEALTH_TIMEOUT_S = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ensureLogDir() { try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {} }
function readPidFrom(f) { try { const p = parseInt(fs.readFileSync(f, 'utf8').trim(), 10); return Number.isFinite(p) ? p : null; } catch (_) { return null; } }
function isAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// LOCAL PATCH (Ops Command Part B, 2026-07-24) - re-apply on upstream sync.
// Count enabled agent configs for the active org; a positive override wins.
function expectedAgentCount(env, frameworkRoot) {
  const override = Number(env.CTX_EXPECTED_AGENTS);
  if (Number.isInteger(override) && override > 0) return override;
  const org = env.CTX_ORG;
  if (!org || !frameworkRoot) return 1;
  const agentsDir = path.join(frameworkRoot, 'orgs', org, 'agents');
  try {
    const enabled = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        try {
          const config = JSON.parse(fs.readFileSync(path.join(agentsDir, entry.name, 'config.json'), 'utf8'));
          return config.enabled !== false;
        } catch (_) { return false; }
      }).length;
    return Math.max(1, enabled);
  } catch (_) { return 1; }
}

// Identity: the command line of a pid (or null). Used to refuse killing a
// PID-reused, unrelated process.
function pidCmdline(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`],
      { encoding: 'utf8', timeout: 15000 }).trim();
    return out || null;
  } catch (_) { return null; }
}
function isDaemonProcess(pid) {
  const cl = pidCmdline(pid);
  return !!cl && /daemon\.js/i.test(cl) && /node/i.test(cl);
}

// Resolve the live, identity-verified daemon pid (or null). Prefers the
// daemon-owned pid; deletes any stale/unverifiable pid files.
function resolveDaemonPid() {
  const candidates = [
    { file: daemonPidFile, pid: readPidFrom(daemonPidFile) },
    { file: launcherPidFile, pid: readPidFrom(launcherPidFile) },
  ];
  let verified = null;
  for (const c of candidates) {
    if (c.pid && isAlive(c.pid) && isDaemonProcess(c.pid)) { verified = c.pid; break; }
  }
  for (const c of candidates) {
    if (c.pid && c.pid !== verified && (!isAlive(c.pid) || !isDaemonProcess(c.pid))) {
      try { fs.unlinkSync(c.file); } catch (_) {}
    }
  }
  return verified;
}

// --- start ---------------------------------------------------------------
async function doStart(ecosystemPath) {
  const already = resolveDaemonPid();
  if (already) { console.log(`[daemon-ops] cortextos-daemon already running (pid ${already}) - no-op.`); process.exit(0); }

  const ecoPath = path.resolve(ecosystemPath || path.join(__dirname, '..', 'ecosystem.config.js'));
  let app;
  try { app = (require(ecoPath).apps || []).find((a) => a.name === APP_NAME); }
  catch (e) { console.error(`[daemon-ops] FATAL: cannot load ecosystem ${ecoPath}: ${e.message}`); process.exit(4); }
  if (!app) { console.error(`[daemon-ops] FATAL: app "${APP_NAME}" not in ${ecoPath}.`); process.exit(4); }

  ensureLogDir();
  const args = String(app.args || '').split(/\s+/).filter(Boolean);
  const env = Object.assign({}, process.env, app.env || {});
  const cwd = app.cwd || path.dirname(path.dirname(app.script));
  const frameworkRoot = env.CTX_FRAMEWORK_ROOT || cwd;
  const expectedAgents = expectedAgentCount(env, frameworkRoot);

  // Record where the log ends now, so the health gate only counts THIS run's
  // bootstrap markers (the log is append-mode across runs).
  let logStartOffset = 0;
  try { logStartOffset = fs.statSync(daemonOutLog).size; } catch (_) { logStartOffset = 0; }

  const outFd = fs.openSync(daemonOutLog, 'a');
  const errFd = fs.openSync(path.join(logDir, 'daemon-err.log'), 'a');
  const child = spawn(process.execPath, [app.script, ...args], {
    detached: true, cwd, env, stdio: ['ignore', outFd, errFd], windowsHide: true,
  });
  child.on('error', (e) => { console.error(`[daemon-ops] spawn error: ${e.message}`); });
  if (!child.pid) { console.error('[daemon-ops] FATAL: spawn returned no pid.'); process.exit(5); }
  try { fs.writeFileSync(launcherPidFile, String(child.pid)); } catch (_) {}
  child.unref();
  try { fs.closeSync(outFd); fs.closeSync(errFd); } catch (_) {}   // child holds its own dup'd handles
  console.log(`[daemon-ops] launched cortextos-daemon (pid ${child.pid}); waiting for agent bootstrap...`);

  // Health gate: count NEW "Bootstrap complete" lines (one per agent).
  const deadline = Date.now() + HEALTH_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (!isAlive(child.pid)) { console.error(`[daemon-ops] daemon (pid ${child.pid}) exited during startup - see daemon-err.log.`); process.exit(5); }
    let booted = 0;
    try {
      const buf = fs.readFileSync(daemonOutLog, 'utf8').slice(logStartOffset);
      booted = (buf.match(new RegExp(BOOT_MARKER, 'g')) || []).length;
    } catch (_) {}
    if (booted >= expectedAgents) { console.log(`[daemon-ops] healthy: ${booted}/${expectedAgents} agents bootstrapped (pid ${child.pid}).`); process.exit(0); }
  }
  // Timeout: partial is acceptable-but-warned; zero is a failure.
  let finalBooted = 0;
  try { finalBooted = ((fs.readFileSync(daemonOutLog, 'utf8').slice(logStartOffset)).match(new RegExp(BOOT_MARKER, 'g')) || []).length; } catch (_) {}
  if (finalBooted >= 1 && isAlive(child.pid)) {
    console.log(`[daemon-ops] WARNING: only ${finalBooted}/${expectedAgents} agents bootstrapped in ${HEALTH_TIMEOUT_S}s; daemon alive (pid ${child.pid}). Proceeding - review logs.`);
    process.exit(0);
  }
  console.error(`[daemon-ops] UNHEALTHY: ${finalBooted}/${expectedAgents} agents bootstrapped in ${HEALTH_TIMEOUT_S}s. Investigate daemon-err.log / per-agent logs.`);
  process.exit(5);
}

// --- stop ----------------------------------------------------------------
async function doStop() {
  const pid = resolveDaemonPid();
  if (!pid) {
    // Either nothing running, or a pid file existed but could not be identity-
    // verified (already cleaned by resolveDaemonPid). Never taskkill an
    // unverified pid.
    console.log('[daemon-ops] no identity-verified cortextos-daemon running - nothing to stop.');
    process.exit(0);
  }
  console.log(`[daemon-ops] stopping cortextos-daemon (taskkill /T /F pid ${pid})...`);
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* tolerate already-gone; verify below */ }
  for (let i = 0; i < 15; i++) {
    if (!isAlive(pid)) {
      console.log('[daemon-ops] cortextos-daemon stopped and confirmed down.');
      try { fs.unlinkSync(launcherPidFile); } catch (_) {}
      process.exit(0);
    }
    await sleep(1000);
  }
  console.error(`[daemon-ops] pid ${pid} still alive 15s after taskkill - investigate.`);
  process.exit(6);
}

const cmd = process.argv[2];
if (cmd === 'start') doStart(process.argv[3]);
else if (cmd === 'stop') doStop();
else { console.error('Usage: node daemon-ops.js start [ecosystemPath] | stop'); process.exit(64); }
