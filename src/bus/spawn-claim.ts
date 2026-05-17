import { Pool, type PoolClient } from 'pg';

/**
 * Δ1 (Phase 2e) — Postgres-backed spawn lease.
 *
 * Replaces the file-based per-agent lock in the daemon spawn path. Lease
 * is keyed by (project_id, agent_name) where project_id may be NULL
 * (unscoped/fleet-wide) per B1 NULL-tolerant project_id conventions.
 *
 * Atomic operations are implemented as SQL functions in migration 0003
 * (cortextos.acquire_spawn_lease / release_spawn_lease /
 * heartbeat_spawn_lease / expire_spawn_leases). This module is a thin
 * pg-client wrapper — no client-side race logic.
 *
 * Why pg and not supabase-js: the cortextos schema is NOT exposed via
 * PostgREST (intentional — service-role-only per top-g 2026-05-17 signoff).
 * Direct pg connection over the Supabase pooled connection string
 * sidesteps PostgREST entirely.
 *
 * Required env (loaded from /root/cortextos/orgs/1evo/secrets.env in
 * production; caller must source before invocation):
 *   - SUPABASE_GBRAIN_DATABASE_URL
 */

export interface SpawnLease {
  project_id: string | null;
  agent_name: string;
  holder_id: string;
  acquired_at: string; // ISO 8601 (pg TIMESTAMPTZ → ISO via json serialization)
  expires_at: string;
  ttl_seconds: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AcquireResult {
  /** True iff THIS caller now holds the lease (current.holder_id === holder). */
  acquired: boolean;
  /** Whichever lease row is currently in the table — may be held by someone else. */
  lease: SpawnLease;
}

let cachedPool: Pool | null = null;

/**
 * Lazy singleton pg Pool. Reads SUPABASE_GBRAIN_DATABASE_URL from
 * process.env. Caller is responsible for sourcing secrets.env before
 * invocation.
 *
 * Why pooled: spawn-lease ops are short, frequent, called by the daemon
 * dispatcher on every spawn attempt. A pool amortizes TCP/TLS handshake
 * cost. Default max=10 connections is fine for the per-host daemon.
 *
 * For tests / alternate hosts, pass an override pool via `setPgPool`
 * instead of mutating env.
 */
export function getPgPool(): Pool {
  if (cachedPool) return cachedPool;

  const connStr = process.env.SUPABASE_GBRAIN_DATABASE_URL;
  if (!connStr) {
    throw new Error(
      'spawn-claim: SUPABASE_GBRAIN_DATABASE_URL must be set. ' +
      'Source /root/cortextos/orgs/1evo/secrets.env before calling.',
    );
  }

  cachedPool = new Pool({
    connectionString: connStr,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Supabase requires TLS; ssl=true uses the system trust store.
    ssl: { rejectUnauthorized: false },
  });
  return cachedPool;
}

/**
 * Inject an external pool (tests, alternate hosts). Set null to clear and
 * fall back to env-derived singleton on next call.
 */
export function setPgPool(pool: Pool | null): void {
  cachedPool = pool;
}

/**
 * Tear down the cached pool. Call on process shutdown to flush sockets.
 */
export async function closePgPool(): Promise<void> {
  if (cachedPool) {
    const p = cachedPool;
    cachedPool = null;
    await p.end();
  }
}

/**
 * Normalize a pg row (with Date objects on timestamptz columns) into the
 * ISO-string SpawnLease shape so JSON.stringify produces stable output
 * across local/CI/prod.
 */
function normalizeLease(row: Record<string, unknown>): SpawnLease {
  const toIso = (v: unknown): string => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') return v;
    throw new Error(`spawn-claim: expected Date/string, got ${typeof v}`);
  };
  return {
    project_id: (row.project_id as string | null) ?? null,
    agent_name: row.agent_name as string,
    holder_id: row.holder_id as string,
    acquired_at: toIso(row.acquired_at),
    expires_at: toIso(row.expires_at),
    ttl_seconds: row.ttl_seconds as number,
    reason: (row.reason as string | null) ?? null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/**
 * Attempt to acquire a lease for (projectId, agentName) on behalf of holder.
 *
 * Semantics (enforced by cortextos.acquire_spawn_lease):
 *   - No row exists → create, holder wins.
 *   - Live lease held by SAME holder → slide expires_at forward, holder wins.
 *   - Live lease held by DIFFERENT holder → no change, holder LOSES; returned
 *     lease.holder_id will not match holder.
 *   - Expired lease → steal regardless of prior holder, new caller wins.
 *
 * Returns { acquired, lease }. Caller checks `acquired` to branch — the
 * lease row is always populated (even on loss) so callers can log who is
 * currently holding it.
 */
export async function acquireSpawnLease(
  projectId: string | null,
  agentName: string,
  holderId: string,
  ttlSeconds: number = 90,
  reason: string | null = null,
): Promise<AcquireResult> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    'select * from cortextos.acquire_spawn_lease($1, $2, $3, $4, $5)',
    [projectId, agentName, holderId, ttlSeconds, reason],
  );
  if (rows.length === 0) {
    throw new Error('spawn-claim acquire returned no row');
  }
  const lease = normalizeLease(rows[0]);
  return { acquired: lease.holder_id === holderId, lease };
}

