import type { EventCategory, EventSeverity } from '../types/index.js';
import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';

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
  instanceId: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown>,
): void {
  try {
    const paths = resolvePaths(DAEMON_AGENT_NAME, instanceId, org);
    // Ensure the path is rooted at our actual ctxRoot (resolvePaths derives
    // it from homedir()+instanceId — equivalent in production but worth
    // pinning explicitly for tests that override ctxRoot).
    paths.ctxRoot = ctxRoot;
    paths.analyticsDir = org
      ? `${ctxRoot}/orgs/${org}/analytics`
      : `${ctxRoot}/analytics`;
    paths.stateDir = `${ctxRoot}/state/${DAEMON_AGENT_NAME}`;
    logEvent(paths, DAEMON_AGENT_NAME, org, category, eventName, severity, metadata);
  } catch (err) {
    console.error(`[daemon-event-logger] non-fatal: ${(err as Error).message}`);
  }
}
