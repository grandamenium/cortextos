# Master Plan — Dashboard "Waiting" Task Column (draggable, persistent)

**Slug:** dashboard-waiting-column
**Repo:** ~/code/cortextos
**Framework:** one-big-feature
**Requested by:** Josh (via frank2, 2026-06-27)
**Owner:** larry (spec + review + PR) / codexer (impl)

## Josh's verbatim request
> "Add a 'Waiting' category to the tasks list on the ops dashboard — a draggable column he can drag tasks into (alongside the existing status columns)."
> frank2 clarification: "drag things into it" = drag-and-drop from other columns; the waiting state must **persist** (not just visual), so a refresh still shows the task in waiting.

## Goal
Add a fifth task status, `waiting`, surfaced as a new column on the dashboard kanban board. Tasks can be dragged between columns (drag-and-drop), and the drop **persists** the new status through the bus task model so it survives a page refresh / re-sync.

## Why a first-class status (not a UI-only flag)
Persistence is required (Josh + frank2). The board filters tasks by `status`; drag changes `status`. A parallel "waiting flag" would fight the status model. The clean design adds `waiting` to the canonical `TaskStatus` union, exactly mirroring the existing `cancelled` precedent. Ripple is benign:
- Stale-detector (`src/bus/task.ts` ~L683) only flags `in_progress` → waiting tasks are intentionally never flagged stale. Desired.
- `src/bus/metrics.ts` counts `in_progress` only → waiting not miscounted. Fine.

## Scope = two tightly-coupled layers, ONE codexer run (spec-01)

### Layer A — cortextos core (status plumbing)
1. `src/types/index.ts:30` — add `'waiting'` to `TaskStatus` union.
2. `src/cli/bus.ts:186` — add `'waiting'` to the `validStatuses` runtime whitelist.
3. `src/cli/bus.ts:184` — update the `<status>` argument help text to include `waiting`.
4. `src/cli/bus.ts:389` — add a `waiting` entry to `STATUS_ICON` (e.g. `'⏸'`).

### Layer B — dashboard (column + DnD + persistence)
5. `dashboard/src/lib/types.ts:50` — add `'waiting'` to the dashboard `TaskStatus`.
6. `dashboard/src/app/api/tasks/[id]/route.ts:15` — add `'waiting'` to `VALID_STATUSES`.
7. `dashboard/src/components/shared/status-badge.tsx` — add a `waiting` entry to `statusConfig` (suggest `variant: 'secondary'`, amber/muted className, label `'Waiting'`).
8. `dashboard/src/components/tasks/kanban-board.tsx` — add the **Waiting** column AND wire drag-and-drop using the already-installed `@dnd-kit/core` + `@dnd-kit/sortable`. On drop into a different column, call `PATCH /api/tasks/[id]` with the target status to persist; optimistic update + refetch/revalidate. Grid changes `lg:grid-cols-4` → `lg:grid-cols-5`.
9. `dashboard/src/app/(dashboard)/tasks/page.tsx` — supply the drag-end mutation handler / revalidation if the board lifts that to the page. (Codexer: read this file; only touch if the board needs the parent to own the mutation.)

### Column order
`Pending → In Progress → Waiting → Blocked → Completed (today)`.

## Constraints
- DnD must **coexist with the existing card onClick** (opens detail sheet). Use a `@dnd-kit` pointer activation constraint (small distance threshold) so a click is not swallowed as a drag.
- The `Completed (today)` column is fed by a separate `completedTodayTasks` list and is **not** a valid drop target via drag (dragging to complete should still PATCH `completed`, but keep behavior simple: allow drag into Pending/In Progress/Waiting/Blocked; Completed-by-drag optional — default NOT a drop target to avoid the "completed today" filtering edge case). Note this in the PR.
- No new runtime dependency (dnd-kit already present). TypeScript strict, no `any`, no `console.log`.
- Atomic writes already handled by the bus core path; do not bypass.

## Tests (must accompany the diff)
- **Core:** unit test that `cortextos bus update-task <id> waiting` is accepted (the `validStatuses` gate) and that a round-tripped task reads back `status: 'waiting'`. Add to existing `tests/unit/` bus task suite.
- **Dashboard:** at minimum tsc clean + `npm run build`; if a board test exists, assert the Waiting column renders. The drag handler's PATCH call can be unit-tested against the route's `VALID_STATUSES`.
- Run cortextos tests env-clean (scrub CTX_* per feedback_cortextos_test_env_clean_first).

## Out of scope
- Reordering tasks within a column (Josh asked for a waiting *category*, not manual sort).
- Any change to other agents' behavior — `waiting` is purely a human/dashboard-driven state. Agents keep using their existing statuses.

## Acceptance
1. `bus update-task <id> waiting` succeeds from CLI.
2. Dashboard shows 5 columns incl. Waiting.
3. Dragging a card into Waiting persists; refresh still shows it in Waiting.
4. Cards remain clickable (detail sheet opens).
5. `npm run build` + `npm test` clean.
