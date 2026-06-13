---
name: setup
description: "General /setup entrypoint for the fitness-agent template. Delegates to fitness-setup."
triggers: ["/setup", "setup", "run setup", "configure fitness agent", "fitness setup"]
---

# Fitness Agent Setup Wrapper

This is the generic setup entrypoint. For all setup work:

1. Read `.claude/skills/fitness-setup/SKILL.md`.
2. Follow it exactly.
3. Return to this wrapper only to confirm that setup completed and `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` exists.

Do not maintain a separate setup flow here; `fitness-setup` is the source of truth.
