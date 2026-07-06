# Lessons Loop — Programmatic Solution Spec (2026-07-05)

> Author: Fable 5 (architect). Status: READY FOR CODEXER — this is a build spec, not a discussion.
> Grounding: every file/line cited below was read this session: `dynamic-pipeline.js` (400 lines),
> `lib/routing-policy.js` (167 lines), `~/.claude/skills/continuous-learning-v2/` (full file listing),
> `/Users/joshweiss/code/knowledge-sync/lessons/` (19 files), `src/cli/bus.ts` create-task (lines 218–249),
> `tests/unit/workflows/routing-policy.test.ts` (exists — test placement pattern).
> Companion analysis: `fable-pipeline-design-review-2026-07-05.md` §2.

## The one-sentence design

**One new file (`PROFILE.md`), one new module (`lesson-profile.js`), three one-line wires** — capture
appends/increments the profile, the plan stage reads it back automatically, and a recurrence threshold
files a bus fix-task with no human in the loop. No new services, no embeddings, no observer daemon.

```
capture (Lessons stage + Larry CLI)          read-back (automatic)
        │                                            ▲
        ▼                                            │
  lesson-profile.js ──► lessons/PROFILE.md ──► executeStage('plan') prompt prepend
        │
        └── seen-count crosses 3 ──► cortextos bus create-task (fix task, assignee larry)
```

---

## 1. THE LESSON PROFILE — one canonical file

**Path:** `/Users/joshweiss/code/knowledge-sync/lessons/PROFILE.md`
(lives beside the 19 existing per-lesson archive files; those stay as the long-form archive, PROFILE.md
is the retrievable layer). Overridable via env `LESSON_PROFILE_PATH` for tests.

**Hard caps:** ≤60 lesson lines, ≤8 KB body (must fit a fable-lean plan prompt). Enforced by the module
on every write — never by convention.

**Exact line format** (one lesson per line, strictly machine-parseable):

```
- [domain] <rule text, imperative, ≤140 chars> | seen:N | last:YYYY-MM-DD | src:<slug.md> | fix-task:<taskId>
```

- `fix-task:` segment is present ONLY after the proactivity gate (§5) has fired for that line.
- Parse regex (anchor for the module):
  `^- \[([a-z0-9-]+)\] (.+?) \| seen:(\d+) \| last:(\d{4}-\d{2}-\d{2}) \| src:(\S+)(?: \| fix-task:(\S+))?$`
- Example:
  `- [pipeline] promoting a config is not shipping — verify the runtime consumes every key before claiming live | seen:3 | last:2026-07-05 | src:mechanism-without-trigger-is-dead-code.md`

File header (above the lines, written once, never parsed):

```markdown
# LESSON PROFILE — canonical, machine-maintained. Do not hand-edit lines; use lesson-profile.js.
# Cap: 60 lines. Write path: lesson-profile.js upsert. Read path: dynamic-pipeline plan stage.
```

---

## 2. WRITE PATH — `lesson-profile.js` (the only writer)

**New file:** `/Users/joshweiss/code/cortextos/.claude/workflows/lib/lesson-profile.js`
CommonJS, zero dependencies, mirroring `routing-policy.js` style (the ESM pipeline already loads CJS
libs fine via `await import` — see dynamic-pipeline.js lines 15–16).

**Exports:**

```js
module.exports = { upsertLesson, topLessons, readProfile, PROFILE_PATH };
```

### `upsertLesson({ domain, text, source })` — dedupe-on-write algorithm

1. **Normalize** `text`: lowercase → replace non-alphanumerics with spaces → collapse whitespace →
   tokenize → drop tokens <3 chars and a tiny fixed stopword set
   (`the,and,for,not,you,are,was,must,that,with,this,before,never,always`). No embeddings, no network.
2. **Exact short-circuit:** if normalized string equals an existing line's normalized text → increment.
3. **Jaccard match:** compute token-set Jaccard against every existing line (≤60 lines — trivial cost).
   Best score ≥ **0.6** → treat as the same lesson.
4. **On match:** `seen += 1`, `last = today`; **keep the original text** (first phrasing is the stable
   dedupe key — do not rewrite it). Then run the §5 threshold check.
5. **On no match:** append a new line with `seen:1 | last:today | src:<source>`.
6. **Eviction (only when line count > 60):** sort ascending by `(seen, last)`; drop the head — lowest
   recurrence, oldest last-seen. High-recurrence lines are structurally immortal.
