---
domain: [cortextos-config, models]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# Harness-internal model-variant IDs are not user-passable via config.json or --model

**The Claude Code CLI resolves runtime model variants (`opus[1m]`, `sonnet[1m]`, etc.) post-gate-removal as internal markers; they are NOT strings a user passes through configuration.** If `model: "opus[1m]"` lands in an agent's `config.json`, the CLI rejects it as "unrecognized model" and the agent crashes on boot.

## Pattern fix

Use only published aliases (`opus`, `sonnet`, `haiku`) or full IDs (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) in any user-visible config field. The 1M-context flip is controlled by env (`CLAUDE_CODE_DISABLE_1M_CONTEXT=true|false`), not by suffixing the model string.

## Rule of thumb

If the model string contains a `[bracket]` suffix and you're putting it in a config or CLI flag, you're misusing an internal marker — read the runtime's docs before saving.

## Source incident

Micro-retro 2026-05-05 14:41 UTC — engineer edited config.json to `opus[1m]`, hard-restarted, session crashed on boot, 9 min downtime; boss reverted and restarted cleanly. Same trap likely lives in any framework that exposes a "default model" string-typed field.
