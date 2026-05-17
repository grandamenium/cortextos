import {
  acquireSpawnLease,
  renewSpawnLease,
  releaseSessionLeases,
  listSpawnLeases,
  type SpawnLease,
} from '../bus/spawn-claim.js';

/**
 * Δ1 (Phase 2e) — Daemon-side spawn-lease coordinator.
 *
 * Encapsulates the acquire → renew → release lifecycle so agent-manager only
 * adds a handful of call sites. Per v3 §1 Δ1 + .claude/rules/codex-subagent-
 * direct-spawn.md G1: every agent spawn MUST hold an active lease on
 * (project_id, artifact_key='agent:<name>') for the duration of the
 * agent's life. Two daemons racing to start the same agent serialize at
 * the Postgres partial unique index.
 *
 * Identity model:
 *   - artifact_key = `agent:<agentName>`            (the contended slot)
 *   - task_class   = `spawn`                        (G1 telemetry classifier)
 *   - holder_id    = `daemon-spawn:<instanceId>:<agentName>`
 *                                                   (per-agent so stopAgent
 *                                                    can mass-release via
 *                                                    releaseSessionLeases
 *                                                    without touching other
 *                                                    agents on the same daemon)
 *
 * Renew cadence: NOT piggybacked on FastChecker (50-min heartbeat tick
 * exceeds the 30-min default TTL half-life). Separate setInterval at 10-min
 * cadence so the lease slides ~3x per TTL window — comfortable headroom
 * for one missed beat.
 *
 * Failure mode: if SUPABASE_GBRAIN_DATABASE_URL is unset (dev box,
 * legacy CI, smoke harness without Supabase), the coordinator is disabled
 * and acquireAgentSpawn returns a synthetic acquired=true so the daemon
 * starts agents as before. Visible warn log on construction.
 */

export type LeaseEventName =
  | 'spawn_lease_acquired'
  | 'spawn_rejected'
  | 'spawn_lease_renewed'
  | 'spawn_lease_expired'
  | 'spawn_lease_released';

/** Matches src/types/index.ts EventSeverity. 'warning' (not 'warn'). */
export type LeaseEventSeverity = 'info' | 'warning' | 'error';

export type LeaseEventEmitter = (
  agentName: string,
  eventName: LeaseEventName,
  severity: LeaseEventSeverity,
  meta: Record<string, unknown>,
  projectId: string | null,
) => void;

export interface AcquireAgentSpawnResult {
  acquired: boolean;
  /** Holder used for the acquire — caller logs this for the audit trail. */
  holderId: string;
  /** Underlying lease row when acquired=true OR contested. null only when coordinator is disabled. */
  lease: SpawnLease | null;
}

interface ActiveLease {
  leaseId: number;
  holderId: string;
  projectId: string | null;
  timer: NodeJS.Timeout;
  renewCount: number;
}

const DEFAULT_TTL_SECONDS = 30 * 60;     // 30min — matches G1 default
const DEFAULT_RENEW_MS    = 10 * 60_000; // 10min — 3x renews per TTL
const ARTIFACT_PREFIX     = 'agent:';
const TASK_CLASS          = 'spawn';

export class SpawnLeaseCoordinator {
  private readonly enabled: boolean;
  private readonly leases = new Map<string, ActiveLease>();