7. **Atomic write:** whole-file read → rewrite to `PROFILE.md.tmp` → `renameSync` (matches the repo's
   atomic-write convention, `src/utils/atomic.ts`).

### `topLessons(n = 20)` — read helper

Sort by `(seen desc, last desc)`, take `n`, render as
`- [domain] <text> (seen ${N}×)` — metadata tail stripped, recurrence kept as a weight signal.
Returns `''` if the file is missing or empty (read path must be a no-op then, never a throw).

### CLI mode (Larry's manual/WAL capture — no new tooling layer)

Bottom of the same file:

```js
if (require.main === module) {
  const [cmd, domain, text, source] = process.argv.slice(2);
  if (cmd === 'add') { upsertLesson({ domain, text, source: source || 'manual' }); console.log('ok'); }
  if (cmd === 'top') { console.log(topLessons(Number(domain) || 20)); }
}
```

Usage Larry already understands (add one line to larry `OPERATIONS.md` memory protocol — via PR, the
larry dir is a tracked shared checkout):

```bash
node /Users/joshweiss/code/cortextos/.claude/workflows/lib/lesson-profile.js add pipeline "rule text" src-slug.md
```

### Automatic capture wire — Lessons stage feeds the profile

**File:** `/Users/joshweiss/code/cortextos/.claude/workflows/dynamic-pipeline.js`

**Wire 2a — schema (lines 380–389, the inline lessons schema):** add to `properties`:

```js
oneLiners: {
  type: 'array',
  items: {
    type: 'object', required: ['domain', 'lesson'],
    properties: { domain: { type: 'string' }, lesson: { type: 'string', description: 'imperative rule, <=140 chars' } },
  },
},
```

**Wire 2b — prompt (lines 373–378, the Lessons stage prompt):** append one sentence:
`"For EACH lesson file you write, ALSO return a matching oneLiner: {domain, lesson} — a <=140-char imperative rule."`

**Wire 2c — deterministic upsert (after `const lessons = await executeStage(...)`, i.e. immediately
after line 390):**

```js
for (const [i, l] of (lessons.oneLiners || []).entries()) {
  try { upsertLesson({ domain: l.domain, text: l.lesson, source: (lessons.lessonFiles || [])[i] || 'pipeline-run' }) }
  catch (e) { log(`lesson-profile upsert failed (non-fatal): ${e}`) }
}
```

The critical design point: **dedupe runs in code, not in the LLM.** The Lessons agent only emits
one-liners; the module decides append-vs-increment. Asking a model to dedupe a file is how you get 293
feedback files.

**Import (lines 15–23 block):** `const lessonProfileModule = await import('./lib/lesson-profile.js')`
then destructure `upsertLesson, topLessons` alongside the existing bridge/policy imports.

---

## 3. READ PATH — the missing wire Josh wants

The plan prompt is NOT assembled in `routing-policy.js` — that file only resolves routes
(`resolveStageRoute`, line 107). Prompt assembly lives in `dynamic-pipeline.js`. The single leanest
seam that catches **every** plan invocation — current (line 234) and any future caller — is
`executeStage()`:

**File:** `/Users/joshweiss/code/cortextos/.claude/workflows/dynamic-pipeline.js`
**Function:** `executeStage(stageName, prompt, baseOpts, bridgeOpts)` — **line 58**. Insert as the
first statement of the body:

```js
async function executeStage(stageName, prompt, baseOpts, bridgeOpts = {}) {
  if (stageName === 'plan') {
    const lessonsBlock = topLessons(20)
    if (lessonsBlock) {
      prompt =
        `LESSONS PROFILE — recurring failure modes from prior runs. Your plan MUST NOT repeat these:\n` +
        `${lessonsBlock}\n---\n\n` + prompt
    }
  }
  // ...existing body unchanged (lines 59–72)
```

Properties of this wire:
- **Automatic** — no stage author has to remember it; any new plan call site inherits it.
- **Lean-budget safe** — top-20 lines ≈ 2–3 KB, well inside the fable-lean context contract
  (routing-policy.js line 124–126 forces `route.lean = true` at plan; this block is small enough to
  ride inside it).
- **Fail-open** — missing/empty PROFILE.md ⇒ `topLessons` returns `''` ⇒ zero prompt change. The
  learning loop must never be able to break a pipeline run.

