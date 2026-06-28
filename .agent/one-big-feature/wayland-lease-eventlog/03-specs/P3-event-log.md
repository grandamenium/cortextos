# P3 — Event log extension

**Extends the EXISTING event system. Does NOT create a parallel store.**

## Targets
- `src/types/index.ts` — `Event` interface (73-97), `EventCategory` (73-83)
- `src/bus/event.ts` — `logEvent()` (23-69)
- `src/bus/task.ts` — `claimTask`/`updateTask`→in_progress, `completeTask`, `sweepStalledTasks` (from P1)
- send-message implementation (locate in `src/bus/` message module) — `message_sent`
- new `readEvents()` query helper in `src/bus/event.ts`

## Changes

### 1. `Event` — add OPTIONAL `target`
```ts
export interface Event {
  id: string;
  agent: string;          // = actorSlot (the actor)
  org: string;
  timestamp: string;      // = createdAt
  category: EventCategory;
  event: string;          // = eventType
  severity: EventSeverity;
  metadata: Record<string, unknown>;   // = payload
  /** Agent slot or task id this event targets. Optional. */
  target?: string;
}
```
Map to Wayland's shape: `agent`↔actorSlot, `event`↔eventType, `timestamp`↔createdAt, `metadata`↔payload, new `target`↔targetSlot. No rename of existing fields (backward-compat).

### 2. Canonical `EVENT_TYPES` constants (new export, `src/bus/event.ts`)
```ts
export const EVENT_TYPES = {
  TASK_STARTED: 'task_started',
  TASK_COMPLETED: 'task_completed',
  TASK_STALLED: 'task_stalled',
  TASK_RECLAIMED: 'task_reclaimed',
  MESSAGE_SENT: 'message_sent',
  SESSION_START: 'session_start',
  TOKEN_USAGE: 'token_usage',
  BRIEFING_SENT: 'briefing_sent',
  WATCHDOG_SWEEP: 'watchdog_sweep',
} as const;
```

### 3. `logEvent` — accept optional `target`
Add an optional `target` param (after `metadata`) threaded into the written record. Keep the existing heartbeat-refresh side-effect (77-87) intact.

### 4. Auto-emit at DETERMINISTIC bus call sites (category `'task'` / `'message'`)
- `claimTask` / update→`in_progress`: `logEvent(..., 'task', TASK_STARTED, 'info', {taskId}, target=taskId)`
- `completeTask`: `TASK_COMPLETED` (target=taskId)
- `sweepStalledTasks`: `TASK_STALLED` on detect, `TASK_RECLAIMED` on reclaim, `WATCHDOG_SWEEP` summary (target=taskId / null)
- send-message: `MESSAGE_SENT` with `target = recipient agent`
> `SESSION_START`, `BRIEFING_SENT`, `TOKEN_USAGE` are agent/daemon-emitted (not deterministic bus call sites) — added to the vocabulary only; document where they'd hook. **No forced wiring.**

### 5. `readEvents(paths, opts)` query helper (new, `src/bus/event.ts`)
```ts
readEvents(paths, { org, since?: string, until?: string, agent?: string, eventType?: string, limit?: number }): Event[]
```
- Reads the per-agent per-day JSONL partitions under `analytics/events/`. When `agent` given, scan that agent's dir; else all agents.
- Date-bound by `since`/`until` to the relevant `<YYYY-MM-DD>.jsonl` files (don't read all history).
- Filter by `eventType`/`org`; sort by `timestamp` desc; apply `limit`. This powers the HUD Activity tab + briefs.

## Acceptance
- Existing events (no `target`) parse unchanged.
- A claim emits `task_started`; complete emits `task_completed`; send-message emits `message_sent` with `target`.
- `readEvents({org, since})` returns the emitted events filtered + ordered; `eventType` filter narrows correctly.
