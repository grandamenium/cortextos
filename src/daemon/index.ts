import { AgentManager } from './agent-manager.js';
import { IPCServer } from './ipc-server.js';
import { readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { StaleAgentWatchdog } from './stale-watchdog.js';
import { VaultLivenessWatchdog } from './vault-liveness-watchdog.js';
import { sendOperatorAlertBestEffort } from './operator-alert.js';
import { SleepScheduler } from './sleep-scheduler.js';
import { join } from 'path';
import { homedir } from 'os';
import { ensureDir } from '../utils/atomic.js';

// Each fast-checker registers a process-level SIGUSR1 handler (see
// fast-checker.ts:102). With >10 active agents the default Node listener cap
// trips MaxListenersExceededWarning. Bump for the full fleet.
process.setMaxListeners(20);

// ---------------------------------------------------------------------------
// Crash handling: turn silent daemon deaths into attributable, observable
// events. Three responsibilities:
//   1. Write a .daemon-crashed marker per agent — hook-crash-alert.ts uses
//      this on the next session boot to emit "🚨 daemon crashed" instead of
//      the misleading "🚨 agent crashed" default.
//   2. Maintain a small crash-history JSON so we can detect crash-loops.
//   3. On ≥3 crashes in 15 min, send ONE Telegram alert to the operator chat
//      (with a 30-min cooldown). PM2's max_restarts: 10 is the final
//      circuit breaker; our alert fires before the fleet goes fully dead.
// Context: root cause of 2026-04-22 restart storm was unguarded this.pty!
// in worker-process.ts:93 — PR #196 fixed 3 sister sites but missed this
// one. The inject.ts try/catch + worker-process ?. land the structural fix;
// this module is the visibility layer.
// ---------------------------------------------------------------------------

export interface CrashEvent { ts: string; err: string; }
export interface CrashHistory { crashes: CrashEvent[]; lastAlertAt?: string; }

export const CRASH_HISTORY_MAX = 20;
export const CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000;    // 15 min detection window
export const CRASH_LOOP_THRESHOLD = 3;                  // 3 crashes trips the alert
export const CRASH_LOOP_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min between alerts

/**
 * Whether the stale-agent watchdog should be armed. OFF by default: the fleet's
 * "pause" is implemented by the daemon being down while agents stay enabled with
 * now-stale heartbeats, so an always-on watchdog would force-restart the whole
 * paused fleet on the next `pm2 start`. Arming is a deliberate operator act.
 */
export function staleWatchdogEnabled(): boolean {
  return process.env.CTX_STALE_WATCHDOG === '1';
}

export function crashHistoryPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.daemon-crash-history.json');
}

export function readCrashHistory(ctxRoot: string): CrashHistory {
  const p = crashHistoryPath(ctxRoot);
  if (!existsSync(p)) return { crashes: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CrashHistory;
    return { crashes: parsed.crashes ?? [], lastAlertAt: parsed.lastAlertAt };
  } catch {
    return { crashes: [] };
  }
}

export function writeCrashHistory(ctxRoot: string, history: CrashHistory): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    writeFileSync(crashHistoryPath(ctxRoot), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    // disk full / permission issue — don't block exit
    console.error('[daemon] Failed to persist crash history (non-fatal)');
  }
}

export function recordCrash(ctxRoot: string, errStr: string): CrashHistory {
  const history = readCrashHistory(ctxRoot);
  history.crashes.push({ ts: new Date().toISOString(), err: errStr.slice(0, 2000) });
  if (history.crashes.length > CRASH_HISTORY_MAX) {
    history.crashes = history.crashes.slice(-CRASH_HISTORY_MAX);
  }
  writeCrashHistory(ctxRoot, history);
  return history;
}

export function shouldSendCrashLoopAlert(history: CrashHistory): boolean {
  const now = Date.now();
  const windowStart = now - CRASH_LOOP_WINDOW_MS;
  const recent = history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
  if (recent < CRASH_LOOP_THRESHOLD) return false;
  if (history.lastAlertAt) {
    const cooldownEnd = Date.parse(history.lastAlertAt) + CRASH_LOOP_COOLDOWN_MS;
    if (now < cooldownEnd) return false;
  }
  return true;
}

export function countRecentCrashes(history: CrashHistory): number {
  const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
  return history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
}

export function writeDaemonCrashedMarkers(ctxRoot: string): void {
  // Scan state/ for per-agent dirs (each agent has state/<name>/ created
  // by AgentProcess). Writing here parallels the .daemon-stop marker path
  // in agent-manager.ts:stopAll — lets hook-crash-alert.ts distinguish
  // crash from planned stop. Each write is independently try/catch'd so
  // a single bad agent dir can't block the exit path.
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return;
  let names: string[];
  try {
    names = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return; }
  const ts = new Date().toISOString();
  for (const name of names) {
    try {
      writeFileSync(join(stateDir, name, '.daemon-crashed'), ts, 'utf-8');
    } catch { /* swallow per-agent */ }
  }
}

