-- Bootstrap Supabase-managed roles for vanilla-Postgres test environments.
--
-- Supabase pre-creates `service_role` (and `anon`, `authenticated`, `postgres`,
-- etc.) on every managed project. Migrations under supabase/migrations/ assume
-- those roles exist — migration 0001_cortextos_schema_init.sql grants schema
-- usage to `service_role` and migration 0003_spawn_lease_functions.sql grants
-- function EXECUTE to the same role.
--
-- A vanilla Postgres image (the postgres:16-alpine we use in CI + local
-- docker-compose) has NONE of those roles. Applying the migrations directly
-- against vanilla pg fails with: `ERROR: role "service_role" does not exist`.
--
-- This fixture is applied BEFORE the migrations in vanilla-pg environments
-- (CI integration-tests job + scripts/test-integration.sh). It is NOT part
-- of the canonical supabase/migrations/ chain because Supabase prod already
-- has these roles and `supabase db push` would fail with "role already exists"
-- on the second run.
--
-- Only the roles referenced by the migrations are created. `anon` and
-- `authenticated` are not currently granted to anything in the cortextos
-- schema; add them here if a future migration starts using them.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;
