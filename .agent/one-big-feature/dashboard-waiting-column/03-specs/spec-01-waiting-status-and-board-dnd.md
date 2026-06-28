# spec-01 — `waiting` status + draggable Waiting column

**Repo:** ~/code/cortextos  **Slug:** dashboard-waiting-column  **One codexer run.**

Implement a new persistent task status `waiting` and a drag-and-drop "Waiting" column on the dashboard kanban board. All file:line targets below were read from source on 2026-06-27; verify against current lines before editing.

---

## A. cortextos CORE — status plumbing

### A1. `src/types/index.ts` (~L30)
Current:
```ts
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
```
Add `'waiting'`:
```ts
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled' | 'waiting';
```

### A2. `src/cli/bus.ts` (~L184, L186, L389)
- L184 help text: include `waiting` in the `<status>` description list.
- L186 runtime whitelist:
```ts
const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled', 'waiting'];
```
- L389 `STATUS_ICON` record: add `waiting: '⏸'` (or another distinct glyph).

Do NOT change `updateTask` in `src/bus/task.ts` — it is status-agnostic (writes whatever valid `TaskStatus` it is given). Adding to the type + CLI whitelist is sufficient.

---

## B. DASHBOARD — column + DnD + persistence

### B1. `dashboard/src/lib/types.ts` (~L50)
Add `'waiting'` to the dashboard `TaskStatus` union (keep in sync with core).

### B2. `dashboard/src/app/api/tasks/[id]/route.ts` (~L15)
```ts
const VALID_STATUSES = ['pending', 'in_progress', 'blocked', 'completed', 'waiting'];
```
(The PATCH handler already forwards non-`completed` statuses through `update-task.sh` positionally — `waiting` needs no special-casing.)

### B3. `dashboard/src/components/shared/status-badge.tsx`
Add to `statusConfig`:
```ts
waiting: { variant: 'secondary', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', label: 'Waiting' },
```
Use a semantic/amber token consistent with the design system; the fallback branch already handles unknowns, but `waiting` must be explicit so tsc's `Record<TaskStatus, …>` stays exhaustive.

### B4. `dashboard/src/components/tasks/kanban-board.tsx` — THE MAIN BUILD
Currently a read-only board (cards have onClick only). Add:

1. **Waiting column** in `columns`, ordered: Pending → In Progress → **Waiting** → Blocked → Completed (today). `waiting` tasks = `tasks.filter(t => t.status === 'waiting')`.
2. Grid: `lg:grid-cols-4` → `lg:grid-cols-5`.
3. **Drag-and-drop** with `@dnd-kit/core` (already a dependency):
   - Wrap the board in `<DndContext>` with a `PointerSensor` using an **activation constraint** (`{ distance: 6 }`) so a plain click still opens the detail sheet and is not consumed as a drag.
   - Make each column a droppable (`useDroppable`, id = the column's `status`).
   - Make each `TaskCard` draggable (`useDraggable`, id = task.id). Preserve the existing `onClick` → detail sheet.
   - `onDragEnd`: if the card is dropped over a column whose `status` differs from the task's current status, persist via:
     ```ts
     await fetch(`/api/tasks/${task.id}`, {
       method: 'PATCH',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ status: targetStatus }),
     });
     ```
     Then trigger a refetch/revalidation of the task list so the move persists across refresh. Optimistic local update is acceptable but MUST reconcile with the server response (revert on non-2xx).
   - **Drop targets:** Pending, In Progress, Waiting, Blocked. The **Completed (today)** column is fed by a separate `completedTodayTasks` prop and is NOT a drag drop target (leave it click/visual only).

### B5. `dashboard/src/app/(dashboard)/tasks/page.tsx`
Read this file. If `KanbanBoard` needs the parent to own the mutation/revalidation (e.g. it already passes `onTaskClick` from here and fetches the task list here), lift the drag-end persistence + refetch to the page and pass it down as a prop (e.g. `onTaskMove`). If the board can self-contain the fetch + `router.refresh()`, keep it in the board. Choose the pattern that matches how the list is currently fetched/revalidated in this file — do not introduce a second data-fetching pattern.

---

## C. Tests (REQUIRED in the diff)
1. **Core unit test** (`tests/unit/...` bus task suite): assert `validStatuses` accepts `'waiting'` and that updating a task to `waiting` then reading it back yields `status: 'waiting'`. Mirror the existing pattern for `blocked`.
2. **Dashboard:** `npm run build` must pass (exhaustive `Record<TaskStatus,…>` in status-badge will fail tsc if `waiting` is missed — good signal). If a kanban/board test file exists, add an assertion that the Waiting column renders and is a droppable.
3. Run the core suite env-clean (scrub all 6 CTX_* vars first — known phantom-failure source).

## D. Acceptance (codexer self-check before returning diff)
- [ ] `npx tsc --noEmit` clean in both root and dashboard.
- [ ] `bus update-task <id> waiting` accepted (manual or test).
- [ ] Board renders 5 columns; Waiting present in correct order.
- [ ] Drag a card → PATCH fires → status persists (describe the manual verification you did).
- [ ] Cards still clickable (click not swallowed by drag — activation constraint in place).
- [ ] No `any`, no `console.log`, no new dependency.

## E. Deliverable
Return the full diff + the acceptance checklist results + a one-line note on the Completed-column drop decision. Do NOT commit or push — larry reviews then opens the PR for Josh to merge.
