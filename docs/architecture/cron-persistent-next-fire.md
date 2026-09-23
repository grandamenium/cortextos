# Cron Scheduler — Persistent `next_fire_at`

**Status:** Design — not yet implemented
**Priority:** Medium (silent bug affects weekly/daily crons; short crons unharmed)
**Owner:** develop (implementation), analyst (design)
**Last updated:** 2026-08-11
**Related:** theta 61, `project_cron_reanchor_drift`

---

## Problem

Daemon-managed crons drift on restart when they have never fired successfully, or when they were crashed mid-fire. The drift equals up to one full interval.

Observed 2026-08-11 (designer, theta 60 aftermath):
- Cron `experiment-user-acceptance`, schedule `168h`, last_fired_at = `-` (never fired)
- Pre-restart next fire: `2026-08-17 06:09 UTC`
- After config-reload cascade at 11:59:14Z + daemon reload: next fire slipped to `2026-08-18 12:02 UTC` (+30h)
- After another restart at ~12:02Z: next fire slipped to `2026-08-18 18:02 UTC` (+36h from original)

Each restart re-anchors next fire to `restart_time + interval`.

## Root cause

`src/daemon/cron-scheduler.ts:392–397`:

```typescript
const stateFire = stateLastFireByName.get(def.name);
const candidates: number[] = [];
if (def.last_fired_at) candidates.push(new Date(def.last_fired_at).getTime());
if (def.last_fire_attempted_at) candidates.push(new Date(def.last_fire_attempted_at).getTime());
if (stateFire) candidates.push(new Date(stateFire).getTime());
const referenceMs = candidates.length > 0 ? Math.max(...candidates) : now;

let nextFireAt = computeNextFireAt(def, referenceMs);
```

For a cron with **no** `last_fired_at`, no `last_fire_attempted_at`, and no cron-state entry, the `candidates` array is empty and `referenceMs` falls back to `now` (i.e. daemon-restart time). Result: `next_fire_at = restart_time + interval`, sliding forward on every restart.

The `last_fire_attempted_at` field mitigates crash-mid-fire (avoids double-firing the same slot), but when the daemon crashes before ANY successful fire, `attempted_at` becomes an anchor for the same drift.

## Blast radius (by cron interval)

| Interval    | Drift per restart | Practical impact                                   |
|-------------|-------------------|----------------------------------------------------|
| 10m         | ≤ 10 min          | Invisible — restarts settle within one tick        |
| 4h          | ≤ 4 h             | Barely noticeable; heartbeats catch up             |
| 12h         | ≤ 12 h            | Autoresearch windows slip by half a day            |
| 24h         | ≤ 24 h            | Nightly reports miss a day                         |
| **168h**    | **≤ 7 days**      | **Weekly cycles can skip a whole cadence**         |

## Proposed fix

Persist `next_fire_at` in crons.json whenever it is computed, and treat it as the authoritative future anchor on load.

### Data model change

Add optional `next_fire_at: string | null` (ISO-8601) to `CronDefinition` in `src/types/index.ts`. Backwards-compatible: absent field means "compute from scratch" (current behavior).

### Load path change (`loadCrons()`)

Insert a branch before the current referenceMs computation at cron-scheduler.ts:392:

```typescript
// PERSISTED next_fire_at — authoritative when present and future.
// Bypasses referenceMs recomputation so never-fired crons don't drift
// on daemon restart.
if (def.next_fire_at) {
  const persisted = new Date(def.next_fire_at).getTime();
  if (!isNaN(persisted) && persisted > now) {
    nextScheduled.set(def.name, {
      definition: def,
      nextFireAt: persisted,
      changeKey: key,
    });
    continue;
  }
  // persisted is in the past → fall through to catch-up policy below.
}
```

If `next_fire_at` is stale (past), the existing catch-up logic (lines 411–416) handles it correctly by scheduling immediate fire.

### Write path change (2 sites)

**Site 1 — after successful fire, `cron-scheduler.ts:499`** (existing code):

