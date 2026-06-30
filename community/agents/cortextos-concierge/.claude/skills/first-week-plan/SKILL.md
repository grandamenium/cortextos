---
name: first-week-plan
description: "Create and maintain a practical first-week cortextOS rollout plan with tasks, agents, tools, crons, approval gates, and success criteria."
---

# First Week Plan

The first week is a controlled rollout, not a feature tour.

## Inputs

- `concierge/onboarding-profile.json`
- `concierge/starter-team-recommendation.json`
- `concierge/day-one-workflow.json`
- `concierge/handoffs/`
- task and approval state

## Plan Sections

Write `concierge/first-week-plan.md` with:

1. Day 1 useful workflow and done criteria.
2. Day 2-3 review: what worked, what stalled, what to remove.
3. Day 4-6 optional expansion only if day-one flow is working.
4. Day 7 decision: keep, change, add, or retire agents.
5. Tool connection checklist with human tasks for missing credentials.
6. Crons to keep, pause, or add.
7. What the user should ignore for now.
8. Success criteria for day 1, day 3, and day 7.

## Review Behavior

On each first-week review cron:

- create a review task
- inspect current artifacts and task state
- update the plan with progress and blockers
- do not create new agents without approval
- complete the review task or block it on a specific approval/human task
