import { Pool, type PoolClient } from 'pg';

/**
 * Δ1 (Phase 2e) — Postgres-backed spawn lease, reworked per Sam HOLD 2026-05-17.
 *
 * Replaces the file-based per-agent lock used in the daemon spawn path AND
 * the new direct-spawn lease helper used by persistent Opus agents (per
 * .claude/rules/codex-subagent-direct-spawn.md G1).
 *
 * Identity model (vs v1 of this module):
 *   was:  lease per (project_id, agent_name)
 *   now:  lease per ACTIVE (project_id, artifact_key); released rows
 *         drop out of the partial unique index. lease_id (bigserial) is
 *         the renew/release handle so callers don't re-supply the composite
 *         key on every heartbeat.
 *
 * Atomicity guarantee: acquire is a single INSERT ... ON CONFLICT against
 * the partial unique index `spawn_leases_active_artifact_uniq`. Two
 * concurrent first-acquires against the same fresh slot serialize at the
 * index — one wins via INSERT, the other goes through DO UPDATE and reads
 * the existing row as the "current holder". See migration 0003 acquire
 * function for the CASE-per-column logic.
 *
 * Why pg and not supabase-js: the cortextos schema is NOT exposed via
 * PostgREST (intentional — service-role-only per top-g 2026-05-17 signoff).
 * Direct pg over the pooled connection string sidesteps PostgREST entirely.
 *
 * Required env (loaded from /root/cortextos/orgs/1evo/secrets.env in
 * production; caller must source before invocation):
 *   - SUPABASE_GBRAIN_DATABASE_URL
 */

export interface SpawnLease {
  id: number;                  // surrogate PK; used by renew / release
  project_id: string | null;
  artifact_key: string;
  task_class: string;
  holder_id: string;
  acquired_at: string;         // ISO 8601
  expires_at: string;
  ttl_seconds: number;
  reason: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AcquireResult {
  /** True iff this caller now holds the lease. Caller MUST branch on this. */
  acquired: boolean;
  /** The current row in the table — may be held by someone else when acquired=false. */
  lease: SpawnLease;
}

export interface ListFilter {
  projectId?: string | null;
  artifactKey?: string;
  taskClass?: string;
  holderId?: string;
  /** 'active' = released_at IS NULL (default); 'released' = NOT NULL; 'all' = both. */
  state?: 'active' | 'released' | 'all';
}

let cachedPool: Pool | null = null;

/**
 * Lazy singleton pg Pool. Verified TLS (rejectUnauthorized=true) against the
 * Supabase pooler chain — Supabase certs are publicly-trusted, so the system
 * trust store validates them without a custom CA bundle.
 *
 * If a deployment hits cert-validation issues (e.g. an outdated trust store
 * or a non-standard Supabase pooler), set PGSSL_NO_VERIFY=1 explicitly to
 * downgrade. We do NOT default to insecure TLS — that was the v1 mistake
 * Sam flagged as CONCERN 2.
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

  const insecure = process.env.PGSSL_NO_VERIFY === '1';

  cachedPool = new Pool({
    connectionString: connStr,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Verified TLS by default. PGSSL_NO_VERIFY=1 is the explicit escape hatch.
    ssl: insecure ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  });
  return cachedPool;
}

/** Inject a pool (tests / alt hosts). Null clears so next call rebuilds. */
export function setPgPool(pool: Pool | null): void {
  cachedPool = pool;
}

/** Tear down the cached pool. Call on process shutdown / CLI exit. */
export async function closePgPool(): Promise<void> {
  if (cachedPool) {
    const p = cachedPool;
    cachedPool = null;
    await p.end();
  }
}

/**
 * Normalize a pg row into the ISO-string SpawnLease shape so JSON.stringify
 * produces stable output across local/CI/prod.
 */
function normalizeLease(row: Record<string, unknown>): SpawnLease {
  const toIso = (v: unknown): string => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') return v;
    throw new Error(`spawn-claim: expected Date/string, got ${typeof v}`);
  };
  const toIsoNullable = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    return toIso(v);
  };
  return {
    id: typeof row.id === 'number' ? row.id : Number(row.id),
    project_id: (row.project_id as string | null) ?? null,
    artifact_key: row.artifact_key as string,
    task_class: row.task_class as string,
    holder_id: row.holder_id as string,
    acquired_at: toIso(row.acquired_at),
    expires_at: toIso(row.expires_at),
    ttl_seconds: row.ttl_seconds as number,
    reason: (row.reason as string | null) ?? null,
    released_at: toIsoNullable(row.released_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export interface AcquireOpts {
  projectId: string | null;
  artifactKey: string;
  taskClass: string;
  holderId: string;
  ttlSeconds?: number;
  reason?: string | null;
}

/**
 * Attempt to acquire the active lease for (projectId, artifactKey).
 *
 * Semantics (enforced by cortextos.acquire_spawn_lease, atomic INSERT ON CONFLICT):
 *   - No active row → insert; caller wins.
 *   - Active row, same holder → slide expires_at, keep acquired_at; caller wins.
 *   - Active row, expired → steal (rewrite holder/acquired_at/expires_at); caller wins.
 *   - Active row, different live holder → no-op; caller LOSES.
 *
 * Returns { acquired, lease }. The lease row is ALWAYS populated — branch on
 * `acquired` to decide. lease.id is the handle for renew/release.
 */
export async function acquireSpawnLease(opts: AcquireOpts): Promise<AcquireResult> {
  const {
    projectId, artifactKey, taskClass, holderId,
    ttlSeconds = 90, reason = null,
  } = opts;
  const pool = getPgPool();
  const { rows } = await pool.query(
    'select * from cortextos.acquire_spawn_lease($1, $2, $3, $4, $5, $6)',
    [projectId, artifactKey, taskClass, holderId, ttlSeconds, reason],
  );
  if (rows.length === 0) {
    throw new Error('spawn-claim acquire returned no row');
  }
  const lease = normalizeLease(rows[0]);
  return { acquired: lease.holder_id === holderId, lease };
}

/**
 * Slide expires_at forward by ttlSeconds. Returns the refreshed lease on
 * success, null when caller no longer holds a live active lease.
 */
export async function renewSpawnLease(
  leaseId: number,
  holderId: string,
  ttlSeconds = 90,
): Promise<SpawnLease | null> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    'select * from cortextos.renew_spawn_lease($1, $2, $3)',
    [leaseId, holderId, ttlSeconds],
  );
  if (rows.length === 0) return null;
  // The composite-return function emits one row of NULLs when no UPDATE
  // matched; detect via id nullity.
  if (rows[0].id === null || rows[0].id === undefined) return null;
  return normalizeLease(rows[0]);
}

