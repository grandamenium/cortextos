# Spec 01 — Task categorization layer (system/cron noise vs real build)

**Josh (verbatim, 2026-07-06):** "this should differentiate between cron and system noise versus real things we are building."

**Repo:** `~/code/cortextos`. Framework: one-big-feature. Slug: `bus-programmatic-ssot`.

## Problem
`bus list-tasks --status pending` returns 223 rows that mix three kinds:
- **system** — auto-spawned telemetry: `created_by` = `transcript-scanner-*` (15), `comms-check-*` (10), session-save/heartbeat.
- **human** — Josh asks: `assigned_to='human'` / `project='human-tasks'` / titles `Josh:`/`Decide:`/`[HUMAN]`.
- **build** — real engineering work (consolidation-*, pipeline fixes, bug hunts).

210/223 have empty `project`, so "what are we building" can't be queried. The `--project` field already exists on `createTask`; nothing derives or filters on it.

## Deliverables (codexer writes .ts)

### 1. `src/bus/task.ts` — exported classifier
Add near the Task type:
```ts
export type TaskClass = 'system' | 'human' | 'build';
export function classifyTask(task: Task): TaskClass {
  const by = task.created_by || '';
  const title = task.title || '';
  if (/^(transcript-scanner|comms-check|session-save|heartbeat)-/.test(by)
      || task.project === 'system'
      || /^cron:/i.test(title)) return 'system';
  if (task.assigned_to === 'human' || task.assigned_to === 'user'
      || task.project === 'human-tasks'
      || /^(\[HUMAN\]|Josh:|Decide:)/i.test(title)) return 'human';
  return 'build';
}
```
Classification is DERIVED (no backfill of 210 files needed) — works on the existing backlog immediately.

### 2. `src/bus/task.ts` — `createTask` durable forward-tag
In `createTask`, when `project === ''` (unset) AND `agentName` matches `/^(transcript-scanner|comms-check|session-save|heartbeat)-/`, set `project = 'system'` before building the task object. So the stored field trends correct going forward without touching classifier logic.

### 3. `src/bus/task.ts` — `listTasks` filter
Extend the `filters` object with `class?: TaskClass`. After the existing filters, add:
```ts
if (filters?.class && classifyTask(task) !== filters.class) continue;
```

### 4. `src/cli/bus.ts` — list-tasks flags (around line 435–443)
- Add `.option('--class <c>', 'Filter by class: system | human | build')`.
- Add `.option('--real-build', 'Only real build work (excludes system + human)')` — maps to `class: 'build'`.
- Pass `class` into `listTasks(paths, { ... })`.
- Text output: add a leading `[system]`/`[human]`/`[build]` tag per row (call `classifyTask`). JSON output: add `class` field to each row via `classifyTask` (do not persist — computed at read).

## Tests (`tests/`)
- `classifyTask`: system for `created_by='transcript-scanner-123'`; system for title `'Cron: heartbeat'`; human for `assigned_to='human'`; human for title `'Josh: send token'`; build otherwise.
- `createTask` with `agentName='comms-check-999'` and no project → stored `project==='system'`.
- `listTasks({ class:'build' })` excludes a system-spawned task in the same dir.

## Out of scope
- Closing/archiving the stale >14d pending (task-reaper cron already handles staleness).
- PR→task close linkage (separate spec 02 in this slug).

## Constraints
TypeScript strict, no `any`, no `console.log`. Match existing task.ts patterns (atomic writes, existing filter style). Classification derived at read — never a migration.
