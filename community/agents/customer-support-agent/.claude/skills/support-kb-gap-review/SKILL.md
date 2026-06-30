---
name: support-kb-gap-review
description: "Identify repeated support questions, missing docs, weak macros, and product feedback patterns."
---

# Support KB Gap Review

Find repeated questions, unclear docs, macro gaps, bugs, feature requests, and escalation patterns.

## Inputs

- `support/kb-gaps/*.json`
- `support/reports/*.md`
- `support/macros.md`
- `support/config.json`
- `support/escalation-policy.json`
- Optional local docs or KB exports configured in `support/config.json`

## Workflow

1. Create or update a visible task and mark it `in_progress`.
2. Group KB gaps by product area, category, frequency, severity, and customer impact.
3. Identify weak macros, missing docs, stale policy, recurring bugs, product feedback, and escalation-policy ambiguity.
4. Draft proposed macro/doc changes locally. Do not publish docs or update external systems without approval.
5. Route follow-ups generically:
   - Docs gaps: create a task or handoff for the configured documentation owner or knowledge-base librarian.
   - Bugs/product feedback: create a task or handoff for the configured product/engineering owner.
   - Billing/legal/security/privacy gaps: escalate according to `support/escalation-policy.json`.
6. Write `support/reports/<date>-kb-gap-review.md`.
7. Update `MEMORY.md` with durable support lessons and macro/policy decisions.
8. Complete or block the task with a concise result.
