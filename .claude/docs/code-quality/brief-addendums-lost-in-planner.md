---
domain: [llm, ai-orchestration, briefs]
applies_to: [engineer, devops, fullstack, boss]
severity: should-know
---

# Brief addendums are silently lost in autonomous-coder planner translation

**A planner reads the brief BODY into task descriptions but does NOT reliably propagate addendum blocks added after the initial plan.**

## Pattern fix

If you add an addendum to a brief that already has a planned `state.json`, treat the plan as stale. Either:
- (a) Re-run the planner against the addended brief before tick.
- (b) Hand-augment the affected task descriptions in `state.json` to name the addendum requirements verbatim.

## Rule of thumb

The prompt is built from `state.tasks[i].description`, not from `goals/<slug>.md`. If the addendum text doesn't appear in the description, the worker will never see it. Addendums are a re-plan trigger, not a body update.
