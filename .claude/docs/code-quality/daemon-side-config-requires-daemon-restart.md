---
domain: [cortextos-config, daemon, deployment]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# Daemon-side config fields require daemon-restart, not per-agent restart

**Configuration fields consumed by the daemon process (not the agent prompt) require daemon-restart to activate, not per-agent restart.** Per-agent soft-restart cycles them under the SAME compiled parent daemon, so daemon-side gates remain on the old compiled code regardless of how many times the agent restarts.

## Pattern fix

The compile-time + run-time path matters: source-code change → `npm run build` → daemon-process restart (e.g. `pm2 restart cortextos`) → child agents pick up new behavior on respawn. Per-agent restarts are useful for agent-prompt changes (CLAUDE.md, AGENTS.md, HEARTBEAT.md, MEMORY.md), NOT for daemon-side TS code that gates spawning, scheduling, hooks, or polling.

Generalizable to any future field added to `AgentConfig` that's read by daemon-side TypeScript (`src/daemon/*`, `src/pty/*`, `src/cli/*` long-running paths).

## Rule of thumb

If the field is read by code that lives in the parent process and doesn't get re-read on agent-respawn, you need a daemon restart. PR descriptions that introduce such fields MUST call out the activation sequence explicitly — pr-deep-evaluator validates code correctness, not deployment-sequence correctness; those are separate audits. Don't rely on deep-eval to catch a stale activation premise.

## Source incident

Micro-retro 2026-05-08 — analyst's PR #4 description proposed "boss restart engineer + analyst" as the activation path for `telegram_polling: false`, but the gate is in `src/daemon/agent-manager.ts` (parent process), not in agent sessions. Boss caught the bug post-merge before fleet restart was attempted; pr-deep-evaluator's verification recommendations had listed the per-agent log-line check without questioning the activation premise. Trap survived deep eval because deep eval scope ends at code-merge-readiness, not deployment.
