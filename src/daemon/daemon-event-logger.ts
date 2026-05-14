import type { BusPaths, EventCategory, EventSeverity } from '../types/index.js';
import { join } from 'path';
import { logEvent } from '../bus/event.js';

/**
 * Synthetic agent identity for daemon-scope events.
 *
 * Watchdogs that run in daemon scope (cron-dispatch storm detector,
 * heartbeat-staleness watcher, doctor cron) historically emitted their
 * events as stderr-only structured lines because `logEvent` requires an
 * agent identity. Using `_daemon` lets those events flow into the same
 * JSONL pipeline as agent events, so operators can query them with
 * `cortextos bus read-agent-events _daemon --event heartbeat_stale_detected`.
 *
 * The underscore prefix is intentional: `AGENT_NAME_REGEX` in
 * `src/utils/validate.ts` already allows `[a-z0-9_-]+`, and the prefix
 * makes the synthetic identity visually distinct from real agents in
 * directory listings (`analytics/events/_daemon/` sorts ahead of all
 * real agents alphabetically).
 *
 * The directory `analytics/events/_daemon/` is created lazily on first
 * event write; no separate provisioning step is needed.
 */
export const DAEMON_AGENT_NAME = '_daemon';

/**
 * Fire-and-forget structured-event emission from daemon-scope code.
 *
 * Thin wrapper over `logEvent` that hard-codes the agent identity to
 * `_daemon` and swallows any error so a watcher's telemetry call can
 * never break the watcher itself. Callers should keep their existing
 * `console.error` stderr lines too — those go to daemon.log for at-a-
 * glance debugging.
 */
export function logDaemonEvent(
  ctxRoot: string,
  _instanceId: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown>,
): void {
  try {
    logEvent(buildDaemonBusPaths(ctxRoot, org), DAEMON_AGENT_NAME, org, category, eventName, severity, metadata);
  } catch (err) {
    console.error(`[daemon-event-logger] non-fatal: ${(err as Error).message}`);
  }
}

/**
 * Construct the minimal `BusPaths` that `logEvent` actually reads
 * (`analyticsDir` for the JSONL write + `stateDir` for the heartbeat-
 * refresh side-effect, which no-ops on `_daemon` since no heartbeat.json
 * exists). Built from `ctxRoot` directly rather than via `resolvePaths`
 * to avoid leaking `homedir()` defaults into tests that override ctxRoot
 * to a tempdir.
 */
function buildDaemonBusPaths(ctxRoot: string, org: string): BusPaths {
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', DAEMON_AGENT_NAME),
    inflight: join(ctxRoot, 'inflight', DAEMON_AGENT_NAME),
    processed: join(ctxRoot, 'processed', DAEMON_AGENT_NAME),
    logDir: join(ctxRoot, 'logs', DAEMON_AGENT_NAME),
    stateDir: join(ctxRoot, 'state', DAEMON_AGENT_NAME),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  };
}
