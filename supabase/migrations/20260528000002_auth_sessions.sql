-- Auth session freshness tracking.
-- Probed weekly by scripts/auth-freshness-monitor.ts.
-- One row per (service, account) — upsert on each probe run.

create table if not exists public.auth_sessions (
  id            uuid primary key default gen_random_uuid(),
  service       text not null,
  account       text not null default '',
  captured_at   timestamptz not null default now(),
  expires_hint  timestamptz,
  is_valid      boolean not null default false,
  probe_status  text not null default 'pending',  -- 'ok' | 'expired' | 'error' | 'skipped'
  probe_detail  text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists auth_sessions_service_account_idx
  on public.auth_sessions (service, account);

alter table public.auth_sessions enable row level security;

create policy "service_role_all" on public.auth_sessions
  for all to service_role using (true) with check (true);

create policy "authenticated_read" on public.auth_sessions
  for select to authenticated using (true);
