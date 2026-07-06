# OBF Master Plan — Atomic State Layer

**Slug:** atomic-state-layer
**Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature (single cohesive fix, one repo, one bug class)
**Author:** larry · 2026-07-06
**Source:** memory/reference/bug-hunt-inventory-2026-07-06.md (found by 4/7 independent explorers)

## Problem (the root cause behind "Cortex loses its own tasks/missions/memory")
The fleet's shared JSON state is written with bare `writeFileSync` after an unlocked read-modify-write.
Concurrent agents (crons, daemon loops, multiple agent processes) tear each other's writes; a torn read
throws in `JSON.parse` and the catch resets to empty. Net effect Josh observes: tasks don't chart,
roadmap missions aren't tracked, reminders vanish, dedup double-sends. It is NOT a RAG problem at this
layer — it is a durability problem: the writes are lost.

The correct pattern already exists in this repo: `src/bus/crons.ts` wraps its read-modify-write in
`withFileLockSync(...)` and persists via `atomicWriteSync(..., { keepBak: true })`. This build applies
that exact standard to every state writer that currently lacks it.

## In scope (verified file:line — apply lock + atomic + bak to each)
1. `src/bus/task.ts` — `updateTask` (263-288), `completeTask` (462-518), `cancelTask` (526-557),
   `archiveTasks` (748-751: write-to-dest-then-unlink, matching `compactTasks` 874-875), `createTask`
   peer edges (`addSymmetricEdge` 112-117 under a taskDir lock).
2. `src/bus/cron-state.ts` — `updateCronFire` (76): `atomicWriteSync` + `withFileLockSync` + keepBak.
3. `src/bus/reminders.ts` — `writeReminders` (46-49) used by createReminder/ackReminder/pruneReminders.
4. `src/daemon/fast-checker.ts` — permission + restart response files (787, 805): `atomicWriteSync`.
5. `src/hooks/hook-loop-detector.ts` — `saveState` (110): `atomicWriteSync` (match `recordToolActivity` 118).
6. `src/telegram/dedup.ts` — `checkAndRecord` (49-76): O_EXCL/lock around read-check-write.
7. `src/cli/bus.ts` — `notify-agent` urgent-signal write (2017): `atomicWriteSync`.
8. `src/bus/message.ts` — `ackInbox` (170-195): acquire inbox lock before scan+rename (TOCTOU vs `recoverStaleInflight`).

## Out of scope
Logic redesign of any of these subsystems. This is purely durability: same behavior, atomic + locked.
The two routing blockers and the planmode fail-open are tracked separately (not this slug).

## Approach
Reuse existing helpers: `withFileLockSync` (crons.ts pattern) and `atomicWriteSync` (`src/utils/atomic.ts`).
Do NOT invent a new locking framework — no new runtime deps (CLAUDE.md rule). Per-file lock keyed on the
target path's `.locks/<name>` dir, mirroring crons.ts. Where a helper doesn't exist for a given state dir,
add a thin wrapper next to the existing writer, not a new module.

## Lessons Consulted (from knowledge-sync/lessons/PROFILE.md)
- **[state] short-ttl lease must not share storage with permanent dedup ledger** → when locking `telegram/dedup.ts`, keep the lock/lease file separate from the ledger itself; don't co-locate them.
- **[daemon] optimistic mark before spawn prevents duplicate workers** → ordering matters; a lock must be held across the full read-modify-write, not just the write, or two writers still race.
- **[build] build passed does not mean all workstreams landed** → after the fix, grep-verify every one of the 8 writers actually changed; a green build does not prove each site was converted.
- **[build] verify the built artifact not the source** → run the reproducing tests against the compiled output, not just tsc; prove fail-then-pass on the real run.
- **[gate] code gate needs a writer not just a reader** → the atomicity tests must actually exercise concurrent writers, not just read state back.

## Done =
Every writer above uses lock + atomic + keepBak; no bare `writeFileSync` remains on shared state paths;
`npm run build` clean; `npm test` green; new tests prove the class is gone (see spec 01). Diff → larry
adversarial review → PR. Josh gates merge.