**Door A read-back (bus/OBF planning path, the other plan surface):** the dynamic pipeline covers
programmatic runs; Larry's OBF/M2C1 plans go out the bus door guarded by
`/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/.claude/hooks/gate-codexer-planning.sh`.
Add ONE check to that existing hook (it already validates `02-master-plan.md` freshness): block the
dispatch unless the slug's `02-master-plan.md` contains a `## Lessons Consulted` section (a plain
`grep -q '## Lessons Consulted'`). That forces every human-path plan to have read PROFILE.md, using
the gate that already exists — a 4-line addition to a live hook, not a new layer.
**FLAG:** I did not read `gate-codexer-planning.sh` this session (confirmed it exists via `ls`);
codexer must locate the exact insertion point next to the existing master-plan freshness check.

Out of scope (deliberately, keep the first cut minimal): injecting into review-escalation prompts.
Do it later only if the profile proves out at plan.

---

## 4. continuous-learning-v2 — the honest wiring decision: PARK IT

**Verified this session:** the installed skill at `~/.claude/skills/continuous-learning-v2/` contains
exactly three files — `SKILL.md` (in Japanese), `agents/observer.md`, `.skillfish.json`. The
PreToolUse/PostToolUse hook scripts, `observations.jsonl` writer, and instincts directories that its
own architecture diagram depends on **were never shipped**. There is nothing to wire — `grep` of
`~/.claude/settings.json` confirms no observe hook was ever registered.

"Wiring" CL-v2 therefore means *building* a hook-observer-instinct pipeline from scratch — a second,
heavier implementation of the exact loop §§1–3 deliver, and a textbook instance of the sloppy-layers
pattern Josh banned. Decision:

1. **Move the skill to** `~/.claude/_disabled-2026-07-04/continuous-learning-v2/` (the same graveyard
   as gstack/GSD — established convention, see `reference_gsd_durably_removed_2026-07-04`).
2. Its one good idea — **confidence/recurrence weighting** — is already absorbed as the `seen:` count.
3. Re-evaluate only if PROFILE.md outgrows a flat file (>60 durable lessons with real contention),
   which is the signal the review memo already set.

An installed-but-dead learning system is precisely the anti-pattern the lessons dir itself documents
(`mechanism-without-trigger-is-dead-code.md`). Removing it IS the fix.

---

## 5. PROGRAMMATIC PROACTIVITY — recurrence threshold auto-files a fix task

The rule, as a mechanism: **a lesson that recurs 3 times is no longer a lesson — it is a bug in the
system, and the system files its own fix task.** No human notices; the write path notices.

**Where it lives:** inside `upsertLesson()` in
`/Users/joshweiss/code/cortextos/.claude/workflows/lib/lesson-profile.js` — the write path is the only
place counts change, so the gate has exactly one home. After an increment:

```js
const THRESHOLD = 3;
if (line.seen >= THRESHOLD && !line.fixTask) {
  const title = `LESSON RECURRED x${line.seen} — build a durable fix: ${line.text.slice(0, 60)}`;
  const desc = `Lesson "[${line.domain}] ${line.text}" has recurred ${line.seen} times (last ${line.last}, src ${line.src}). ` +
               `Per the proactivity rule this is now a systems bug: design a durable programmatic fix (hook/gate/code), ` +
               `not another reminder. Source archive: /Users/joshweiss/code/knowledge-sync/lessons/`;
  try {
    const out = execFileSync('cortextos', ['bus', 'create-task', title,
      '--desc', desc, '--assignee', 'larry', '--priority', 'high', '--project', 'lessons-loop'],
      { encoding: 'utf8' });
    line.fixTask = out.trim();          // create-task prints the taskId (bus.ts line 241)
  } catch (e) {
    // fail-open: no marker written -> retries on the NEXT recurrence. Never blocks the pipeline.
  }
}
```

