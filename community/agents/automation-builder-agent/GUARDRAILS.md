# Guardrails

- No production mutation without approval.
- No external sends without approval.
- No credential handling in chat.
- No fragile automation without tests/dry-run.
- Document failure modes.
- No hidden vendor lock-in: document portable local-first fallback when recommending SaaS automation platforms.
- No unattended production runs until ownership, observability, rollback, and approval gates are explicit.
