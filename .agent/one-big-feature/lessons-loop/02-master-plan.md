# OBF Master Plan — Lessons Loop (durable PROFILE.md + auto read-back + proactivity gate)

**Slug:** lessons-loop · **Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature · **Author:** larry · 2026-07-05
**Design source:** `orgs/clearworksai/agents/larry/memory/reference/lessons-loop-solution-spec-2026-07-05.md` (Fable 5, verified against source this session) — the full build spec lives in `03-specs/01-lesson-profile-loop.md`.

## Problem (Josh, verbatim)
> "why aren't we reading lessons back? How does that happen... what's the process? ... don't say 'we should probably fix that.' Where is the proactivity in your soul in your constitution in your programmatic outlook."

Verified in code: lessons have **no single retrievable profile** — they live in 3 disconnected channels (feedback_*.md memories, knowledge-sync/lessons/*.md, and a Lessons pipeline stage that writes files nobody reads back). The installed `continuous-learning-v2` skill is **dormant** (its hook scripts were never shipped). So the plan stage never re-reads prior lessons, and a recurring gap only gets fixed when a human happens to notice.

## Invariant (acceptance contract)
1. **One canonical profile** — `knowledge-sync/lessons/PROFILE.md`, ≤60 machine-parseable one-liner lessons with `seen:` recurrence counts. One writer (`lesson-profile.js`), never hand-edited.
2. **Automatic read-back** — every `plan`-stage prompt is prepended with the top-N lessons, with zero action required from any stage author. Fail-open (empty/missing profile ⇒ no prompt change, never a throw).
3. **Dedupe in code, not the LLM** — models emit candidate one-liners; the module decides increment-vs-append via token-set Jaccard ≥0.6. No embeddings, no network.
4. **Programmatic proactivity** — when a lesson's `seen` count crosses 3, the write path **auto-files a bus fix-task** (assignee larry, priority high) and stamps a fire-once marker. A recurring lesson is reclassified as a systems bug by the system, not by a human.

## Approach (one file + one module + three one-line wires — no new services)
- **New module** `.claude/workflows/lib/lesson-profile.js` (CJS, zero deps): `upsertLesson`, `topLessons`, `readProfile` + `require.main` CLI. Atomic tmp+rename write. Env override `LESSON_PROFILE_PATH`.
- **Wire A (read-back)** — prepend `topLessons(20)` at the top of `executeStage()` in `dynamic-pipeline.js` when `stageName === 'plan'`.
- **Wire B (capture)** — Lessons stage schema gains `oneLiners[]`; a post-stage loop upserts them.
- **Wire C (proactivity)** — recurrence-threshold create-task inside `upsertLesson()`.
- **Park** the dead `continuous-learning-v2` skill (its one idea = recurrence weighting = the `seen:` count).
- **Gate** (bus/OBF plan door): `gate-codexer-planning.sh` gains a `## Lessons Consulted` check so human-path plans also read the profile.

## Scope boundary
- Touches: `.claude/workflows/lib/lesson-profile.js` (new), `.claude/workflows/dynamic-pipeline.js`, `orgs/clearworksai/agents/larry/.claude/hooks/gate-codexer-planning.sh`, new test `tests/unit/workflows/lesson-profile.test.ts`, seed `knowledge-sync/lessons/PROFILE.md`, one line in larry `OPERATIONS.md`.
- No new deps, no daemon/cron/observer, no embedding service, no second profile, no LLM-side dedupe. TS/JS strict; no `any`, no `console.log`.

## Definition of done
- `npm run build` clean, `npm test` green, new `lesson-profile.test.ts` covers: exact-dup increments, near-dup increments, distinct appends, eviction at 61 by (seen asc, last asc), threshold fires create-task once + stamps marker, marker ⇒ no re-fire, missing profile ⇒ `topLessons` returns `''`, malformed line non-fatal.
- Live `dynamic-pipeline` smoke: (a) plan prompt artifact contains the `LESSONS PROFILE` block; (b) a synthetic duplicate one-liner increments `seen:` instead of appending. Both logged before claiming done.
- Diff back to larry for adversarial review (scope + invariant + fail-open) → PR → Josh approves merge.

## Lessons Consulted (from the profile / archive that motivated this build)
- `mechanism-without-trigger-is-dead-code.md` — an installed-but-unwired system is worse than none (this build removes exactly that: dormant CL-v2, unread Lessons files). Seed it at `seen:2`.
- `verify-the-built-artifact-not-the-source.md` — DoD verifies the assembled plan prompt + the live increment, not just the source diff.
- `fire-once-guards-must-match-real-world-subject-variants.md` — the proactivity guard keys off the deduped canonical line so phrasing variants can't double-fire.
