-- 0004_spawn_leases_ttl_cap.sql
-- Phase 2e (Δ1) — forward-compat TTL contract tightening per Sam HOLD verdict
-- 2026-05-17 on PR #474 BLOCK 1.
--
-- Idempotent ALTER for envs that already applied 0002 (default 90, CHECK > 0).
-- Fresh DBs see the new contract from 0002 directly; running 0004 after that
-- is a no-op modulo the CHECK swap (DROP/ADD is idempotent given the new name).
--
-- New contract:
--   ttl_seconds DEFAULT 1800 (30 min — matches direct-spawn rule G1 default)
--   CHECK (ttl_seconds > 0 AND ttl_seconds <= 3600)
--     - lower bound prevents zero/negative TTL
--     - upper bound enforces G1 hard ceiling (60 min)
--
-- Why both layers (table + function): the SQL functions in 0003 also enforce
-- the cap so an over-cap caller fails fast with a clear message *before* the
-- INSERT/UPDATE hits the table CHECK. Function-level errors surface as
-- "ttl_seconds exceeds hard ceiling (3600s = 60min), got <N>" instead of a
-- generic constraint-violation, making the contract more discoverable.

alter table cortextos.spawn_leases
  alter column ttl_seconds set default 1800;

-- DROP + ADD swap. PG names the inline-style CHECK constraint as
-- "<table>_<column>_check" by default (here: spawn_leases_ttl_seconds_check).
-- Using IF EXISTS keeps this migration idempotent on fresh DBs that already
-- defined the new check inline in 0002.
alter table cortextos.spawn_leases
  drop constraint if exists spawn_leases_ttl_seconds_check;

alter table cortextos.spawn_leases
  add constraint spawn_leases_ttl_seconds_check
  check (ttl_seconds > 0 and ttl_seconds <= 3600);
