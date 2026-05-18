---
name: error-postmortem
description: "You just triggered a guardrail, a task you owned failed, or you caught yourself going down a wrong path that wasted real time. This is when you write a structured postmortem (MISTAKE / ROOT CAUSE / PREVENTION) to today's daily memory, so the failure becomes a lesson instead of just a scar. Pairs with the event-logging skill — postmortems can reference the guardrail_triggered event id that prompted them. Hermes protocol #4."
triggers: ["guardrail triggered", "task failed", "went wrong", "post-mortem", "postmortem", "root cause", "after a failure", "after error", "i messed up", "wasted time", "false start"]
---

# Error Postmortem (Hermes Protocol #4)

After every guardrail trigger or task failure, write a structured postmortem so the fleet learns instead of re-stepping on the same rake.

---

## When to fire

1. You ran `cortextos bus log-event action guardrail_triggered ...` — postmortem in the same session.
2. A task you owned hit `status=failed`, or `complete-task` was called but the result was "did not ship" / "blocked" / "rolled back."
3. You caught yourself rationalizing past a guardrail and stopped — log the catch and the prevention even though no real damage was done. Those are the best lessons.
4. You wasted >15 min on a wrong path (e.g. assumed a premise that turned out false). Capture the false premise.

If a guardrail fires and you do NOT file a postmortem, you are not actually treating it as a system that matters.

## Command

```bash
cortextos bus postmortem \
  --mistake "<what you did or almost did>" \
  --root-cause "<why — usually an assumption you held that turned out wrong>" \
  --prevention "<concrete check that would have caught it earlier>" \
  [--related-event <event_id>]
```

The CLI appends a block to `memory/$(date -u +%Y-%m-%d).md`:

```
## Postmortem HH:MM UTC (event <id>)
- MISTAKE: ...
- ROOT CAUSE: ...
- PREVENTION: ...
```

It also logs a `postmortem_filed` action event for dashboard surfacing. Unlike task reflections, postmortems are NOT deduped — multiple per day are normal, especially on bad days.

## Linking to the guardrail event

If you triggered a guardrail event and want the postmortem to point at it:

```bash
# 1. Trigger the event and capture its id (printed by log-event)
EVENT_ID=$(cortextos bus log-event action guardrail_triggered info \
  --meta '{"guardrail":"verify-before-execute","context":"assumed gitea was reachable from MacBook"}' \
  | awk '{print $NF}')

# 2. File the postmortem referencing it
cortextos bus postmortem \
  --mistake "tried to git fetch gitea from MacBook" \
  --root-cause "assumed tailnet routes port 3030 — it does not, only SSH proxies through" \
  --prevention "for cross-host code moves: format-patch + scp + git am, never git fetch across hosts" \
  --related-event "$EVENT_ID"
```

## What makes a good postmortem

| Field | Good | Bad |
| ----- | ---- | --- |
| MISTAKE | "shipped a fix to fast-checker without re-running the integration suite" | "I broke something" |
| ROOT CAUSE | "I assumed unit tests covered the inject path; they don't — only integration suite exercises the daemon → PTY round trip" | "did not test enough" |
| PREVENTION | "for any fast-checker change: run `npm run test:integration` AND verify drop-event metrics before commit" | "test more" |

Postmortems are for the future you, not for current-you's ego. Aim for specificity that would actually have stopped the failure. If your PREVENTION is "be more careful," rewrite it.

## What NOT to postmortem

- Predicted failures (you tried something you flagged as risky, it failed as expected) — that is just an experiment.
- One-off externalities (a network blip, a flaky test) unless the system should have been robust to them.
- Trivial typos / corrections you caught yourself within seconds.

## Cross-cutting → durable memory

If the same ROOT CAUSE shows up in 2-3 postmortems, it is a pattern worth promoting to a durable feedback memory (see CLAUDE.md auto-memory section). The Hermes weekly audit (protocol #6) will surface these. Pre-empt it: write the feedback memory now while it is fresh.

## Related

- `.claude/skills/event-logging/SKILL.md` — log guardrail_triggered events that postmortems reference.
- `.claude/skills/task-reflection/SKILL.md` — sister protocol for completions (Hermes #1).
- `GUARDRAILS.md` — the live guardrail list whose violations trigger postmortems.
- `SOUL.md` — collaboration values that, when violated, also warrant postmortems.
