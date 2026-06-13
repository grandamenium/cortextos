---
name: onboarding
description: "First-boot onboarding for the fitness-agent template. Delegates to /setup and blocks normal operation until the fitness profile, operating files, crons, heartbeat, task, events, memory, and .onboarded flag exist."
triggers: ["onboarding", "/onboarding", "first boot", "run onboarding", "setup", "not onboarded", "configure agent", "fitness setup"]
---

# Fitness Agent Onboarding

This skill runs on first boot or when explicitly triggered. Do not start normal operations until onboarding is complete.

## 1. Check Onboarding Status

```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If already `ONBOARDED`, continue normal session start unless the user explicitly asked to re-run setup.

## 2. Read Template Protocol

```bash
cat AGENTS.md
cat ONBOARDING.md
```

## 3. Run Setup

Read and follow the setup wrapper:

```bash
cat .claude/skills/setup/SKILL.md
cat .claude/skills/fitness-setup/SKILL.md
```

Setup must establish:

| Item | Expected artifact |
|---|---|
| Agent operating protocol | `AGENTS.md`, `CLAUDE.md`, bootstrap files |
| Fitness profile | `fitness/profile.json` |
| Runtime directories | `fitness/profile/`, `fitness/plans/`, `fitness/checkins/`, `fitness/logs/`, `fitness/reviews/` |
| Schemas and examples | `fitness/schemas/`, `fitness/examples/` |
| Starter plan/check-in/review/log | dated files under `fitness/` |
| Goals | `GOALS.md`, `goals.json` |
| Memory | `memory/YYYY-MM-DD.md` |
| Task tracking | setup task created, in progress, and completed |
| Events | setup started/completed and task completed events |
| Heartbeat | current heartbeat updated |
| Crons | heartbeat, morning plan, evening review, weekly review |
| Completion flag | `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` |

## 4. Mark Complete

If setup completed but the flag is missing:

```bash
mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
```

Then notify the user with a concise setup summary: goals, safety boundaries, opted-in tone, source of truth, and next scheduled check-in.

## Critical Rules

- Do not claim setup is complete until `.onboarded` exists.
- Do not provide fitness coaching before safety boundaries and opt-in tone are known.
- Do not connect, send, publish, delete, purchase, or book anything externally without approval.
- If user answers are required, ask the batch and stop so their reply can arrive.
