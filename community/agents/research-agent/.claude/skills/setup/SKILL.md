---
name: setup
description: "Canonical /setup entrypoint for the research-agent template. Delegates to research-agent-setup."
---

# Setup Wrapper

When the user says `/setup`, `setup`, or asks to configure this research agent, run `.claude/skills/research-agent-setup/SKILL.md`.

This wrapper exists so generic cortextOS setup dispatch can find a consistent skill name while the research-specific setup flow stays in `research-agent-setup`.

Setup is complete only after the domain setup skill has created or updated the setup task, configured research files and crons, updated heartbeat, written memory, logged setup events, and touched `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded`.