function sendCrashLoopAlertBestEffort(
  frameworkRoot: string,
  crashCount: number,
  errStr: string,
): boolean {
  const message =
    `🚨 CRITICAL: cortextos daemon is crash-looping\n` +
    `${crashCount} crashes in 15 minutes\n` +
    `Last error: ${errStr.slice(0, 500)}\n` +
    `Next alert in 30 min if the pattern continues.`;
  const sent = sendOperatorAlertBestEffort(frameworkRoot, message);
  console.error(sent
    ? '[daemon] Crash-loop alert sent to operator chat'
    : '[daemon] Crash-loop alert not delivered (no operator chat configured or send failed)');
  return sent;
}

/**
 * Shared fatal-error handler for both uncaughtException and
 * unhandledRejection. Performs marker writes + crash recording + optional
 * telegram alert, then optionally exits. Stays fully synchronous so it
 * finishes before Node's default crash behavior triggers.
 */
function handleFatal(
  tag: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
  ctxRoot: string,
  frameworkRoot: string,
  doExit: boolean,
): void {
  const errStr = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`[daemon] FATAL ${tag} — exiting for PM2 respawn`);
  console.error(errStr);

  writeDaemonCrashedMarkers(ctxRoot);
  const history = recordCrash(ctxRoot, errStr);

  if (shouldSendCrashLoopAlert(history)) {
    const recent = countRecentCrashes(history);
    if (sendCrashLoopAlertBestEffort(frameworkRoot, recent, errStr)) {
      history.lastAlertAt = new Date().toISOString();
      writeCrashHistory(ctxRoot, history);
    }
  }

  if (doExit) process.exit(1);
}

/**
 * cortextOS Daemon - single process managing all agents.
 * Run via `pm2 start ecosystem.config.js` or `cortextos ecosystem && pm2 start`.
 */
class Daemon {
  private agentManager: AgentManager | null = null;
  private ipcServer: IPCServer | null = null;
  private vaultWatchdog: VaultLivenessWatchdog | null = null;
  private staleWatchdog: StaleAgentWatchdog | null = null;
  private instanceId: string;
  private ctxRoot: string;

  constructor() {
    this.instanceId = process.env.CTX_INSTANCE_ID || 'default';
    // Always derive ctxRoot from instanceId to avoid inheriting a parent cortextOS's CTX_ROOT
    this.ctxRoot = join(homedir(), '.cortextos', this.instanceId);
  }

