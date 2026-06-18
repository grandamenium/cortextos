/**
 * Fleet-wide spawn-failure alert dedup (gen-B / posix_spawnp exhaustion).
 *
 * The overnight cascade would have produced ~42 alert candidates (14 agents ×
 * 3 retries). The operator must get ONE alert per failure-CLASS per window,
 * naming HOW MANY agents are affected — not per-agent, per-retry spam. If the
 * class persists into a later window, re-alert with the escalating cumulative
 * picture so a sustained outage stays visible without flooding.
 *
 * Usage: call recordSpawnFailure() each time an agent exhausts its spawn
 * retries; call collectPendingAlerts() at a natural batch boundary (end of
 * discoverAndStart, and after a runtime spawn-failure) to drain at most one
 * alert per class per window.
 */

export const SPAWN_ALERT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface SpawnFailureAlert {
  failureClass: string;
  /** Distinct agents that failed with this class in the current window. */
  affectedCount: number;
  agents: string[];
  /** 1-based window number for this class — escalation counter for a persistent outage. */
  windowNumber: number;
}

interface ClassState {
  agents: Set<string>;
  windowStart: number;
  alerted: boolean;
  windowNumber: number;
}

const state = new Map<string, ClassState>();

/** Test/reset hook — clears all tracked classes. */
export function _resetSpawnFailureAlerter(): void {
  state.clear();
}

/**
 * Record that `agentName` exhausted its spawn retries with `failureClass`
 * (e.g. 'posix_spawnp'). Rolls the window if the prior one has elapsed.
 */
export function recordSpawnFailure(agentName: string, failureClass: string, now: number = Date.now()): void {
  let s = state.get(failureClass);
  if (!s || now - s.windowStart >= SPAWN_ALERT_WINDOW_MS) {
    s = {
      agents: new Set(),
      windowStart: now,
      alerted: false,
      windowNumber: (s?.windowNumber ?? 0) + 1,
    };
    state.set(failureClass, s);
  }
  s.agents.add(agentName);
}

/**
 * Drain at most ONE alert per failure-class: returns an alert for every class
 * that has recorded failures in its current window but has not yet been
 * alerted, marking them alerted so the window won't re-fire. Call at batch
 * boundaries; window roll-over (15min) re-arms a class for re-alert.
 */
export function collectPendingAlerts(now: number = Date.now()): SpawnFailureAlert[] {
  const out: SpawnFailureAlert[] = [];
  for (const [failureClass, s] of state) {
    if (now - s.windowStart >= SPAWN_ALERT_WINDOW_MS) continue; // stale window; next record rolls it
    if (s.alerted || s.agents.size === 0) continue;
    s.alerted = true;
    out.push({
      failureClass,
      affectedCount: s.agents.size,
      agents: [...s.agents],
      windowNumber: s.windowNumber,
    });
  }
  return out;
}

/** Human-readable operator alert text for a drained alert. */
export function formatSpawnFailureAlert(a: SpawnFailureAlert): string {
  const escalation = a.windowNumber > 1 ? ` (window #${a.windowNumber} — outage persisting)` : '';
  const names = a.agents.slice(0, 8).join(', ') + (a.agents.length > 8 ? `, +${a.agents.length - 8} more` : '');
  return (
    `🚨 SPAWN-FAILED: ${a.affectedCount} agent(s) could not spawn${escalation}\n` +
    `Class: ${a.failureClass} (likely OS process/resource exhaustion)\n` +
    `Agents: ${names}\n` +
    `These agents are NOT running despite any earlier "Running" log. Next alert in ~15m if it persists.`
  );
}
