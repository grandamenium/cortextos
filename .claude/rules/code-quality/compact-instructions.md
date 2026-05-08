# /compact instruction library

Canned `/compact` instructions used at decision points by the context-discipline system (BL-2026-05-08-004). Each instruction is opinionated and surgical: it names what to PRESERVE and what to DROP. "Summarize everything" is the failure mode this library exists to avoid.

Read this file when your `~/.cortextos/<inst>/state/<agent>/context-pct.json` reports `severity != green` and you are at a safe boundary (phase / feature / merge / mid-task emergency). Pick the instruction that matches the boundary you are at, then run `/compact <instruction text>`.

## At phase boundary (within same feature)

Use this BETWEEN phases of the same feature (e.g. between Phase 1 and Phase 2 of a multi-phase backlog item) when context-pct is at `yellow` and you have just committed a phase.

```
/compact preserve: current branch name, last 5 commits with their messages, current spec file paths, open file paths, in-flight TODO/blockers, this phase's acceptance criteria. drop: completed code-evaluator subagent transcripts, deep-eval discussions on already-merged PRs, exploration discussions on resolved questions, intermediate debugging chains where the bug is fixed.
```

## At feature merge (between features in the same task queue)

Use this AFTER a feature PR has merged and BEFORE picking up the next backlog item.

**Step 1 (mandatory):** write the 3-5 key learnings from the just-merged feature to MEMORY.md *first*. Don't compact until durable state is on disk.

**Step 2:**
```
/compact preserve: which feature just merged + the 3-5 key learnings (already in MEMORY.md), current backlog item if any, queue of upcoming tasks, MEMORY.md last-modified pointer. drop: ALL per-phase implementation details from the just-merged feature, all evaluator transcripts on its phases, intermediate debug chains, exploration on resolved questions.
```

## Before unrelated-task hard-restart (NOT compact — use hard-restart instead)

Use this branch when the next task is unrelated to the current one (different repo, different code area, different working surface).

**DO NOT `/compact` here.** Hard-restart with `--continue` gives a fresh session whose conversation history is preserved, and memory files (MEMORY.md, daily memory) carry the durable context forward. `/compact` followed by an unrelated task accumulates two layers of stale residue; hard-restart drops both cleanly.

```bash
cortextos bus hard-restart --reason "fresh-start for <new-task-name>"
```

## Mid-task emergency (severity=orange/red AND no phase boundary reachable)

Use this only when context-pct has crossed the orange/red threshold and you cannot safely reach a commit boundary first. This is the worst case — accept losing some live context.

**Step 1:** capture durable state to disk:
```bash
git add -A && git commit -m "wip: pre-compact safety commit"
```

**Step 2:**
```
/compact preserve: current uncommitted intent ("I am implementing X with approach Y, currently stuck on Z"), branch name, spec file path. drop: everything else aggressively. Be willing to lose subagent results — they can be re-fetched.
```

## Anti-patterns

- **Don't `/compact` mid-subagent dispatch.** Wait for the subagent to return — its result IS context, dropping it pre-merge wastes the call.
- **Don't `/compact` as a substitute for memory.** MEMORY.md and daily memory are the durable layer; `/compact` only manages live conversation context.
- **Don't reload recently-discarded context after a hard-restart.** Hard-restart's purpose is a fresh start; reloading defeats it.

## How thresholds drive these instructions

The context-discipline monitor computes severity from `current_loaded_tokens / context_limit` and the model-aware threshold table:

| Limit | green | soft | yellow | orange | red |
|---|---|---|---|---|---|
| 1M (Opus 1M) | <25% | 25–35% | 35–42% | 42–50% | ≥50% |
| 200k (Sonnet/Haiku/Opus default) | <50% | 50–65% | 65–75% | 75–85% | ≥85% |

| Severity | Action |
|---|---|
| green | No action |
| soft | Log heartbeat note: "context elevated, monitoring"; no `/compact` yet |
| yellow | Schedule `/compact` at next phase boundary (use *At phase boundary* template) |
| orange | `/compact` NOW with surgical instructions (use *At phase boundary* if reachable, else *Mid-task emergency*) |
| red | Hard-restart with `--continue` (use *Before unrelated-task hard-restart* template, OR if same task: hard-restart with --continue still — `/compact` at this point is too late) |

Source: BL-2026-05-08-004 (engineer context discipline) — sb-personal-org-only spec; not part of the upstream cortextOS installer payload. Adopting orgs can re-derive the threshold tables from observed Claude Code auto-compact pressure points (~350-450k on 1M Opus, ~150-160k on 200k models). Thresholds tuneable after 1-2 weeks of observation.
