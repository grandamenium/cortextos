## Summary
<!-- 1-3 sentences: what changed and why -->

## Test plan
<!-- How to verify this change works -->

## Checklist

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] No new secrets or credentials committed
- [ ] **Agent Awareness:** if this adds a command, endpoint, hook, or behavior change — updated the relevant `templates/*/CLAUDE.md` template(s)
- [ ] **Migration Parity:** if this changes agent-installed files (hooks, settings.json defaults, CLAUDE.md sections) — existing agents will receive the change on next restart, not just new agents via `init`
