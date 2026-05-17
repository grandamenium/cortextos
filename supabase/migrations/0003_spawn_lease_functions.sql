-- 0003_spawn_lease_functions.sql
-- Phase 2e (Δ1) — atomic lease functions on cortextos.spawn_leases.
--
-- The acquire/release/heartbeat operations MUST be atomic at the database
-- layer; a naive SELECT-then-UPDATE race would let two daemons believe
-- they hold the same lease during the window. Functions wrap the atomic
-- INSERT ... ON CONFLICT logic so the client-side library can stay simple.
--
-- All functions are SECURITY INVOKER (default) — they run with the caller's
-- (service_role) privileges, which already has full access per migration
-- 0001. No SECURITY DEFINER bypass needed at this phase.

-- ---------------------------------------------------------------------------
-- acquire_spawn_lease(project_id, agent, holder, ttl, reason)
--
-- Returns the (now-current) lease row. Behavior:
--   - If no live lease exists for (project_id, agent) — creates one held
--     by `holder`, slides expires_at to now()+ttl.
--   - If a live lease exists held by the SAME holder — refreshes
--     expires_at = now()+ttl (sliding window), keeps acquired_at.
--   - If a live lease exists held by a DIFFERENT holder — DOES NOT update,
--     returns the existing row. Caller compares returned holder_id to its
--     own to detect conflict.
--   - If an EXPIRED lease exists (expires_at <= now()) — treats it as
--     stolen-by-expiry: rewrites holder/acquired_at/expires_at to the
--     new claim.
--
-- The function returns the row that is now in the table — caller MUST
-- check returned.holder_id == requested_holder to confirm acquisition.
-- ---------------------------------------------------------------------------
create or replace function cortextos.acquire_spawn_lease(
  p_project_id   text,
  p_agent_name   text,
  p_holder_id    text,
  p_ttl_seconds  integer default 90,
  p_reason       text default null
)
returns cortextos.spawn_leases
language plpgsql
as $$
declare
  existing cortextos.spawn_leases;
  result   cortextos.spawn_leases;
begin
  if p_ttl_seconds <= 0 then
    raise exception 'ttl_seconds must be positive, got %', p_ttl_seconds;
  end if;
  if p_agent_name is null or p_agent_name = '' then
    raise exception 'agent_name must be non-empty';
  end if;
  if p_holder_id is null or p_holder_id = '' then
    raise exception 'holder_id must be non-empty';
  end if;

  -- Use FOR UPDATE to serialize against concurrent acquires on the same row.
  -- NULL project_id requires IS NOT DISTINCT FROM to match the NULL slot.
  select * into existing
  from cortextos.spawn_leases
  where project_id is not distinct from p_project_id
    and agent_name = p_agent_name
  for update;

  if not found then
    -- No row exists — insert fresh.
    insert into cortextos.spawn_leases
      (project_id, agent_name, holder_id, acquired_at, expires_at, ttl_seconds, reason)
    values
      (p_project_id, p_agent_name, p_holder_id,
       now(), now() + (p_ttl_seconds || ' seconds')::interval,
       p_ttl_seconds, p_reason)
    returning * into result;
    return result;
  end if;

  if existing.expires_at <= now() then
    -- Expired — steal it.
    update cortextos.spawn_leases
    set holder_id   = p_holder_id,
        acquired_at = now(),
        expires_at  = now() + (p_ttl_seconds || ' seconds')::interval,
        ttl_seconds = p_ttl_seconds,
        reason      = p_reason
    where project_id is not distinct from p_project_id
      and agent_name = p_agent_name
    returning * into result;
    return result;
  end if;

  if existing.holder_id = p_holder_id then
    -- Same holder — slide expires_at, keep acquired_at.
    update cortextos.spawn_leases
    set expires_at  = now() + (p_ttl_seconds || ' seconds')::interval,
        ttl_seconds = p_ttl_seconds,
        reason      = coalesce(p_reason, existing.reason)
    where project_id is not distinct from p_project_id
      and agent_name = p_agent_name
    returning * into result;
    return result;
  end if;

  -- Live lease held by a different holder — no change, return existing.
  return existing;
end;
$$;

-- ---------------------------------------------------------------------------
-- release_spawn_lease(project_id, agent, holder)
--
-- Drops the lease IFF the caller is the current holder AND it has not
-- expired. Returns true on successful release, false otherwise (lease was
-- not held by this caller, or already expired/gone — caller can treat the
-- absent case as "already released" idempotently).
-- ---------------------------------------------------------------------------
create or replace function cortextos.release_spawn_lease(
  p_project_id text,
  p_agent_name text,
  p_holder_id  text
)
returns boolean
language plpgsql
as $$
declare
  deleted_count integer;
begin
  delete from cortextos.spawn_leases
  where project_id is not distinct from p_project_id
    and agent_name = p_agent_name
    and holder_id  = p_holder_id
    and expires_at > now();

  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- heartbeat_spawn_lease(project_id, agent, holder, ttl)
--
-- Extends an existing live lease held by the caller by sliding expires_at
-- forward by `ttl` seconds. Returns the row on success, NULL on failure
-- (lease not held by caller, expired, or absent).
-- ---------------------------------------------------------------------------
create or replace function cortextos.heartbeat_spawn_lease(
  p_project_id   text,
  p_agent_name   text,
  p_holder_id    text,
  p_ttl_seconds  integer default 90
)
returns cortextos.spawn_leases
language plpgsql
as $$
declare
  result cortextos.spawn_leases;
begin
  if p_ttl_seconds <= 0 then
    raise exception 'ttl_seconds must be positive, got %', p_ttl_seconds;
  end if;

  update cortextos.spawn_leases
  set expires_at  = now() + (p_ttl_seconds || ' seconds')::interval,
      ttl_seconds = p_ttl_seconds
  where project_id is not distinct from p_project_id
    and agent_name = p_agent_name
    and holder_id  = p_holder_id
    and expires_at > now()
  returning * into result;

  return result;  -- NULL when no row matched
end;
$$;

-- ---------------------------------------------------------------------------
-- expire_spawn_leases() — sweep helper for observability and cleanup.
--
-- Deletes all rows where expires_at <= now(). Returns the count purged.
-- Safe to run on a poll cadence (cron / daemon background task). Acquire
-- treats expired-and-still-present rows as steal-able anyway, so the sweep
-- is purely housekeeping — it does NOT change correctness, only table size.
-- ---------------------------------------------------------------------------
create or replace function cortextos.expire_spawn_leases()
returns integer
language plpgsql
as $$
declare
  purged integer;
begin
  delete from cortextos.spawn_leases
  where expires_at <= now();

  get diagnostics purged = row_count;
  return purged;
end;
$$;

-- Grants — service_role only (no anon/authenticated).
grant execute on function cortextos.acquire_spawn_lease(text, text, text, integer, text)   to service_role;
grant execute on function cortextos.release_spawn_lease(text, text, text)                  to service_role;
grant execute on function cortextos.heartbeat_spawn_lease(text, text, text, integer)       to service_role;
grant execute on function cortextos.expire_spawn_leases()                                  to service_role;
