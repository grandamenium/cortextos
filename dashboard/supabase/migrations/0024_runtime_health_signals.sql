-- Runtime health signals for apollo's BENCLASS monitor.
-- THE GAP: agent_health exposes liveness (heartbeat freshness + process_alive + crash signals) but
-- NOT the agent's engine identity (runtime/model) or its deployment correctness
-- (launch_path_canonical = running cwd matches the registered agent dir) or session bloat
-- (session_mb = largest active .jsonl). A pete-class silent-fallback (wrong engine) or ziggy-class
-- stranded agent (running from wrong dir post-migration) is invisible to the existing view.
-- THE FIX: surface 4 signals in agent_health so the monitor can flag in ONE query per agent:
--   runtime: raw config value ('claude-code'|'hermes'|'codex-app-server'); null=unset=implicit default
--   model: raw config value (e.g. 'claude-opus-4-8'); null=unset
--   launch_path_canonical: true if running cwd == registered agents/<name> dir; null=unknown (reader
--     not yet deployed); false = stranded (ziggy-class: agent migrated but process still in old cwd)
--   session_mb: largest active .jsonl in agent state dir (MB); null=unknown; high value = bloat risk
--
-- SAFE DEFAULT (mirrors 0017/0018/0022 pattern): new heartbeat columns are NULLABLE, no default.
-- null = UNKNOWN = the reader has not yet pushed the field. Boxes that haven't deployed the updated
-- reader send null -> the monitor's graceful-absent logic skips those checks. Zero behavior change.
-- runtime/model come from agents (already there); this migration only adds the 2 heartbeat columns
-- and replaces the view to expose all 4.

-- heartbeats: add the 2 new dynamic runtime signals
alter table public.heartbeats
  add column if not exists launch_path_canonical boolean,  -- true=deployed-correctly; false=stranded; null=unknown
  add column if not exists session_mb            numeric(10,2);  -- largest active .jsonl (MB); null=unknown

-- agent_health: replace view to expose runtime + model (from agents) + the 2 new heartbeat columns.
-- New columns appended at END (CREATE OR REPLACE cannot reorder existing columns).
create or replace view public.agent_health
with (security_invoker = true) as
select a.id as agent_id,
  a.org_id,
  a.name,
  a.display_name,
  h.last_heartbeat,
  h.status,
  h.current_task,
  h.mode,
  case
    when a.enabled = false then 'disabled'::text
    when h.process_alive = false then 'down'::text
    when h.last_heartbeat is null then 'down'::text
    when h.circuit_open then 'down'::text
    when h.crashed then 'down'::text
    when coalesce(h.restart_delta, 0) >= 3 then 'down'::text
    when h.last_heartbeat < (now() - '08:00:00'::interval) then 'down'::text
    when (exists (select 1 from public.cron_health c where c.agent_id = a.id and c.health_state = 'failure'::text)) then 'down'::text
    when h.last_heartbeat < (now() - '05:00:00'::interval) then 'stale'::text
    when (exists (select 1 from public.cron_health c where c.agent_id = a.id and c.health_state = 'warning'::text)) then 'stale'::text
    when (exists (select 1 from public.crash_log cl where cl.agent_id = a.id and cl.ts::date = now()::date)) then 'stale'::text
    else 'healthy'::text
  end as health,
  a.enabled,
  coalesce(h.restart_delta, 0) as restart_delta,
  h.restart_count,
  h.uptime_seconds,
  h.process_alive,
  h.process_checked_at,
  -- runtime health signals for pete-class + ziggy-class detection
  a.runtime,               -- raw config.json value; null=unset=implicit claude-code (NOT invalid)
  a.model,                 -- raw config.json value; null=unset
  h.launch_path_canonical, -- true=cwd correct; false=stranded (ziggy); null=reader not yet deployed
  h.session_mb             -- largest active .jsonl MB; null=reader not yet deployed
from public.agents a
  left join public.heartbeats h on h.agent_id = a.id;
