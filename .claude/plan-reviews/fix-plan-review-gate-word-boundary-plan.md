---
branch: fix/plan-review-gate-word-boundary
task: task_1777093291910_415
created: 2026-04-25T06:40:00Z
---

# Plan Review: Tighten plan-review gate FAIL/REJECT/BLOCK match to word boundaries

## Goal

Close the false-positive gap I filed against my own gate while shipping PR #248. The persona-row verdict check at `scripts/plan-review-gate.sh:149` uses a substring grep:

```sh
if echo "$PERSONA_LINE" | grep -qiE "FAIL|REJECT|BLOCK"; then
```

This false-positives on prose words like "failure", "blocking", "non-blocking", "unblocking", "rejection" that authors legitimately use in plan-review notes. I hit it twice this session — PR #245 ("hook failure cannot corrupt a merge") and PR #248 ("non-blocking so a slow Telegram cannot wedge"). Both forced me to rewrite legitimate prose just to satisfy the regex. The gate is supposed to catch a Security/DataIntegrity reviewer marking the row as not-PASS, not to censor prose vocabulary.

## Plan

### `scripts/plan-review-gate.sh`

Switch from `grep -iE "FAIL|REJECT|BLOCK"` to `grep -wiE "$PERSONA_VERDICT_PATTERN"` where the pattern is an explicit list:

```
FAIL|FAILED|FAILS|REJECT|REJECTED|REJECTS|BLOCK|BLOCKED|BLOCKS
```

`-w` (word-boundary) is a BSD/GNU grep flag that requires the match to start at a non-word boundary and end at a non-word boundary. Word characters are alphanumeric + underscore. So:
- "FAIL" → match (whole word)
- "FAILED" → match (whole word, in the explicit list)
- "FAILURE" → no match (the word doesn't equal any list entry exactly)
- "BLOCKING" → no match (likewise)
- "non-blocking" → no match (hyphen is non-word, but the word "blocking" doesn't equal "BLOCK"/"BLOCKED"/"BLOCKS")
- "Verdict: FAIL" → match (FAIL is its own word inside the line)
- "BLOCKED: needs sec review" → match (BLOCKED is its own word)

### Tests

`tests/unit/scripts/plan-review-gate.test.ts` (new, ~190 lines, ~13 cases). Builds a real scratch git repo + plans dir, invokes the script via `bash` with env-var test seams (`PLAN_REVIEW_DIR`, `PLAN_REVIEW_BRANCH`), asserts exit code + stderr/stdout. Mirrors the pattern used by `tests/unit/scripts/auto-deploy-supabase.test.ts`.

Coverage:
- Verdicts that MUST still BLOCK: FAIL, REJECTED, BLOCK, BLOCKED, FAILS, lowercase fail
- Prose that must NOT block: "failure", "non-blocking", "blocking", "unblocking", "rejection"
- Compositions: trivial-exempt path, missing-QUORUM-line BLOCK

### Out-of-scope

- Adding WARN as a third non-PASS verdict — would expand the rule's intent. If a reviewer wants to soft-warn, they currently use prose in the row (which now actually works, post this fix). Tracked separately if needed.
- Migrating the gate from bash to node — bash 3.2 is the constraint. Node version would unlock proper word-boundary regex (`\b`) but the `-w` flag handles the macOS case fine.

## Reviewer Panel (10 personas)

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | Pattern is more permissive on prose, MORE strict on what counts as a verdict (only the whole word). No new attack surface. The gate is defense-in-depth UX, not authorization. |
| DataIntegrity | PASS | No data writes. Script is read-only against the plan file. The original PR #243 telemetry path (cortextos bus log-event) is unchanged. |
| Performance | PASS | One regex match per persona per push. Trivial. |
| UX | PASS | This is the WHOLE point of the fix — authors no longer need to rewrite legitimate prose that happens to share a substring with FAIL/BLOCK/REJECT. Faster ship cycles, fewer "wait what" moments. |
| Architecture | PASS | One-line pattern change + one helper variable. Clean. The grep flag (`-w`) is portable to GNU + BSD grep, so macOS + Linux behavior is identical. |
| Maintainability | PASS | Pattern is in a named variable (`PERSONA_VERDICT_PATTERN`) at the top of the persona check loop, with a comment block explaining the why and citing this task ID + PR #248 as the bite that motivated it. Future maintainers don't need to re-derive the rationale. |
| Testing | PASS | 13 cases cover the verdict-must-block side, the prose-must-pass side, and the composition with trivial-exempt + missing-QUORUM paths. Real shell invocation, real git repo, real fs — same precedent as the auto-deploy-supabase tests. |
| ProductFit | PASS | Direct fix for the friction I caused myself in PR #245 + PR #248. Boss flagged it as a real gap worth filing. Closing-the-loop on tooling I shipped. |
| DevOps | PASS | No deploy story changes. Hook installation unchanged. The pattern fix is forward-only — existing plan files that previously squeaked through with "FAIL"-substring prose on a non-mandatory persona will continue to behave the same way (the persona check only looks at Security + DataIntegrity rows). |
| Skeptic | PASS | Concerns considered: (a) what if a reviewer writes "Security | FAIL — wait actually PASS" — gate still blocks (FAIL is its own word; that's the right call, the reviewer should pick one); (b) what about WARN as a soft non-PASS — out of scope, see notes; (c) what if grep -w isn't available on some POSIX implementation — both BSD (macOS) and GNU (Linux) grep support -w; the gate already requires bash 3.2, so we're inside the same compatibility envelope. |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

| Symbol | Production callsite |
|---|---|
| `PERSONA_VERDICT_PATTERN` (new variable) | `scripts/plan-review-gate.sh:153` (the verdict check inside the persona loop) |
| Updated `grep -wqiE` invocation | Same persona check loop |

## Notes

- This branch is based on `feat/pre-pr-plan-review-gate` (PR #243), not main, because the gate script doesn't exist on main yet. Open this PR with base = `feat/pre-pr-plan-review-gate` so the diff is clean. When #243 merges to main, this PR's diff will rebase cleanly.
- Notice that this very plan file would have tripped the OLD pattern (Skeptic row mentions "BLOCK" inside "block" prose, mandatory persona rows use "non-blocking" / "rejection"). With the FIXED pattern it passes — which is the whole proof that the fix works.
