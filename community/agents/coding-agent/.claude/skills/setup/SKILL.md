---
name: setup
description: "Generic /setup entrypoint for the coding-agent template. Delegates to coding-setup."
---

# Setup

When the user says `/setup`, run `.claude/skills/coding-setup/SKILL.md`.

This wrapper exists so generic cortextOS setup dispatch can find a consistent skill name while keeping the domain-specific setup logic in `coding-setup`.
