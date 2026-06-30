---
name: template-recommender
description: "Recommend the smallest safe starter team of cortextOS templates based on one user outcome, available tools, risk tolerance, and first useful workflow."
---

# Template Recommender

Recommend the fewest agents that can make the user's next 24 hours useful. Default to one starter agent plus the Concierge unless there is a strong reason for a second.

## Inputs

- `concierge/onboarding-profile.json`
- available community catalog entries
- user's never-touch boundaries
- missing credential/human tasks
- first workflow candidate

## Recommendation Rules

- Start with the outcome, not the catalog.
- Choose one primary agent when possible.
- Add a second agent only when it removes a real blocker.
- Exclude appealing-but-unneeded agents and explain why they can wait.
- Prefer local-file-first workflows over connector-heavy workflows.
- Never recommend agent creation as already approved.

## Template Map

Use `examples/template-map.json` as the starter map and update locally if the installed catalog differs.

Common mappings:

- Documents, notes, files, search, personal knowledge: `knowledge-base-librarian`
- Projects, tasks, recurring reviews, coordination: `project-manager-agent`
- Repetitive tool workflows or scripts: `automation-builder-agent`
- Customer tickets, support inboxes, macros: `customer-support-agent`
- Outreach, follow-ups, CRM hygiene: `sales-followup-agent` or `agentic-crm-assistant`
- Social posts, content calendar, analytics: `social-media-agent`
- Research briefs, monitoring, source synthesis: `research-agent`
- Code changes, repo triage, CI: `coding-agent`
- Learning plans and study routines: `learning-coach-agent`
- Fitness or habit plans: `fitness-agent`

## Output

Write `concierge/starter-team-recommendation.json` using `schemas/starter-team.schema.json`.

Include:

- recommended agents
- purpose for each
- first task for each
- dependencies and credentials needed
- approval required before creation
- alternatives considered
- agents intentionally deferred

Do not install or create agents from this skill. Hand the recommendation to the approval flow in `concierge-setup`.
