-- 0003_spawn_lease_functions.sql
-- Phase 2e (Δ1) — atomic lease functions on cortextos.spawn_leases.
--
-- Reworked per Sam's HOLD review 2026-05-17 BLOCK 2:
--   acquire is now a single INSERT ... ON CONFLICT against the partial
--   unique index `spawn_leases_active_artifact_uniq` — atomic against the
--   absent-row race that broke the original SELECT-FOR-UPDATE-then-INSERT.
--
-- Outputs follow the (acquired boolean, row) pair convention; the SQL
-- function returns a SETOF composite that the wrapper unpacks into
-- { acquired, lease }. Same shape as the original — only the inputs change.

-- ---------------------------------------------------------------------------
-- acquire_spawn_lease
--
-- Atomic insert-or-conditional-update against the active-row slot.
--
-- Semantics:
--   no active row              → INSERT, caller wins.
--   active row, same holder    → refresh expires_at + ttl_seconds + reason;
--                                keep acquired_at sticky. caller wins.
--   active row, expired        → steal: rewrite holder/acquired_at/expires_at.
--                                caller wins (note: row id stays the same
--                                because the row was never released).
--   active row, different live → no-op write-back; caller LOSES.
--                                Returned row.holder_id ≠ caller → acquired=false.
--
-- All three outcomes complete in a single SQL statement, so there is no
-- window for two concurrent callers to both believe they won.
-- ---------------------------------------------------------------------------
create or replace function cortextos.acquire_spawn_lease(
  p_project_id   text,
  p_artifact_key text,
  p_task_class   text,
  p_holder_id    text,
  p_ttl_seconds  integer default 90,
  p_reason       text default null
)
returns cortextos.spawn_leases
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row cortextos.spawn_leases;
begin
  -- Input validation.
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'ttl_seconds must be positive, got %', p_ttl_seconds;
  end if;
  if p_artifact_key is null or length(p_artifact_key) = 0 then
    raise exception 'artifact_key must be non-empty';
  end if;
  if p_task_class is null or length(p_task_class) = 0 then
    raise exception 'task_class must be non-empty';
  end if;
  if p_holder_id is null or length(p_holder_id) = 0 then
    raise exception 'holder_id must be non-empty';
  end if;

  -- Single-statement insert-or-conditional-update.
  -- The partial unique index spawn_leases_active_artifact_uniq is the
  -- conflict target; we name (project_id, artifact_key) WHERE released_at IS NULL
  -- to match it. Postgres detects partial-unique conflicts by inferring the
  -- predicate from the index — only one such index can match per ON CONFLICT.
  insert into cortextos.spawn_leases
    (project_id, artifact_key, task_class, holder_id,
     acquired_at, expires_at, ttl_seconds, reason)
  values
    (p_project_id, p_artifact_key, p_task_class, p_holder_id,
     v_now, v_now + make_interval(secs => p_ttl_seconds),
     p_ttl_seconds, p_reason)
  on conflict (project_id, artifact_key) where released_at is null
  do update set
    holder_id   = case
                    when cortextos.spawn_leases.holder_id = excluded.holder_id
                      then excluded.holder_id
                    when cortextos.spawn_leases.expires_at <= v_now
                      then excluded.holder_id
                    else cortextos.spawn_leases.holder_id
                  end,
    acquired_at = case
                    when cortextos.spawn_leases.holder_id = excluded.holder_id
                      then cortextos.spawn_leases.acquired_at   -- sticky
                    when cortextos.spawn_leases.expires_at <= v_now
                      then v_now                                  -- steal
                    else cortextos.spawn_leases.acquired_at
                  end,
    expires_at  = case
                    when cortextos.spawn_leases.holder_id = excluded.holder_id
                      then excluded.expires_at
                    when cortextos.spawn_leases.expires_at <= v_now
                      then excluded.expires_at
                    else cortextos.spawn_leases.expires_at
                  end,
    ttl_seconds = case
                    when cortextos.spawn_leases.holder_id = excluded.holder_id
                      then excluded.ttl_seconds
                    when cortextos.spawn_leases.expires_at <= v_now
                      then excluded.ttl_seconds
                    else cortextos.spawn_leases.ttl_seconds
                  end,
    task_class  = case
                    when cortextos.spawn_leases.holder_id = excluded.holder_id
                      then excluded.task_class
                    when cortextos.spawn_leases.expires_at <= v_now
                      then excluded.task_class
                    else cortextos.spawn_leases.task_class
                  end,
    reason      = case
                    when cortextos.spawn_leases.holder_id = excluded.holder_id
                      then coalesce(excluded.reason, cortextos.spawn_leases.reason)
                    when cortextos.spawn_leases.expires_at <= v_now
                      then excluded.reason
                    else cortextos.spawn_leases.reason
                  end
  returning * into v_row;

  -- Caller compares returned.holder_id to its own to detect win vs loss.
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- renew_spawn_lease(lease_id, holder_id, ttl_seconds)
--
-- Slides expires_at forward iff the caller still holds the lease AND it is
-- still active (released_at IS NULL) AND it has not yet expired. Returns
-- the refreshed lease row, or NULL row when the caller no longer holds it.
-- ---------------------------------------------------------------------------
create or replace function cortextos.renew_spawn_lease(
  p_lease_id    bigint,
  p_holder_id   text,
  p_ttl_seconds integer default 90
)
returns cortextos.spawn_leases
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row cortextos.spawn_leases;
begin
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'ttl_seconds must be positive, got %', p_ttl_seconds;
  end if;
  if p_holder_id is null or length(p_holder_id) = 0 then
    raise exception 'holder_id must be non-empty';
  end if;

  update cortextos.spawn_leases
  set expires_at  = v_now + make_interval(secs => p_ttl_seconds),
      ttl_seconds = p_ttl_seconds
  where id          = p_lease_id
    and holder_id   = p_holder_id
    and released_at is null
    and expires_at  > v_now
  returning * into v_row;

  return v_row;  -- NULL row when no match
