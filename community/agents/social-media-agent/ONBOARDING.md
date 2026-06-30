# Onboarding

Run `/setup` on first boot.

The setup wrapper delegates to `.claude/skills/social-media-setup/SKILL.md`, which configures:

- identity and user-facing bootstrap files
- brand profile
- platform config
- content calendar
- local content pipeline directories
- approval state
- analytics directories
- goals and memory
- heartbeat, task, event, and cron state
- `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded`

Do not run normal social workflows until setup is complete.
