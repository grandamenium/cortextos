-- 0001_cortextos_schema_init.sql
-- Phase 2e (Δ1) — cortextos schema initialization on Seoul Supabase.
--
-- gbrain co-locates on this same project (public.*). The cortextos schema
-- isolates fleet infra tables (lease, registry in 0004+, future runtime state)
-- from gbrain's RAG/KB tables. Service role is the only grantee at this
-- phase — no RLS, no anon access; revisit when/if we expose tables to anon
-- clients (none planned for lease/registry per top-g 2026-05-17 signoff).

create schema if not exists cortextos;

comment on schema cortextos is
  'cortextOS fleet infrastructure tables. v3 architecture phase 2+. '
  'Co-located with gbrain (public.*) on Seoul Supabase project. '
  'Service-role only; no RLS at this phase.';

-- Grant usage to the service_role. Anon/authenticated roles get nothing.
grant usage on schema cortextos to service_role;
grant all on all tables in schema cortextos to service_role;
grant all on all sequences in schema cortextos to service_role;
grant all on all functions in schema cortextos to service_role;

alter default privileges in schema cortextos
  grant all on tables to service_role;
alter default privileges in schema cortextos
  grant all on sequences to service_role;
alter default privileges in schema cortextos
  grant all on functions to service_role;
