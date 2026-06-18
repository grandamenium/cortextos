# Fleet box-side `supabase-sync`

Runs **on each customer box**, server-side. It is the existing dashboard chokidar watcher
**inverted**: instead of `file change → SQLite + SSE`, it does `file change → upsert org-scoped rows
to Supabase`. The dashboard then becomes a pure Supabase consumer (Realtime), no box access needed.

Built to Sage's canonical schema (`fleet-dashboard-m1-schema-spec.md`) — **don't diverge from it**.

## M1 scope (this module)
Pushes, in dependency order, for org #1 (`zeusbot`):
`orgs` (seed from `orgs/*/context.json`) → `agents` → `heartbeats` (one row/agent) → `crash_log` +
`cron_health`. Tasks/events/approvals/cost/oauth = M2; billing = M4; commands (actions) = M3.

## How keys resolve
The box knows orgs by **slug** and agents by **name**; the schema uses uuid PKs. `push.ts` upserts
`orgs` (on `slug`) and `agents` (on `org_id,name`), reads back the ids, then writes `heartbeats` /
`crash_log` / `cron_health` with the resolved `org_id` + `agent_id`. Idempotent throughout.

## Config (server-only — never `NEXT_PUBLIC_`)
- `SUPABASE_URL` — the project URL.
- `SUPABASE_SYNC_KEY` — a **scoped service-role writer** limited to this box's org's fleet rows
  (falls back to `SUPABASE_SERVICE_ROLE_KEY`). Never shipped to a browser bundle.
- `CTX_ROOT` — the box's cortextos state root (defaults to `~/.cortextos/<instance>`), as the
  existing dashboard `config.ts` resolves it.

## Run
```bash
# one-shot (cron-friendly)
SUPABASE_URL=… SUPABASE_SYNC_KEY=… npx tsx src/lib/supabase-sync/run.ts --once

# long-lived (initial sync + watch + debounced push on change)
SUPABASE_URL=… SUPABASE_SYNC_KEY=… npx tsx src/lib/supabase-sync/run.ts
```

## Status
**Code-complete and schema-aligned. Not yet connected** — the Supabase project is pending the
account-to-create-it-under decision (Bode/zeus). The moment `SUPABASE_URL` + the writer key are set
(after the M1 migration is applied), it connects and live data flows for `zeusbot`.