end;
$$;

-- ---------------------------------------------------------------------------
-- release_spawn_lease(lease_id, holder_id)
--
-- Soft-deletes the lease (set released_at = now()) iff the caller is the
-- current holder AND the lease is still active. Returns true on release,
-- false on no-op. Idempotent.
-- ---------------------------------------------------------------------------
create or replace function cortextos.release_spawn_lease(
  p_lease_id  bigint,
  p_holder_id text
)
returns boolean
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_holder_id is null or length(p_holder_id) = 0 then
    raise exception 'holder_id must be non-empty';
  end if;

  update cortextos.spawn_leases
  set released_at = v_now
  where id          = p_lease_id
    and holder_id   = p_holder_id
    and released_at is null;

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- release_session_leases(holder_id)
--
-- Mass-release: soft-deletes EVERY active lease held by `holder_id`. Used by
-- session stop hooks so a dying parent agent doesn't strand its claims.
-- Returns the count of leases released.
-- ---------------------------------------------------------------------------
create or replace function cortextos.release_session_leases(
  p_holder_id text
)
returns integer
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_holder_id is null or length(p_holder_id) = 0 then
    raise exception 'holder_id must be non-empty';
  end if;

  update cortextos.spawn_leases
  set released_at = v_now
  where holder_id   = p_holder_id
    and released_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- expire_spawn_leases() — sweep helper.
--
-- HARD-deletes tombstones (released >24h ago) AND old expired-but-never-
-- released rows (>24h past expiry). Active rows are never touched even if
-- their TTL has elapsed — acquire takes care of those via the steal branch.
-- Returns the count purged.
-- ---------------------------------------------------------------------------
create or replace function cortextos.expire_spawn_leases()
returns integer
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  delete from cortextos.spawn_leases
  where (released_at is not null and released_at < v_now - interval '24 hours')
     or (released_at is null      and expires_at  < v_now - interval '24 hours');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Grants — service_role only (no anon/authenticated).
grant execute on function cortextos.acquire_spawn_lease(text, text, text, text, integer, text) to service_role;
grant execute on function cortextos.renew_spawn_lease(bigint, text, integer)                    to service_role;
grant execute on function cortextos.release_spawn_lease(bigint, text)                            to service_role;
grant execute on function cortextos.release_session_leases(text)                                 to service_role;
grant execute on function cortextos.expire_spawn_leases()                                        to service_role;
