/**
 * BL-2026-05-08-003 phase 3 — atomic profile-failover primitive.
 *
 * Boss-LLM detects `profile_quota_exhausted` events on its loop and
 * invokes this primitive to:
 *   1. Validate the target's `fallback_profile` exists in the registry
 *   2. Cascade-prevent: skip if the target profile recently emitted
 *      `profile_quota_exhausted` itself within a 30-minute window
 *   3. Atomically swap `claude_profile` → `fallback_profile` in the
 *      target agent's `config.json` (write-temp-then-rename so a
 *      crash mid-flight leaves config.json intact)
 *   4. Emit a `profile_failover` audit event with full provenance
 *   5. Send a soft-restart message to the target agent on the bus
 *
 * The TS layer owns the deterministic mechanics; the SKILL.md
 * runbook owns the LLM judgment (which agent, when, why). Splitting
 * this way keeps the failover primitive idempotent and unit-testable
 * without depending on an LLM in the loop.
 *
 * Failover is by definition cold-boot — Claude Code's session state
 * is per-config-dir, `--continue` won't work across accounts.
 *
 * Errors propagate as `FailoverError` with a `reason` enum so the
 * caller (CLI command) can format user-facing messages without
 * inspecting the message string.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';

import { loadProfileRegistry } from '../utils/profiles.js';
import type { AgentConfig } from '../types/index.js';

/** Cascade-prevention window — see step 2 above and spec §"Edge cases". */
export const CASCADE_WINDOW_MS = 30 * 60 * 1000;

export type FailoverErrorReason =
  | 'agent_dir_missing'
  | 'config_unreadable'
  | 'no_fallback_configured'
  | 'registry_missing'
  | 'fallback_profile_unknown'
  | 'cascade_window_active'
  | 'config_write_failed'
  | 'already_on_fallback';

export class FailoverError extends Error {
  constructor(public reason: FailoverErrorReason, message: string) {
    super(message);
    this.name = 'FailoverError';
  }
}

export interface FailoverOptions {
  /** Path to the project root (the cortextos-fork checkout). */
  projectRoot: string;
  /** Org slug; used to locate `orgs/<org>/agents/<agentName>` and `profiles.json`. */
  org: string;
  /** Target agent whose profile we're swapping. */
  agentName: string;
  /** Bus-event id of the triggering `profile_quota_exhausted` event,
   *  threaded into the audit row for provenance. */
  triggerEventId: string;
  /** cortextOS instance id — locates the analytics events tree. */
  instanceId?: string;
  /** Override the wall-clock — tests inject a fixed instant. */
  now?: Date;
  /** Override the bus-emit shell-out — tests inject a recorder. */
  emit?: (eventName: string, severity: string, meta: Record<string, unknown>) => void;
  /** Override the cascade-window detector — tests inject a stub. */
  recentExhaustionFor?: (profile: string, agentDir: string) => boolean;
  /** Override the soft-restart dispatcher — tests inject a recorder. */
  sendRestart?: (agent: string, reason: string) => void;
  /** Override the analytics events root — tests point at tmp; production
   *  resolves to `~/.cortextos/<instanceId>/orgs/<org>/analytics/events`.
   *  See `src/utils/paths.ts:46` for the canonical layout. */
  analyticsEventsRoot?: string;
}

export interface FailoverResult {
  agent: string;
  from_profile: string | null;
  to_profile: string;
  trigger_event_id: string;
  restarted_at: string;
}

/**
 * Run the failover. Returns the FailoverResult on success;
 * throws `FailoverError` on any guard rejection (caller formats
 * the user-facing message based on `error.reason`).
 *
 * Idempotency note: the audit-event keying lives in the boss
 * runbook (the SKILL.md), not here — this primitive is a single-
 * shot atomic operation. A second call with the same triggerEventId
 * will run the swap again (potentially flipping from fallback back
 * to original if `claude_profile` was already updated). Callers
 * MUST gate by trigger-event-id before calling.
 */
