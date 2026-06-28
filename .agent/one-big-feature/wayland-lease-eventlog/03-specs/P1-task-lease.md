# P1 — Task schema + lease primitives

**Foundation track. Gates P2.** Additive-only. No existing field changes.

## Targets
- `src/types/index.ts` — `Task` interface (28-71), `TaskStatus` (30)
- `src/bus/task.ts` — `claimTask()` (368-441), `updateTask()` (260-285), `completeTask()` (455-511)
- `src/cli/bus.ts` — `claim-task` (270-291), `update-task` (178-204), new `renew-lease`

## Changes

### 1. `TaskStatus` — add `'stalled'`
```ts
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled' | 'stalled';
```
`'stalled'` is a transient state set by the watchdog (P2) on a lease-expired `in_progress` task, before reclaim. UI surfaces it as STALLED.

### 2. `Task` — add OPTIONAL lease fields (snake_case, all `?`)
Append after `blocked_by?` (keep existing fields untouched; optionality preserves legacy-file validity, same as `blocks`/`blocked_by`):
```ts
  /** slotId/agent currently holding the work lease. Absent = no lease (legacy task). */
  lease_owner?: string;
  /** ISO 8601. Watchdog reclaims when now > this. Set on claim / in_progress, extended by renew-lease. */
  lease_expires_at?: string;
  /** ISO 8601 of the last lease renewal. */
  lease_renewed_at?: string;
  /** Max reclaim re-queues before the task is failed. Default LEASE_RETRY_BUDGET. */
  retry_budget?: number;
  /** Reclaims consumed so far. */
  retries_used?: number;
```
> Name `lease_renewed_at` (NOT `last_heartbeat`) to avoid collision with the agent `Heartbeat` concept (`src/types/index.ts:101-112`).

### 3. Constants (new, top of `src/bus/task.ts`)
```ts
export const LEASE_TTL_MS = 3 * 60 * 1000;     // 3 minutes
export const LEASE_RETRY_BUDGET = 3;
```

### 4. Set lease on claim + on transition to in_progress
- In `claimTask()` (368-441): when the claim succeeds, set `lease_owner = <claiming agent>`, `lease_expires_at = now + LEASE_TTL_MS`, `lease_renewed_at = now`, and initialize `retry_budget ??= LEASE_RETRY_BUDGET`, `retries_used ??= 0`.
- In `updateTask()` (260-285): when `status` transitions to `'in_progress'` and no lease is set, set the same lease fields (owner = task `assigned_to`).
- In `completeTask()` (455-511) and on transition to `completed`/`cancelled`/`failed`: clear `lease_owner` and `lease_expires_at` (lease no longer active). Do NOT reset `retries_used` (audit value).

All writes go through the existing atomic path; preserve the existing audit-log append (`src/bus/task.ts:317-327`).

### 5. `renewLease(paths, taskId, agent)` — new pure function in `src/bus/task.ts`
- Load task. If not found → throw (caller handles). If `lease_owner` set and ≠ `agent` → no-op return `false` (don't steal another agent's lease). Else set `lease_expires_at = now + LEASE_TTL_MS`, `lease_renewed_at = now`, write atomically, return `true`.
- Idempotent; safe to call repeatedly.

### 6. `sweepStalledTasks(paths, org, now?)` — new pure function in `src/bus/task.ts` (consumed by P2)
Deterministic, no LLM. Returns `{ stalled: string[]; reclaimed: string[]; failed: string[] }`. For each task file under the org tasks dir:
- **Detect:** `status === 'in_progress'` AND `lease_expires_at` set AND `now > lease_expires_at` → set `status = 'stalled'`, push to `stalled`.
- **Reclaim:** `status === 'stalled'` AND `(retries_used ?? 0) < (retry_budget ?? LEASE_RETRY_BUDGET)` → set `status = 'pending'`, `retries_used = (retries_used ?? 0) + 1`, clear `lease_owner` + `lease_expires_at`, push to `reclaimed`.
- **Exhaust:** `status === 'stalled'` AND budget hit → set `status = 'failed'`, append `result` advisory note, push to `failed`.
- **Untouched:** any task with no `lease_expires_at` (legacy / leaseless) is skipped entirely.
- Each mutation: re-read → guard on still-expected state → atomic write → audit append. (Single daemon ⇒ no concurrency, but guard anyway.)
- Event emission for each transition is added in P3 (`sweepStalledTasks` calls `logEvent` with the canonical names). Keep the function returning the id lists so P4 can assert without parsing logs.

### 7. CLI: `cortextos bus renew-lease <taskId>`
Add in `src/cli/bus.ts` near `claim-task` (270-291). Resolves agent from env (same resolution `claim-task` uses), calls `renewLease()`, prints `Renewed <id>` / `Lease held by other / not found`.

## Out of scope (P1)
No watchdog loop (P2). No event emission wiring yet (P3) beyond leaving the call sites — but DO have `sweepStalledTasks` accept the work so P3 only adds `logEvent` lines.

## Acceptance
- Existing task JSON (no lease fields) loads, lists, updates, completes unchanged.
- `claim-task` / update→in_progress sets lease; `renew-lease` extends `lease_expires_at`; renew by non-owner returns false.
- `sweepStalledTasks` on a synthetic expired in_progress task → stalled; second sweep → pending + retries_used=1; after budget → failed; leaseless task never touched.
