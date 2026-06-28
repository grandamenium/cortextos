# Master Plan — Wayland Patterns: Task Lease + Watchdog & Event Log

**Slug:** `wayland-lease-eventlog` · **Framework:** one-big-feature · **Repo:** `/Users/joshweiss/code/cortextos`
**Status:** DRAFT_SPEC — awaiting Josh SCOPE_VALIDATION before codexer dispatch.
**Source:** FerroxLabs/Wayland architecture analysis (`knowledge-sync/.../ferroxlabs-wayland-architecture-analysis-june2026.md`, Patterns 2 + 4) + this plan. Josh-approved via frank2 2026-06-15. Grounded against the live cortextOS source map (file:line below).

## Goal
Add two **additive, non-breaking** primitives to the cortextOS file-based bus:
1. **Task Lease + Watchdog** — detect & auto-recover tasks orphaned by a dead/stalled agent, surface staleness to the HUD.
2. **Event Log formalization** — extend the *existing* event JSONL with a `target` field, a canonical event-type vocabulary, auto-emission at deterministic bus call sites, and a query helper — the foundation for the HUD Activity tab and cost tracking.

## Why one-big-feature (not M2C1)
Single cohesive feature, single repo (`cortextos`), **no schema migration** (file-based; only additive *optional* fields — existing task/event files stay valid), no new repo, no cross-repo coupling. All changes live under `src/types/`, `src/bus/`, `src/daemon/`, `src/cli/`. Not M2C1-scale (no migration / new-repo / multi-repo trigger).

## Key architectural decisions (grounded in source map)
- **File-based, not PostgreSQL.** The Wayland doc's SQL `event_log`/lease columns are *reference only*. We implement on the existing JSONL / JSON-per-file substrate via `src/utils/atomic.ts`. **No database. No SQL.**
- **The Event Log ALREADY EXISTS.** `Event` type (`src/types/index.ts:73-97`), `logEvent()` (`src/bus/event.ts:23-69`), per-agent per-day JSONL at `analytics/events/<agent>/<YYYY-MM-DD>.jsonl`. Pattern 4 **extends** this — it must NOT create a parallel event store.
- **The Watchdog is a DETERMINISTIC daemon loop, not a prompt-cron.** cortextOS crons inject an LLM prompt to wake an agent (`src/daemon/cron-scheduler.ts`). A watchdog must be a pure background sweep. We wire it into the daemon interval infrastructure — mirroring the existing 50-min idle-heartbeat `setInterval` at `src/daemon/fast-checker.ts:125-133` — calling a pure bus function. This honors the doc's "background cron/daemon" intent without abusing the prompt-cron system.
- **New `TaskStatus` value `'stalled'`** (Frank2's term; doc calls it `'zombie'`). Additive to the union at `src/types/index.ts:30`.
- **All new `Task` fields are OPTIONAL, snake_case** (matching existing `assigned_to`/`created_at`), so existing task JSON files remain valid — the exact pattern the repo already used for `blocks`/`blocked_by` (`src/types/index.ts:60-70`).

## Phases / tracks
- **P1 — Task schema + lease primitives (foundation, gates P2).** Add optional lease fields to `Task`; `LEASE_TTL_MS` constant (3 min); set lease on `claimTask`/`updateTask`→`in_progress`; `renewLease()` + `cortextos bus renew-lease <id>` CLI; pure `sweepStalledTasks()` function. Spec: `03-specs/P1-task-lease.md`
- **P2 — Watchdog daemon loop.** 60s deterministic sweep calling `sweepStalledTasks()`: **detect** (`in_progress` + `lease_expires_at < now` → `stalled`), **reclaim** (`stalled` + `retries_used < retry_budget` → `pending`, clear `lease_owner`, `retries_used++`), **exhaust** (budget hit → `failed`), emit events. Re-entrancy guard; per-instance; `task_watchdog_enabled` kill-switch. Spec: `03-specs/P2-watchdog.md`
- **P3 — Event log extension.** Add optional `target?: string` to `Event`; canonical `EVENT_TYPES` constants; auto-emit `task_started`/`task_completed`/`task_stalled`/`message_sent` at deterministic bus call sites; `readEvents()` query helper (filter by org/since/agent/eventType). Spec: `03-specs/P3-event-log.md`
- **P4 — Tests (env-clean).** Unit tests: lease set/renew/expire, sweep detect+reclaim+budget-exhaustion, backward-compat (legacy leaseless task untouched), event `target` + auto-emit + `readEvents` query. Spec: `03-specs/P4-tests.md`

## Critical path
P1 → (P2, P3 parallel) → P4 gates the PR.

## Scope boundaries (NOT doing — prevents creep)
- **NOT** the doc's verify-orphan recovery (cortextOS has no `'verifying'` status).
- **NOT** TeamMcpServer, Ritual Scheduler, Workflows, Sandboxing, Multi-locale (doc Patterns 1/3/5/6/7). Josh approved **only** Patterns 2 + 4.
- **NOT** force-wiring `token_usage`/`briefing_sent` emission (they fire from LLM/agent contexts, not deterministic bus call sites). We add them to the canonical vocabulary so agents *can* emit them, and note where they'd hook — but no forced wiring.
- **NOT** a database. No SQL.

## Risks (flag for SCOPE_VALIDATION)
- **Lease-renewal adoption (fleet-wide behavior change).** Agents must renew during long work or their task auto-reclaims. Mitigate: generous 3-min TTL, retry budget, and renewal piggy-backs on the existing per-event heartbeat refresh side-channel (`src/bus/event.ts:77-87`); document the agent-side contract. **This changes task lifecycle for every agent — explicit Josh flag.**
- **Reclaim storm.** A too-aggressive watchdog could reclaim a healthy long-running task whose owner just didn't renew. Mitigate: 3-min TTL, `retry_budget` cap (default 3) then → `failed` (not infinite re-queue), kill-switch config, and **only tasks with a lease set are touched** (legacy leaseless tasks untouched).
- **Event volume.** Auto-emit at every task transition + message raises JSONL write rate. Existing per-day-per-agent partitioning + atomic append absorbs it; `readEvents` is date-bounded.

## Process gate
Codexer dispatch carries: `GATE: build framework=one-big-feature slug=wayland-lease-eventlog repo=/Users/joshweiss/code/cortextos`. Diff → Larry adversarial build-review (scope match vs Patterns 2+4, additive-only/no breaking field changes, no `any`/`console.log`, env-clean tests present, legacy-file-compat verified) → PR → Josh merges.

## Acceptance
- `npm run build` clean; `npm test` green env-clean.
- Existing task/event JSON files load without error (backward-compat test).
- Lease set on claim; `renew-lease` extends; expiry → `stalled`; reclaim → `pending` w/ `retries_used+1`; budget exhausted → `failed`.
- `Event` has optional `target`; `task_started`/`task_completed`/`task_stalled`/`message_sent` emitted; `readEvents` filters by org/since/agent/eventType.
