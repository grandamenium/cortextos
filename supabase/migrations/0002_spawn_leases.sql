-- 0002_spawn_leases.sql
-- Phase 2e (Δ1) — spawn_leases table, reworked per Sam's HOLD review 2026-05-17.
--
-- IDENTITY KEY CHANGE vs original draft:
--   Was:  unique slot per (project_id, agent_name)
--   Now:  unique ACTIVE slot per (project_id, artifact_key); released rows
--         drop out via released_at IS NULL on the partial unique index.
--
-- Why: per the v3 architecture plan §1 Δ1 + .claude/rules/codex-subagent-direct-spawn.md G1,
--   leases protect artifacts (a file path, a KB slug, a deploy target) rather
--   than agents. Two different agents touching the same artifact MUST
--   serialize; one agent touching two different artifacts MUST NOT serialize.
--   Keying by agent_name violated both invariants.
--
-- Columns added: lease_id (bigserial PK), artifact_key, task_class, released_at.
-- Columns dropped: agent_name (semantic key replaced by artifact_key + task_class).
-- holder_id is retained as the opaque caller-chosen id (typically session_id);
-- a parent agent's stop hook calls release_session_leases(holder_id) to free
-- everything that session held.

create table if not exists cortextos.spawn_leases (
  -- Surrogate PK. Used by renew / release operations so the caller doesn't
  -- need to re-supply the composite key on every heartbeat.
  id            bigserial primary key,

  -- Scope. NULL-tolerant per B1; NULL = unscoped/fleet-wide lease.
  project_id    text,

  -- The thing being claimed. Required, non-empty. Examples: "agent:vid-g"
  -- (daemon spawn-path lock), "file:/repo/src/x.ts" (refactor in flight),
  -- "kb:slug-name" (KB write).
  artifact_key  text not null check (length(artifact_key) > 0),

  -- Coarse classifier for telemetry / ratchet metrics (per direct-spawn rule
  -- G1: "Max lease per task class: default 30 min, hard ceiling 60 min").
  -- Examples: "spawn", "scrape", "refactor", "translate".
  task_class    text not null check (length(task_class) > 0),

  -- Opaque caller-chosen holder id. Typically a session_id so a stop hook can
  -- release every lease held by the dying session via release_session_leases.
  holder_id     text not null check (length(holder_id) > 0),

  -- Sliding-window lifecycle. acquired_at is sticky for the same holder
  -- across renews (so total-held-duration shows up in observability).
  acquired_at   timestamptz not null default now(),
  expires_at    timestamptz not null,

  -- TTL audit. Defaults to 90s (matches direct-spawn rule heartbeat cadence).
  ttl_seconds   integer not null default 90 check (ttl_seconds > 0),

  -- Optional human-readable annotation. Not part of matching.
  reason        text,

  -- Soft-delete column. NULL means "active"; set to release-time on release.
  -- The partial unique index below treats released rows as out-of-slot, which
  -- is how a second acquire on the same (project, artifact) succeeds after
  -- a release without colliding with the prior tombstone.
  released_at   timestamptz,

  -- Audit metadata.
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Partial unique index. ACTIVE leases (released_at IS NULL) collide on
-- (project_id, artifact_key) — that's the serialization point. Released
-- rows fall out of the index, so the next acquire on the same artifact
-- can insert a fresh row without conflicting with the tombstone.
--
-- NULLS NOT DISTINCT (PG15+) is REQUIRED. The default NULL-distinct
-- behavior treats every NULL project_id as a separate value, which would
-- let two unscoped (project_id IS NULL, artifact_key='X') rows coexist
-- in the index — defeating the serialization point. With NULLS NOT
-- DISTINCT, NULL=NULL for uniqueness purposes, so the partial unique
-- enforces "at most one active row per (project, artifact)" including
-- the unscoped slot.
create unique index if not exists spawn_leases_active_artifact_uniq
  on cortextos.spawn_leases (project_id, artifact_key)
  nulls not distinct
  where released_at is null;

-- Lookup indexes for expiry sweeps and "what does session X hold" queries.
create index if not exists spawn_leases_expires_idx
  on cortextos.spawn_leases (expires_at)
  where released_at is null;

create index if not exists spawn_leases_holder_idx
  on cortextos.spawn_leases (holder_id)
  where released_at is null;

create index if not exists spawn_leases_task_class_idx
  on cortextos.spawn_leases (task_class)
  where released_at is null;

comment on table cortextos.spawn_leases is
  'Artifact-keyed lease for fleet spawn coordination (v3 §1 Δ1). Active row '
  'per (project_id, artifact_key); released rows drop out via partial unique '
  'index. holder_id is typically a session_id so stop hooks can mass-release.';

comment on column cortextos.spawn_leases.artifact_key is
  'The thing being claimed (file path, agent name, deploy target, ...). '
  'Required non-empty. Two callers on same (project, artifact) serialize.';

comment on column cortextos.spawn_leases.holder_id is
  'Opaque caller id (typically session_id). release_session_leases(holder) '
  'frees every active lease this id holds — used by stop hooks.';

comment on column cortextos.spawn_leases.released_at is
  'NULL = active. Set on release. Partial unique index treats released rows '
  'as out-of-slot so re-acquire on same artifact succeeds.';

-- updated_at auto-refresh trigger.
create or replace function cortextos.spawn_leases_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists spawn_leases_set_updated_at on cortextos.spawn_leases;
create trigger spawn_leases_set_updated_at
  before update on cortextos.spawn_leases
  for each row execute function cortextos.spawn_leases_set_updated_at();