export function runFailover(opts: FailoverOptions): FailoverResult {
  const now = opts.now ?? new Date();
  const agentDir = join(opts.projectRoot, 'orgs', opts.org, 'agents', opts.agentName);
  if (!existsSync(agentDir)) {
    throw new FailoverError(
      'agent_dir_missing',
      `Agent directory not found: ${agentDir}`,
    );
  }

  const configPath = join(agentDir, 'config.json');
  let config: AgentConfig & { agent_name?: string };
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new FailoverError(
      'config_unreadable',
      `${configPath}: ${(err as Error).message}`,
    );
  }

  const fallback = config.fallback_profile;
  if (!fallback) {
    throw new FailoverError(
      'no_fallback_configured',
      `Agent ${opts.agentName} has no fallback_profile set; manual intervention required`,
    );
  }

  const registry = loadProfileRegistry(opts.projectRoot, opts.org);
  if (!registry) {
    throw new FailoverError(
      'registry_missing',
      `orgs/${opts.org}/profiles.json missing or malformed`,
    );
  }
  if (!(fallback in registry.profiles)) {
    throw new FailoverError(
      'fallback_profile_unknown',
      `fallback_profile "${fallback}" not in orgs/${opts.org}/profiles.json`,
    );
  }

  // Idempotency at the call site: if the agent is ALREADY on the
  // fallback profile, treat this as already-actioned and reject.
  // Without this, a second invocation with the same trigger event
  // (boss session restart loses session-scoped trigger-id state)
  // would flip the agent BACK to its original profile — exactly
  // the wrong recovery shape. Boss runbook still tracks
  // session-scoped trigger IDs as a first-line gate; this is the
  // belt-and-suspenders second-line gate at the primitive itself.
  if (config.claude_profile === fallback) {
    throw new FailoverError(
      'already_on_fallback',
      `Agent ${opts.agentName} is already on profile "${fallback}"; failover is a no-op`,
    );
  }

  // Cascade prevention: don't fail OVER to a profile that recently
  // exhausted itself. Without this, a mass-quota incident (Anthropic
  // platform issue affecting all accounts) would round-robin agents
  // through every profile instead of stopping for human triage.
  const recentlyExhausted = opts.recentExhaustionFor
    ? opts.recentExhaustionFor(fallback, agentDir)
    : recentExhaustionForFromBus(
        fallback,
        opts.analyticsEventsRoot ?? defaultAnalyticsEventsRoot(opts.org, opts.instanceId),
        now,
      );
  if (recentlyExhausted) {
    throw new FailoverError(
      'cascade_window_active',
      `Target profile "${fallback}" emitted profile_quota_exhausted within the last ${CASCADE_WINDOW_MS / 60000} min; manual triage required`,
    );
  }

  const fromProfile = config.claude_profile ?? null;
  const updated: AgentConfig & { agent_name?: string } = {
    ...config,
    claude_profile: fallback,
  };

  // Atomic write: temp-then-rename so a crash mid-flight leaves the
  // existing config.json intact (rename(2) is atomic on POSIX same-fs).
  // Same temp-pattern as `cron-management/state-write` in the daemon.
  // On rename failure, the .tmp file is cleaned up so a partial-write
  // doesn't leave stale state on disk for the next run to inherit.
  const tmpPath = configPath + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, configPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* tmp may not have been created — best-effort */ }
    throw new FailoverError(
      'config_write_failed',
      `Failed to update ${configPath}: ${(err as Error).message}`,
    );
  }

  const restartedAt = now.toISOString();
  const result: FailoverResult = {
    agent: opts.agentName,
    from_profile: fromProfile,
    to_profile: fallback,
    trigger_event_id: opts.triggerEventId,
    restarted_at: restartedAt,
  };

  // Emit the audit event — the bus row links the failover back to
  // the triggering event so the analyst's audit-of-the-audit can
  // correlate. Best-effort: we just successfully wrote the new
  // config; an emit failure must NOT roll the swap back.
  const emit = opts.emit ?? defaultEmit;
  emit('profile_failover', 'warning', { ...result });

  // Soft-restart the target. Reuses the existing bus send-message
  // flow (spec §6 step 4): boss has authority via send-message;
  // the receiving agent's heartbeat / restart skill picks up the
  // "soft-restart" message and re-execs.
  const sendRestart = opts.sendRestart ?? defaultSendRestart;
  sendRestart(
    opts.agentName,
    `profile-failover: ${fromProfile ?? '(default)'} → ${fallback} (trigger=${opts.triggerEventId})`,
  );

  return result;
}