  async start(): Promise<void> {
    // Force restrictive default permissions for everything the daemon writes:
    // 0700 dirs, 0600 files. Belt-and-suspenders for explicit chmod calls.
    if (process.platform !== 'win32') {
      process.umask(0o077);
    }

    console.log(`[daemon] Starting cortextOS daemon (instance: ${this.instanceId})`);

    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || '';
    const org = process.env.CTX_ORG || '';

    if (!frameworkRoot) {
      console.error('[daemon] CTX_FRAMEWORK_ROOT not set');
      process.exit(1);
    }

    // Write PID file
    const pidFile = join(this.ctxRoot, 'daemon.pid');
    ensureDir(this.ctxRoot);
    writeFileSync(pidFile, String(process.pid), 'utf-8');
    if (process.platform !== 'win32') {
      try {
        chmodSync(pidFile, 0o600);
      } catch { /* best effort */ }
    }

    // Create agent manager
    this.agentManager = new AgentManager(this.instanceId, this.ctxRoot, frameworkRoot, org);

    // Start IPC server
    this.ipcServer = new IPCServer(this.agentManager, this.instanceId);
    await this.ipcServer.start();

    // SYS-DAEMON-RESILIENCE-01 Fix 2: reconcile orphaned PTYs from a prior
    // crash-exit BEFORE (re)starting agents. A SIGHUP-handling claude child
    // survives a daemon crash (reparented to PID 1) but is unreachable by the
    // new daemon; reap the confirmed-own survivor first so discoverAndStart
    // cold-starts it cleanly with --continue (context from the on-disk JSONL),
    // instead of leaving a cron-less orphan + a duplicate fresh spawn.
    this.agentManager.reconcileOrphans();

    // Discover and start agents
    await this.agentManager.discoverAndStart();

    // Stale-agent watchdog: auto-restarts agents whose heartbeat has gone stale
    // (rate-limit aware, crash-budgeted). OFF BY DEFAULT — the fleet's "pause" is
    // just the daemon being down while every agent stays enabled with a now-stale
    // heartbeat, so an always-on watchdog would force-restart the whole paused fleet
    // on the next `pm2 start`. Arming it is a deliberate operator act: set
    // CTX_STALE_WATCHDOG=1. (This wires the previously-orphaned import.)
    if (staleWatchdogEnabled()) {
      this.staleWatchdog = new StaleAgentWatchdog(this.agentManager, this.ctxRoot, frameworkRoot);
      this.staleWatchdog.start();
      console.log('[daemon] StaleAgentWatchdog armed (CTX_STALE_WATCHDOG=1)');
    } else {
      console.log('[daemon] StaleAgentWatchdog present but DISABLED (set CTX_STALE_WATCHDOG=1 to arm)');
    }

    // Keep the vault coordination layer alive: regenerate agent-shared/active-tasks.md
    // from the live bus every cycle (replacing the dead cron-prompt updater) and alert
    // when the narrative state (project-state.md) goes stale. Without this the board
    // freezes on its placeholder and the fleet loses shared visibility (the root cause
    // of duplicate work).
    this.vaultWatchdog = new VaultLivenessWatchdog(this.instanceId, org, frameworkRoot);
    this.vaultWatchdog.start();

    console.log(`[daemon] Running (pid: ${process.pid})`);

    // Handle shutdown signals
    const shutdown = async () => {
      console.log('[daemon] Shutting down...');
      // Stop the watchdogs FIRST, before stopAll(), so no in-flight tick can
      // restart an agent (stale watchdog) or regenerate the board mid-teardown.
      if (this.staleWatchdog) {
        this.staleWatchdog.stop();
      }
      if (this.vaultWatchdog) {
        this.vaultWatchdog.stop();
      }
      try {
        if (this.agentManager) {
          await this.agentManager.stopAll();
        }
      } catch (err) {
        console.error('[daemon] Error during shutdown:', err);
      }
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      // Clean up PID file
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
      process.exit(0);
    };

    // BUG-003 fix: re-entrancy guard. A second SIGTERM arriving while
    // shutdown() is in flight would start a parallel stopAll(), causing
    // unpredictable signal cascades across child PTY processes.
    let shuttingDown = false;
    const handleSignal = () => {
      if (shuttingDown) {
        console.log('[daemon] Shutdown already in progress, ignoring signal');
        return;
      }
      shuttingDown = true;
      shutdown().catch((err) => {
        console.error('[daemon] Fatal shutdown error:', err);
        process.exit(1);
      });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    // Global fatal-error handlers. uncaughtException exits for PM2 respawn.
    // unhandledRejection logs + records but does not exit (rejected promises
    // shouldn't be fatal by default; matches Node 15+ behavior without
    // adopting the new strict default). Both paths write .daemon-crashed
    // markers and increment the crash-loop counter.
    const ctxRootForHandler = this.ctxRoot;
    const frameworkRootForHandler = frameworkRoot;
    process.on('uncaughtException', (err) => {
      handleFatal('uncaughtException', err, ctxRootForHandler, frameworkRootForHandler, true);
    });
    process.on('unhandledRejection', (reason) => {
      handleFatal('unhandledRejection', reason, ctxRootForHandler, frameworkRootForHandler, false);
    });
    console.log('[daemon] Fatal-error handlers registered (uncaughtException + unhandledRejection)');

    // Debug-only: SIGUSR2 induces a controlled uncaughtException for
    // live crash-path verification. Off in production unless
    // CTX_DEBUG_ALLOW_CRASH_TRIGGER=1 is explicitly set. See docs/debugging.md.
    if (process.env.CTX_DEBUG_ALLOW_CRASH_TRIGGER === '1') {
      process.on('SIGUSR2', () => {
        console.error('[daemon] SIGUSR2 received — inducing test crash (CTX_DEBUG_ALLOW_CRASH_TRIGGER=1)');
        throw new Error('Simulated daemon crash via SIGUSR2 (test harness)');
      });
      console.log('[daemon] SIGUSR2 crash trigger ENABLED (debug mode)');
    }

    // Fallback cleanup on exit (belt-and-suspenders for Windows)
    process.on('exit', () => {
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
    });
  }
}

// Only auto-start when run directly (e.g. `node dist/daemon.js` or via PM2).
// Guarding with require.main prevents accidental daemon spawn when the module
// is require()'d for testing or class imports — which would start a full daemon
// with TelegramPollers, IPC server, and Claude PTY processes as a side effect.
// See: https://github.com/grandamenium/cortextos/issues/44
if (require.main === module) {
  const daemon = new Daemon();
  daemon.start().catch(err => {
    console.error('[daemon] Fatal error:', err);
    process.exit(1);
  });
}
