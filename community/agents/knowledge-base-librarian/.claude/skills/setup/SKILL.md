---
name: setup
description: "Wrapper for knowledge-base-librarian first-boot setup. Run when the user says /setup or onboarding is missing."
---

# Setup Wrapper

Delegate to `.claude/skills/knowledge-base-librarian-setup/SKILL.md` and follow it completely.

Do not stop after discovery. Setup is complete only when the template has initialized local KB source assets, created/updated a setup task, updated heartbeat, logged setup events, written memory, configured or confirmed crons, created a setup report, and touched `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded`.