/**
 * Release the lease IFF the caller still holds it. Returns true on release,
 * false on no-op (caller never held it / already expired / row gone).
 * Idempotent — safe to call multiple times.
 */
export async function releaseSpawnLease(
  projectId: string | null,
  agentName: string,
  holderId: string,
): Promise<boolean> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    'select cortextos.release_spawn_lease($1, $2, $3) as released',
    [projectId, agentName, holderId],
  );
  return rows[0]?.released === true;
}

/**
 * Slide expires_at forward by ttlSeconds. Returns the refreshed lease on
 * success, null when caller no longer holds a live lease (expired / stolen
 * / different holder).
 */
export async function heartbeatSpawnLease(
  projectId: string | null,
  agentName: string,
  holderId: string,
  ttlSeconds: number = 90,
): Promise<SpawnLease | null> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    'select * from cortextos.heartbeat_spawn_lease($1, $2, $3, $4)',
    [projectId, agentName, holderId, ttlSeconds],
  );
  if (rows.length === 0) return null;
  // The function returns a composite row. When no match, pg may return a row
  // with all-null columns rather than zero rows — detect via agent_name nullity.
  if (rows[0].agent_name === null) return null;
  return normalizeLease(rows[0]);
}

/**
 * List leases. Optional filters apply on the server side. Returns rows
 * sorted by (project_id NULLS FIRST, agent_name) for deterministic output.
 */
export async function listSpawnLeases(
  filter: { agentName?: string; projectId?: string | null } = {},
): Promise<SpawnLease[]> {
  const pool = getPgPool();
  const conds: string[] = [];
  const args: unknown[] = [];
  if (filter.agentName !== undefined) {
    args.push(filter.agentName);
    conds.push(`agent_name = $${args.length}`);
  }
  if (filter.projectId !== undefined) {
    if (filter.projectId === null) {
      conds.push('project_id is null');
    } else {
      args.push(filter.projectId);
      conds.push(`project_id = $${args.length}`);
    }
  }
  const where = conds.length ? `where ${conds.join(' and ')}` : '';
  const { rows } = await pool.query(
    `select * from cortextos.spawn_leases ${where}
     order by project_id nulls first, agent_name`,
    args,
  );
  return rows.map(normalizeLease);
}

/**
 * Sweep expired rows. Returns the count purged. Housekeeping only — acquire
 * already treats expired-and-still-present rows as steal-able, so this does
 * not change correctness, just keeps the table small.
 */
export async function expireSpawnLeases(): Promise<number> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    'select cortextos.expire_spawn_leases() as purged',
  );
  return (rows[0]?.purged as number) ?? 0;
}

/**
 * Run a callback with a dedicated client checked out from the pool — useful
 * for tests that need to wrap multiple ops in a transaction. Production
 * lease ops do NOT need this because each SQL function is internally atomic.
 */
export async function withPgClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
