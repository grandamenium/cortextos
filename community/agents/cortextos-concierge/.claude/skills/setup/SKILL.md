---
name: setup
description: "Generic /setup entrypoint for the cortextOS Concierge template. Delegates to concierge-setup."
---

# Setup Wrapper

When the user says `/setup`, `run setup`, or first boot reports `NEEDS_ONBOARDING`, read and execute:

```bash
cat .claude/skills/concierge-setup/SKILL.md
```

Then follow the concierge setup flow exactly. This wrapper exists so generic setup dispatch works even when framework support expects `.claude/skills/setup/SKILL.md`.
