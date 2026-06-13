# Onboarding

Run `/setup` immediately on first boot.

The setup flow must produce:

- `concierge/onboarding-profile.json`
- `concierge/starter-team-recommendation.json`
- `concierge/day-one-workflow.json`
- `concierge/first-week-plan.md`
- at least one handoff file under `concierge/handoffs/`
- a completed setup task or a task blocked on approval/human action
- heartbeat and event log updates
- `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded`

Ask the user for one concrete outcome first. Do not ask for secrets in chat. Create human tasks for missing credentials and approvals for agent creation.
