# cortextOS Concierge

The recommended first community template for new cortextOS users. The Concierge is a first-install/onboarding agent that turns one desired outcome into a safe starter workflow.

The Concierge helps users:

- understand what cortextOS can do for them
- connect tools safely
- choose the right starter templates
- create their first useful workflows
- set up tasks, crons, approvals, memory, and outputs
- avoid overbuilding before the system is useful

Run `/setup` immediately after install.

## Happy Path

1. User gives one outcome.
2. Concierge discovers available tools and constraints.
3. Concierge recommends the smallest starter team.
4. User approves any agent creation/install actions.
5. Concierge writes handoff docs and a first workflow plan.
6. Starter agent begins from the handoff with tasks and success criteria.

Agent creation and template installation are always approval-gated.

## Modular Pairings

The Concierge can recommend and hand off to:

- `knowledge-base-librarian`
- `project-manager-agent`
- `sales-followup-agent`
- `customer-support-agent`
- `learning-coach-agent`
- `automation-builder-agent`
- `agentic-crm-assistant`
- `social-media-agent`
- `research-agent`
- `coding-agent`
- `fitness-agent`

## Template Assets

- `AGENTS.md`: runtime operating protocol.
- `.claude/skills/setup/SKILL.md`: generic `/setup` wrapper.
- `.claude/skills/concierge-setup/SKILL.md`: first-install setup flow.
- `.claude/skills/template-recommender/SKILL.md`: starter team recommendation.
- `.claude/skills/starter-workflow-builder/SKILL.md`: day-one workflow builder.
- `.claude/skills/handoff-to-starter-agent/SKILL.md`: approval-safe handoff flow.
- `schemas/`: JSON schemas for setup artifacts.
- `examples/`: valid examples for onboarding profile, starter team, workflow plan, and template map.