  constructor(
    private readonly instanceId: string,
    private readonly emit: LeaseEventEmitter,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
    private readonly renewIntervalMs: number = DEFAULT_RENEW_MS,
  ) {
    this.enabled = !!process.env.SUPABASE_GBRAIN_DATABASE_URL;
    if (!this.enabled) {
      console.warn(
        '[spawn-lease-coordinator] SUPABASE_GBRAIN_DATABASE_URL not set — ' +
        'lease coordination DISABLED. Daemon-level spawn fencing will be a no-op. ' +
        'Set the env var to enable cross-daemon serialization.',
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Pre-spawn lease acquire. Caller MUST branch on `acquired`:
   *   - acquired=true  → proceed with agent startup; renew loop is now running
   *   - acquired=false → another daemon holds the slot; abort startup
   *
   * When disabled (no DB url), always returns acquired=true with lease=null.
   */
  async acquireAgentSpawn(
    agentName: string,
    projectId: string | null,
  ): Promise<AcquireAgentSpawnResult> {
    const holderId = `daemon-spawn:${this.instanceId}:${agentName}`;
    const artifactKey = `${ARTIFACT_PREFIX}${agentName}`;

    if (!this.enabled) {
      return { acquired: true, holderId, lease: null };
    }

    // Best-effort prior-holder lookup. v3 §1 Δ1 (line 57) requires
    // `spawn_lease_expired` to fire on the PREVIOUS holder's side when their
    // lease gets stolen via the SQL function's TTL-expiry steal branch.
    // The renew loop on the prior daemon only notices later (or never, if
    // the daemon is hung/dead) — without this preflight, the previous
    // holder's lease can vanish with no event.
    //
    // List is best-effort observability: failures are silently swallowed so
    // a transient DB blip doesn't block the acquire that follows. The window
    // between list and acquire (race: prior holder voluntarily releases, or
    // a third daemon races us) is acceptable — the event semantics are
    // "someone was here, now they aren't, and we won the slot."
    let priorHolder: SpawnLease | null = null;
    try {
      const priors = await listSpawnLeases({
        projectId,
        artifactKey,
        state: 'active',
      });
      const other = priors.find((l) => l.holder_id !== holderId);
      if (other) priorHolder = other;
    } catch {
      // observability-only; never block acquire
    }

    // Defensive: never let a transient DB blip take the daemon down. Surface
    // the failure as a warn event but fail-open so the agent still starts.
    // The alternative (fail-closed) would block the whole fleet on a single
    // Supabase outage — strictly worse than running unfenced for a window.
    let result;
    try {
      result = await acquireSpawnLease({
        projectId,
        artifactKey,
        taskClass: TASK_CLASS,
        holderId,
        ttlSeconds: this.ttlSeconds,
        reason: `daemon-spawn:${this.instanceId}`,
      });
    } catch (err) {
      this.emit(agentName, 'spawn_lease_expired', 'warning', {
        reason: 'acquire_threw',
        error: err instanceof Error ? err.message : String(err),
        artifact: artifactKey,
        by: `daemon-spawn:${this.instanceId}`,
      }, projectId);
      // Fail-open so the daemon stays useful when Supabase is unreachable.
      return { acquired: true, holderId, lease: null };
    }

    if (result.acquired) {
      // Previous-holder visibility event: if a different-identity holder was
      // present pre-acquire and we now hold the slot, their lease was stolen
      // via the SQL steal branch (TTL-expired active row → rewrite). Emit
      // BEFORE spawn_lease_acquired so the event log reads "A's expired,
      // then B took it" in causal order.
      if (priorHolder && priorHolder.holder_id !== holderId) {
        this.emit(agentName, 'spawn_lease_expired', 'warning', {
          reason: 'stolen_by_liveness',
          lease_id: priorHolder.id,
          prior_holder: priorHolder.holder_id,
          prior_acquired_at: priorHolder.acquired_at,
          prior_expires_at: priorHolder.expires_at,
          artifact: artifactKey,
          stolen_by: holderId,
        }, projectId);
      }

      this.startRenewLoop(agentName, result.lease.id, holderId, projectId);
      this.emit(agentName, 'spawn_lease_acquired', 'info', {
        lease_id: result.lease.id,
        artifact: artifactKey,
        holder: holderId,
        expires_at: result.lease.expires_at,
        ttl_seconds: this.ttlSeconds,
        by: `daemon-spawn:${this.instanceId}`,
      }, projectId);
    } else {
      this.emit(agentName, 'spawn_rejected', 'warning', {
        reason: 'lock-held',
        artifact: artifactKey,
        held_by: result.lease.holder_id,
        held_until: result.lease.expires_at,
        by: `daemon-spawn:${this.instanceId}`,
      }, projectId);
    }

    return { acquired: result.acquired, holderId, lease: result.lease };
  }

  /**
   * Release the daemon's lease on `agentName`. Idempotent — safe to call
   * even if no lease was held (e.g. acquire failed mid-startup). Stops the
   * renew loop unconditionally.
   *
   * Uses releaseSessionLeases(holderId) per top-g directive #4: mass-release
   * by session id so a daemon hosting multiple artifacts under the same
   * holder (e.g. future per-agent secondary leases) frees them together.
   */
  async releaseAgentSpawn(agentName: string): Promise<void> {
    const entry = this.leases.get(agentName);
    if (!entry) return;
    clearInterval(entry.timer);
    this.leases.delete(agentName);

    if (!this.enabled) return;

    try {
      const released = await releaseSessionLeases(entry.holderId);
      this.emit(agentName, 'spawn_lease_released', 'info', {
        lease_id: entry.leaseId,
        holder: entry.holderId,
        released_count: released,
        by: `daemon-spawn:${this.instanceId}`,
      }, entry.projectId);
    } catch (err) {
      // Release failure is logged but not thrown — the in-memory entry is
      // already gone, and the lease TTL will reap the row server-side.
      this.emit(agentName, 'spawn_lease_released', 'warning', {
        lease_id: entry.leaseId,
        holder: entry.holderId,
        error: err instanceof Error ? err.message : String(err),
        by: `daemon-spawn:${this.instanceId}`,
      }, entry.projectId);
    }
  }

  /** Release every active lease. Called from daemon shutdown paths. */
  async releaseAll(): Promise<void> {
    const names = [...this.leases.keys()];
    await Promise.all(names.map((n) => this.releaseAgentSpawn(n)));
  }

  /** Test introspection — returns the in-memory holder id for an agent. */
  getHolderId(agentName: string): string | null {
    return this.leases.get(agentName)?.holderId ?? null;
  }

  /** Test introspection — returns the lease id currently held. */
  getLeaseId(agentName: string): number | null {
    return this.leases.get(agentName)?.leaseId ?? null;
  }

  /** Test introspection — count of currently-held leases. */
  size(): number {
    return this.leases.size;
  }

  private startRenewLoop(
    agentName: string,
    leaseId: number,
    holderId: string,
    projectId: string | null,
  ): void {
    const tick = async (): Promise<void> => {
      try {
        const renewed = await renewSpawnLease(leaseId, holderId, this.ttlSeconds);
        if (!renewed) {
          // Renew returned null = lease no longer ours (stolen via TTL
          // expiry + another daemon's acquire). Stop the loop. The next
          // FastChecker tick / heartbeat won't notice; if the agent is
          // still alive on this daemon it's running unfenced until stop.
          this.emit(agentName, 'spawn_lease_expired', 'warning', {
            reason: 'renew_returned_null',
            lease_id: leaseId,
            holder: holderId,
            by: `daemon-spawn:${this.instanceId}`,
          }, projectId);
          const entry = this.leases.get(agentName);
          if (entry) {
            clearInterval(entry.timer);
            this.leases.delete(agentName);
          }
          return;
        }
        const entry = this.leases.get(agentName);
        if (entry) {
          entry.renewCount += 1;
          // Sample renewed events 1-of-10 to keep the event stream lean
          // while preserving observability into liveness.
          if (entry.renewCount % 10 === 1) {
            this.emit(agentName, 'spawn_lease_renewed', 'info', {
              lease_id: leaseId,
              holder: holderId,
              expires_at: renewed.expires_at,
              renew_count: entry.renewCount,
              sample: '1-of-10',
              by: `daemon-spawn:${this.instanceId}`,
            }, projectId);
          }
        }
      } catch (err) {
        this.emit(agentName, 'spawn_lease_expired', 'warning', {
          reason: 'renew_threw',
          error: err instanceof Error ? err.message : String(err),
          lease_id: leaseId,
          holder: holderId,
          by: `daemon-spawn:${this.instanceId}`,
        }, projectId);
        // Don't stop the loop on a transient throw — the next tick may
        // recover (DB reconnect, transient network). The lease will TTL
        // out server-side if the throw persists past 30min.
      }
    };

    const timer = setInterval(() => { void tick(); }, this.renewIntervalMs);
    // Don't keep the event loop alive solely on this timer — daemon
    // shutdown drains via releaseAll.
    timer.unref();

    this.leases.set(agentName, {
      leaseId,
      holderId,
      projectId,
      timer,
      renewCount: 0,
    });
  }
}