- **Fire-once guard:** the `fix-task:<id>` marker on the profile line. Fires on the crossing, not on
  every subsequent increment. (Honors the existing lesson
  `fire-once-guards-must-match-real-world-subject-variants.md` — the guard keys off the deduped
  canonical line, so phrasing variants can't double-fire.)
- **Assignee larry, priority high** — Larry triages at the next cron/session via the existing
  `list-tasks --status in_progress` protocol; `create-task` already auto-notifies the assignee
  (bus.ts lines 243–248). The bus stays the single source of truth for "what needs fixing."
- **FLAG:** `cortextos bus create-task` resolves agent identity from the process env (`resolveEnv()`,
  bus.ts line 229). When `upsertLesson` runs inside a pipeline/agent session that env is present; if
  the CLI is ever invoked from a bare shell without it, the try/catch swallows the failure and the
  no-marker retry covers it. Codexer: verify `resolveEnv()`'s exact env-var requirements when
  implementing (I did not read that function this session).

This clause is the codified answer to Josh's constitution question: detection of a recurring gap is an
**event in the write path with a mandatory side effect**, not an observation waiting for a human.

---

## Anti-goals (so nobody "improves" this into a layer cake)

- NO embedding/similarity service — token Jaccard on ≤60 lines is sufficient and free.
- NO new daemon, cron, or observer agent — capture rides the existing Lessons stage; the gate rides
  the existing write path; the alert rides the existing bus.
- NO second profile — feedback_*.md memories and knowledge-sync/lessons/*.md stay as archives;
  PROFILE.md is the only retrievable layer, and lesson-profile.js is its only writer.
- NO LLM-side dedupe — models emit candidates; code decides identity.

## Ordered implementation checklist (codexer — GATE: build, framework=one-big-feature, repo=/Users/joshweiss/code/cortextos)

1. **Create** `.claude/workflows/lib/lesson-profile.js` (CJS): parse/serialize per §1 line format;
   `upsertLesson` (normalize → exact → Jaccard ≥0.6 → increment-or-append → evict >60 by (seen asc,
   last asc) → atomic tmp+rename write); `topLessons(n)`; §5 threshold block with `fix-task:` marker;
   `require.main` CLI (`add`, `top`). Env override `LESSON_PROFILE_PATH`; default
   `/Users/joshweiss/code/knowledge-sync/lessons/PROFILE.md`. Fail-open everywhere (missing file,
   bad line, failed create-task ⇒ never throw into the pipeline).
2. **Tests** `tests/unit/workflows/lesson-profile.test.ts` (beside the existing
   `routing-policy.test.ts`): exact-dup increments; near-dup (word-order/tense variant) increments;
   distinct lesson appends; eviction drops lowest-(seen,last) at 61; threshold fires create-task once
   and stamps marker (mock execFileSync); marker present ⇒ no re-fire; missing PROFILE ⇒
   `topLessons` returns `''`; malformed line skipped not fatal.
3. **Wire dynamic-pipeline.js**: import lesson-profile (lines 15–23 block); plan-stage prepend at top
   of `executeStage` (line 58, §3 snippet); Lessons schema `oneLiners` (lines 380–389); Lessons
   prompt sentence (lines 373–378); post-stage upsert loop after line 390 (§2c).
4. **Seed PROFILE.md** (one-time script or manual pass, part of the PR): for each of the 19 files in
   `/Users/joshweiss/code/knowledge-sync/lessons/`, distill the title/lesson into one line via
   `lesson-profile.js add <domain> "<rule>" <filename>`; use file mtime date as `last`. Give
   `mechanism-without-trigger-is-dead-code.md` `seen:2` (documented Jul-3 → Jul-5 recurrence) —
   one more recurrence and the system files its first auto fix task, which is the point.
5. **Gate hook addition** in `orgs/clearworksai/agents/larry/.claude/hooks/gate-codexer-planning.sh`:
   block build dispatch when the slug's `02-master-plan.md` lacks `## Lessons Consulted` (read the
   hook first — insertion point beside the existing master-plan freshness check).
6. **Park CL-v2**: `mv ~/.claude/skills/continuous-learning-v2 ~/.claude/_disabled-2026-07-04/`
   (note: outside the repo — operational step in the PR description, not a commit).
7. **Docs, in the same PR**: one line in larry `OPERATIONS.md` memory protocol (WAL corrections also
   run `lesson-profile.js add ...`); PROFILE.md header per §1.
8. **Verify**: `npm run build && npm test`; then one live `dynamic-pipeline` smoke on a trivial seed
   task and confirm (a) the plan prompt artifact contains the `LESSONS PROFILE` block, (b) a synthetic
   duplicate one-liner increments `seen:` instead of appending. Screenshot/log both before claiming
   done — per `verify-the-built-artifact-not-the-source.md`, which will be line 1 of the profile.

**Open flags for codexer (only things not confirmed by a file read this session):**
`gate-codexer-planning.sh` internals (step 5 insertion point); `resolveEnv()` env-var requirements for
CLI-context create-task (§5); whether `agent()` prompt artifacts are persisted per-run for the step-8
verification (if not, log the assembled plan prompt length + first 200 chars from `executeStage`).

*Fable 5, 2026-07-05.*