/**
 * Soft-release the lease IFF caller still holds it. Returns true on release,
 * false on no-op (already released / not your lease / lease_id gone).
 * Idempotent — safe to call multiple times.
 */
export async function releaseSpawnLease(
  leaseId: number,
  holderId: string,
): Promise<boolean> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    'select cortextos.release_spawn_lease($1, $2) as released',
    [leaseId, holderId],
  );
  return rows[0]?.released === true;
}

/**
 * Mass-release: soft-deletes every active lease held by `holderId`. Used by
 * session stop hooks so a dying parent doesn't strand its claims. Returns
 * the count of leases released.
 */
export async function releaseSessionLeases(holderId: string): Promise<number> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    'select cortextos.release_session_leases($1) as released',
    [holderId],
  );
  return (rows[0]?.released as number) ?? 0;
}

/**
 * List leases with optional filters. Default `state='active'` returns only
 * unreleased rows; pass 'released' for tombstones, 'all' for both. Rows are
 * sorted by (project_id NULLS FIRST, artifact_key, acquired_at).
 */
export async function listSpawnLeases(filter: ListFilter = {}): Promise<SpawnLease[]> {
  const pool = getPgPool();
  const state = filter.state ?? 'active';
  const conds: string[] = [];
  const args: unknown[] = [];

  if (state === 'active')   conds.push('released_at is null');
  if (state === 'released') conds.push('released_at is not null');
  // 'all' adds nothing.

  if (filter.projectId !== undefined) {
    if (filter.projectId === null) {
      conds.push('project_id is null');
    } else {
      args.push(filter.projectId);
      conds.push(`project_id = $${args.length}`);
    }
  }
  if (filter.artifactKey !== undefined) {
    args.push(filter.artifactKey);
    conds.push(`artifact_key = $${args.length}`);
  }
  if (filter.taskClass !== undefined) {
    args.push(filter.taskClass);
    conds.push(`task_class = $${args.length}`);
  }
  if (filter.holderId !== undefined) {
    args.push(filter.holderId);
    conds.push(`holder_id = $${args.length}`);
  }

  const where = conds.length ? `where ${conds.join(' and ')}` : '';
  const { rows } = await pool.query(
    `select * from cortextos.spawn_leases ${where}
     order by project_id nulls first, artifact_key, acquired_at`,
    args,
  );
  return rows.map(normalizeLease);
}

/**
 * Sweep tombstones + stale-expired rows older than 24h. Returns the count
 * purged. Active rows are never touched even past their TTL — acquire
 * handles those via the steal branch.
 */
export async function expireSpawnLeases(): Promise<number> {
  const pool = getPgPool();
  const { rows } = await pool.query('select cortextos.expire_spawn_leases() as purged');
  return (rows[0]?.purged as number) ?? 0;
}

/**
 * Run a callback with a dedicated client checked out from the pool — for
 * tests that need to wrap multiple ops in a transaction. Production lease
 * ops do NOT need this; each SQL function is internally atomic.
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
