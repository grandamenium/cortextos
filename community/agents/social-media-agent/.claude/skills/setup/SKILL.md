---
name: setup
description: "Canonical /setup entrypoint for this social media agent template. Delegates to social-media-setup."
---

# Setup Wrapper

When the user says `/setup`, run `.claude/skills/social-media-setup/SKILL.md`.

This wrapper exists so generic `/setup` dispatch works even when the domain setup skill is named `social-media-setup`.
