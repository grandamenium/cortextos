# 02 — Master Plan: Bus `cancel-task` Command

**Repo:** `~/code/cortextos` · **Builder:** codexer · **Framework:** one-big-feature
**Deploy:** cortextOS framework change. Ships via PR → Josh merge → `npm run build` → agents pick it up on next restart. No Railway. Fork-test env-clean (scrub all 6 CTX_* vars) before claiming a regression.

## Josh's Request (relayed via frank2, msg 1782319369270)
- Dashboard task "delete" must remove a task **for good** — Josh's words via frank2: tasks go **"off the bus, not just dashboard-hidden,"** with **no completed record / no productivity credit.**
- Josh's stated preference: a **cancelled status**, not a hard delete (keeps an audit trail, does not pollute the done list).

## Root Cause / Why this exists (confirmed in source)
- `TaskStatus` in `src/types/index.ts:30` **already includes `'cancelled'`** — the type work is done.
- `completeTask` (`src/bus/task.ts:462`) is the only path that sets `completed_at` and emits the `task_completed` activity event (the "productivity credit"). A task set to `cancelled` therefore never gets credited or counted as done — Josh's core requirement is met simply by reaching the `cancelled` status by a path that is **not** `completeTask`.
- Gap 1: there is **no `cancel-task` verb** — an operator would have to call `update-task <id> cancelled`, which is unobvious and writes a generic `update` audit event, not a distinct cancellation.
- Gap 2: `listTasks` (`src/bus/task.ts:524`) does **not** hide `cancelled` from the default (no-status-filter) view. It only skips `archived`. So a cancelled task still shows up in a bare `list-tasks`. To satisfy "filtered from all views," cancelled must be hidden by default the way `archived` is.

## Feature Summary
Add a first-class `cortextos bus cancel-task <id>` command that transitions a task to `cancelled`, writes a distinct `cancel` audit event, and never emits a completion/credit event. Make `listTasks` hide cancelled tasks by default (mirroring the existing `archived` skip), so cancelled tasks disappear from every standard bus view — including the `list-tasks --format json` that the briefs dashboard seeds from.

## Architecture Approach
1. **`cancelTask(paths, taskId, reason?)` in `src/bus/task.ts`** — mirror `completeTask`'s shape (findTaskFile → read → mutate → atomicWriteSync), but set `status = 'cancelled'` and **do NOT** set `completed_at` and **do NOT** call `logEvent(... 'task_completed' ...)`. Set `updated_at`. Write an audit entry with a new event kind `'cancel'`, carrying the optional `reason` as `note`. Throw the same "not found" error as completeTask for an unknown id.
2. **Audit type:** extend `TaskAuditEntry.event` union (`src/bus/task.ts:297`) to include `'cancel'`.
3. **`listTasks` default-hide:** in the filter loop (`src/bus/task.ts:~553`), add — right next to `if (task.archived) continue;` — a skip: `if (task.status === 'cancelled' && filters?.status !== 'cancelled') continue;`. Explicit `--status cancelled` still surfaces them (audit/recovery). **[PENDING JOSH CONFIRM — SCOPE_VALIDATION 2026-06-24: this is the fleet-wide-hide option. If Josh prefers bus stays showing cancelled and only the briefs dashboard filters them, DROP this step 3 and the briefs spec adds the filter in build_dashboard.py instead. Everything else is unchanged.]**
4. **CLI command `cancel-task <id>` in `src/cli/bus.ts`** — register alongside `complete-task` (`src/cli/bus.ts:297`). Accept optional `--reason "<text>"`. Resolve `paths`, call `cancelTask`, print a confirmation (`Cancelled <id>`).

## Non-Goals (v1)
- No hard delete / file removal — `cancelled` is the terminal state (Josh's explicit preference).
- No bulk cancel, no un-cancel verb (recover by `update-task <id> pending` if ever needed).
- No change to `completeTask`, `claimTask`, metrics, or archive logic beyond the listTasks default-hide.

## Shards (specs)
- **`spec-01-cancel-task-command.md`** — the whole change (one cohesive unit; cancelTask + audit type + listTasks hide + CLI + tests).

## Proof Gate (Larry runs after build, before PR)
1. `cancel-task <id>` flips a real test task to `cancelled`, writes a `cancel` audit line, and emits **no** `task_completed` event (grep the activity log).
2. Bare `list-tasks` no longer shows the cancelled task; `list-tasks --status cancelled` does.
3. `list-tasks --format json` (the briefs seed source) omits the cancelled task.
4. `npm run build` clean; `npm test` green (env-clean: scrub CTX_* first).

## Review checklist (Larry, adversarial, before PR)
- `cancelTask` does NOT set `completed_at` and does NOT emit `task_completed` (no credit). Verified by reading the function, not just the test.
- New audit event `'cancel'` added to the union; audit write is best-effort (never blocks).
- listTasks change is gated on `filters?.status !== 'cancelled'` so explicit queries still work; mirrors the `archived` skip exactly.
- No `any`, no `console.log`. Test added in `tests/` covering: cancel-sets-cancelled, cancel-writes-audit, cancel-no-credit-event, list-hides-cancelled-by-default, list-shows-cancelled-when-filtered.
