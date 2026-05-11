---
name: dispatch-protocol
description: On-receipt decision flow for every inbox message — FRESH-START annotation parsing, cooldown check, RELATED/UNRELATED heuristic, and the hard-restart-or-process decision matrix. Trigger when you see "=== AGENT MESSAGE from ..." or process check-inbox output.
---

# Dispatch-receipt protocol (BL-2026-05-08-004 Phase 3)

When you receive an inbox message, decide whether to hard-restart **before** acting on it. Same flow for every inbox message — treat it as a precondition, not optional.

## Step 1 — read the `[FRESH-START: ...]` annotation if present

Sender annotates by passing `--fresh-start` or `--no-fresh-start` to `cortextos bus send-message`. Three observable forms:

- `[FRESH-START: sender requests hard-restart before processing ...]` → `fresh_start=true`
- `[FRESH-START: explicit override — sender says do NOT hard-restart ...]` → `fresh_start=false`
- No annotation line → no hint; run the heuristic in Step 3

## Step 2 — check the cooldown (only if decision might be a restart)

If annotation is `false` (explicit no), skip cooldown check. Otherwise (annotation `true` or absent):

```bash
cortextos bus check-fresh-restart-cooldown
# JSON: {last_at, age_seconds, on_cooldown, cooldown_seconds_remaining, cooldown_seconds_total}
```

Default window 30 minutes. On cooldown means a recent fresh-restart already covered the transition.

## Step 3 — apply the decision matrix

| Hint from annotation | Heuristic verdict | On cooldown? | Action |
|---|---|---|---|
| `true` (explicit yes) | (skip — explicit wins) | no | hard-restart with `--fresh-start`, then process |
| `true` (explicit yes) | (skip — explicit wins) | yes | hard-restart with `--fresh-start` anyway (explicit user intent overrides cooldown) |
| `false` (explicit no) | (skip — explicit wins) | (skip) | process in current session |
| absent | UNRELATED | no | hard-restart with `--fresh-start`, then process |
| absent | UNRELATED | yes | log skip event, process in current session |
| absent | RELATED | (skip) | process in current session |

Row 2 bypasses cooldown because cooldown is a guard against the AGENT'S heuristic looping; when the SENDER passes `--fresh-start` explicitly, that overrides the heuristic guard.

## Self-detection heuristic (Step 3 row "absent")

You read the dispatch text and compare to your current state. **UNRELATED if any:**

- Different target repo (last work was repo A, dispatch references repo B)
- Different working surface (last was backend code, dispatch is dashboard UI)
- Different code area, low file-path overlap with last commits / spec / current branch

**NOT-UNRELATED (when in doubt, treat as RELATED):**

- Same-branch continuation (between phases of the same feature)
- Quick clarification round-trip with the user (not a new task)
- Subagent dispatch (already isolated)
- Mid-subagent in flight: wait for it to return before deciding

## Step 4 — execute

If decision is "hard-restart with `--fresh-start`":

```bash
git add -A && git commit -m "wip: pre-fresh-restart safety commit" || true
cortextos bus hard-restart --fresh-start --reason "fresh-start for <new-task-summary>"
```

If decision is "log skip and process in current session":

```bash
cortextos bus log-event action fresh_restart_skipped info \
  --meta '{"reason":"<on_cooldown|explicit_override|heuristic_related>","dispatch_msg_id":"<id>","cooldown_seconds_remaining":<N>}'
```

## Anti-patterns

- Don't hard-restart between phases of the same feature.
- Don't hard-restart on a clarification message in an existing thread.
- Don't hard-restart while a subagent is mid-flight; its result is context the new session would lose.
- Don't pass `--fresh-start` to context-overflow restarts (FastChecker Tier-2/3 path) — they shouldn't consume the cooldown window.
- Don't reload recently-discarded conversation context after a fresh-restart. MEMORY.md / daily memory / git log ARE the recovery layer.

## Reply format

Always include `msg_id` as reply_to (auto-ACKs the original). Un-ACK'd messages redeliver after 5 min.

```bash
cortextos bus send-message <agent> normal '<reply>' <msg_id>
# no-reply ACK:
cortextos bus ack-inbox <msg_id>
```
