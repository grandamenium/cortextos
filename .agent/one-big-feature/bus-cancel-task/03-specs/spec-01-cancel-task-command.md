# Spec 01 — `cancel-task` command (cortextOS bus)

**Repo:** `~/code/cortextos` · **Builder:** codexer · **Framework:** one-big-feature
**Verify:** `npm run build` clean + `npm test` green. Scrub all 6 `CTX_*` env vars before testing (phantom hook/cron failures otherwise — see `feedback_cortextos_test_env_clean_first`).

## Scope (exact, file:line targets)

### 1. `src/types/index.ts`
- No change needed to `TaskStatus` (line 30) — `'cancelled'` is already present. Confirm it is there; do not duplicate.

### 2. `src/bus/task.ts`

**2a. Extend the audit event union (line ~297):**
```ts
export interface TaskAuditEntry {
  ts: string;
  event: 'create' | 'claim' | 'update' | 'complete' | 'cancel'; // add 'cancel'
  agent: string;
  from?: TaskStatus;
  to?: TaskStatus;
  note?: string;
}
```

**2b. Add `cancelTask` (place it right after `completeTask`, ~line 518).** Model it on `completeTask` but:
- set `task.status = 'cancelled'`
- set `task.updated_at` (same ISO-trim as elsewhere)
- **DO NOT** set `task.completed_at`
- **DO NOT** call `logEvent(... 'task_completed' ...)` — cancellation must produce zero productivity credit
- accept an optional `reason?: string`; pass it as the audit `note`
- emit audit: `appendTaskAudit(paths, taskId, { event: 'cancel', agent: assignee || 'unknown', from: prevStatus, to: 'cancelled', note: reason })`
- throw the same "not found in any org" error as `completeTask` when `findTaskFile` returns null

```ts
/**
 * Cancel a task: terminal 'cancelled' state. Unlike completeTask this sets
 * NO completed_at and emits NO task_completed event — a cancelled task is
 * never counted as done and earns no productivity credit. Preferred over
 * hard delete so the audit trail survives.
 */
export function cancelTask(
  paths: BusPaths,
  taskId: string,
  reason?: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let assignee: string | undefined;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    task.status = 'cancelled';
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} cancel failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'cancel', agent: assignee || 'unknown', from: prevStatus, to: 'cancelled', note: reason });
}
```

**2c. `listTasks` default-hide (filter loop, ~line 553).** Right next to `if (task.archived) continue;` add:
```ts
// Cancelled tasks are hidden from every default view (like archived).
// An explicit `--status cancelled` query still surfaces them for audit/recovery.
if (task.status === 'cancelled' && filters?.status !== 'cancelled') continue;
```
**[PENDING JOSH CONFIRM — fleet-wide hide. If Josh says "bus should keep showing cancelled," omit 2c entirely; the briefs dashboard will filter cancelled instead.]**

### 3. `src/bus/index.ts`
- Export `cancelTask` alongside the existing task exports (line 5): `export { createTask, updateTask, completeTask, cancelTask, listTasks } from './task.js';`

### 4. `src/cli/bus.ts`
- Import `cancelTask` (line 7 import list).
- Register the command right after `complete-task` (line ~297). Mirror its option/handler shape:
```ts
program
  .command('cancel-task')
  .description('Cancel a task (terminal cancelled state — no completion, no productivity credit)')
  .argument('<id>', 'task id')
  .option('--reason <text>', 'optional cancellation reason')
  .action((id, opts) => {
    const paths = /* same paths resolution complete-task uses */;
    cancelTask(paths, id, opts.reason);
    console.error(`Cancelled ${id}`); // match complete-task's output stream
  });
```
- Match exactly how `complete-task` resolves `paths` and prints (use the same stream — `complete-task` uses whatever the file already uses; copy it verbatim, do not introduce console.log to stdout if the file uses a logger).

### 5. Tests — `tests/` (match the existing bus task test file's location/style)
Add cases:
- `cancelTask` sets status to `'cancelled'` and does NOT set `completed_at`.
- `cancelTask` writes an audit entry with `event: 'cancel'` and the reason as `note`.
- `cancelTask` emits NO `task_completed` activity event (assert the activity/analytics log has no completion event for the id).
- `listTasks` with no status filter omits a cancelled task.
- `listTasks({ status: 'cancelled' })` returns it.
- `cancel-task` on an unknown id throws the not-found error.

## Out of scope
- No un-cancel verb, no bulk cancel, no hard delete, no change to completeTask/claimTask/metrics/archive.

## Definition of done
`npm run build` clean, `npm test` green (env-clean), all six test cases pass, `cancelTask` verified by reading to set no completed_at / emit no credit event.