/**
 * Default cascade-prevention check: scan the analytics event log for
 * any `profile_quota_exhausted` event whose metadata names the
 * target profile and whose timestamp is within CASCADE_WINDOW_MS of
 * `now`. Walks every agent's per-day file under `eventsRoot` —
 * the event is per-AGENT but a quota-exhaust on profile X means the
 * profile itself is unhealthy regardless of which agent surfaced it.
 *
 * `eventsRoot` resolves to
 *   `~/.cortextos/<instance>/orgs/<org>/analytics/events`
 * via `defaultAnalyticsEventsRoot` (matching `src/utils/paths.ts:46`).
 *
 * Best-effort: missing tree returns false (no cascade observed).
 * Boss can still proceed with the failover; the worst case is one
 * hop into a profile that's about to also fail, which logs another
 * `profile_quota_exhausted` event and leaves Saurav with a manual
 * triage to do — same outcome as if cascade-prevention had fired,
 * just one cycle later.
 */
function recentExhaustionForFromBus(
  profile: string,
  eventsRoot: string,
  now: Date,
): boolean {
  if (!existsSync(eventsRoot)) return false;
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoff = now.getTime() - CASCADE_WINDOW_MS;
  let agents: string[];
  try {
    agents = readdirSync(eventsRoot);
  } catch {
    return false;
  }
  for (const agent of agents) {
    for (const day of [today, yesterday]) {
      const file = join(eventsRoot, agent, `${day}.jsonl`);
      if (!existsSync(file)) continue;
      let lines: string[];
      try {
        // Cheap: 30 min of events is small. If a single agent's daily
        // log grows past a few MB, switch to a tail-only read.
        lines = readFileSync(file, 'utf-8').split('\n');
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line) continue;
        let row: { event?: string; metadata?: { profile?: string }; timestamp?: string };
        try {
          row = JSON.parse(line);
        } catch { continue; }
        if (row.event !== 'profile_quota_exhausted') continue;
        if (row.metadata?.profile !== profile) continue;
        if (!row.timestamp) continue;
        if (new Date(row.timestamp).getTime() >= cutoff) return true;
      }
    }
  }
  return false;
}

/**
 * Resolve the analytics events root the same way `src/utils/paths.ts:46`
 * does, but without dragging in `resolvePaths`'s instance-id validation
 * and per-agent slot — the failover primitive walks ALL agents' events
 * looking for `profile_quota_exhausted` rows, so it needs the org-level
 * dir, not an agent-scoped one.
 */
function defaultAnalyticsEventsRoot(org: string, instanceId?: string): string {
  return join(homedir(), '.cortextos', instanceId || 'default', 'orgs', org, 'analytics', 'events');
}

function defaultEmit(eventName: string, severity: string, meta: Record<string, unknown>): void {
  try {
    execFile(
      'cortextos',
      ['bus', 'log-event', 'action', eventName, severity, '--meta', JSON.stringify(meta)],
      { timeout: 5_000 },
      () => { /* fire-and-forget — async errors land here, deliberately swallowed */ },
    );
  } catch { /* never throw from the failover primitive */ }
}

function defaultSendRestart(agent: string, reason: string): void {
  try {
    execFile(
      'cortextos',
      ['bus', 'send-message', agent, 'high', `soft-restart: ${reason}`],
      { timeout: 5_000 },
      () => { /* fire-and-forget */ },
    );
  } catch { /* never throw */ }
}