```typescript
const nextFireAt = computeNextFireAt(cron, now);
updateCron(this.agentName, name, {
  last_fired_at: nowIso,
  next_fire_at: new Date(nextFireAt).toISOString(),  // NEW
  fire_count: newFireCount,
});
```

**Site 2 — when a cron is loaded fresh (new/modified, or persistence-migration), cron-scheduler.ts:418**:

```typescript
nextScheduled.set(def.name, { definition: def, nextFireAt, changeKey: key });

// Persist next_fire_at so subsequent restarts don't drift.
if (!def.next_fire_at || new Date(def.next_fire_at).getTime() !== nextFireAt) {
  try {
    updateCron(this.agentName, def.name, {
      next_fire_at: new Date(nextFireAt).toISOString(),
    });
  } catch (err) {
    // Non-fatal — log and continue with in-memory schedule.
    this.logger(
      `[cron-scheduler] failed to persist next_fire_at for "${def.name}": ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
}
```

### Migration

None required — new field is optional and null on existing crons.json files. First fire (or first load after this ships) populates it. Zero-downtime rollout.

### Interaction with `reload()` semantics

Unchanged. `reload()` still preserves `nextFireAt` for crons whose `changeKey` is unchanged (line 365–368). The persisted `next_fire_at` only comes into play on cold start (fresh daemon process). This is correct because `reload()` runs in the same process where the in-memory `scheduled` map already holds the truth.

### Interaction with `last_fire_attempted_at` guard

Unchanged. The attempted_at field still prevents double-fire on crash-mid-fire. When `next_fire_at` is persisted at post-success (Site 1), the write happens AFTER `last_fired_at` is written, so a crash between them leaves the schedule slightly ahead but never behind → catch-up still handles it.

---

## Test spec (for develop)

New tests in `tests/daemon/cron-scheduler.test.ts` (or matching test file):

### Test 1: never-fired cron survives restart without drift

```
given: cron "weekly-test" schedule=168h, added at T0, never fired
when:  daemon starts at T0, computes next_fire_at = T0+168h, persists it
       daemon stops at T0+1h
       daemon restarts at T0+1h
then:  cron's in-memory nextFireAt === T0+168h (NOT T0+1h+168h)
```

### Test 2: successfully-fired cron unchanged behavior

```
given: cron with last_fired_at=T1, next_fire_at=T1+interval
when:  daemon restarts at T1+interval-30s (still in future)
then:  nextFireAt === T1+interval (preserved)
```

### Test 3: stale persisted next_fire_at triggers catch-up

```
given: cron with next_fire_at=T-past
when:  daemon starts at now > T-past
then:  scheduler fires once immediately (catch-up policy still applies)
```

### Test 4: persisted next_fire_at written on every fire

```
given: cron fires successfully at T
when:  post-fire updateCron() is called
then:  crons.json contains next_fire_at = T + interval (ISO string)
```

### Test 5: persistence write failure does not crash the tick

```
given: crons.json is write-locked or ENOSPC
when:  scheduler tries to persist next_fire_at after successful fire
then:  logger records warning, in-memory schedule unchanged, tick loop continues
```

### Test 6: manage-cycle modify triggers fresh next_fire_at

```
given: cron with next_fire_at persisted
when:  schedule changes 12h → 168h, changeKey differs, reload() runs
then:  next_fire_at is recomputed from now (not preserved), fresh value written
```

---

## Rollout

1. develop implements design + tests, forks + PR
2. capitan reviews (analyst can verify test scenarios match the report)
3. Merge to main
4. No agent-side changes needed. Next daemon restart begins populating `next_fire_at` across the fleet
5. Retro after 2 weeks: designer's weekly cron next_fire should stay stable across all daemon restarts in the window

## Out of scope

- Migrating existing crons.json files eagerly (unnecessary — lazy population is safe)
- Adding a `first_scheduled_at` field for audit (nice-to-have; not blocking)
- Rewriting the `last_fire_attempted_at` anti-double-fire mechanism (orthogonal, works correctly)
- Fixing designer's cron in-place (will self-correct on next successful fire or after this ships)
