---
name: concierge-setup
description: "Interactive first-install setup for a generalized cortextOS Concierge agent. Run on first boot or when the user says /setup."
---

# cortextOS Concierge Setup

This is the production first-install flow. The goal is not to explain every feature; the goal is to make one useful workflow real and leave clean artifacts for follow-on agents.

## Required Outcome

Setup is complete only when all of these exist or are explicitly blocked on approval/human action:

- `concierge/onboarding-profile.json`
- `concierge/starter-team-recommendation.json`
- `concierge/day-one-workflow.json`
- `concierge/first-week-plan.md`
- at least one file in `concierge/handoffs/`
- a setup task marked completed or blocked
- heartbeat and event log updated
- `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded`

## Step 1: Create Setup Task

```bash
TASK_ID=$(cortextos bus create-task "Concierge first-install setup" --desc "Capture first outcome, discover tools, recommend starter team, write workflow and handoff docs, and complete onboarding." --assignee "$CTX_AGENT_NAME" --priority high | awk '/^task_/ {print $1; exit} /Task ID:/ {print $NF; exit}')
cortextos bus update-task "$TASK_ID" in_progress
cortextos bus update-heartbeat "setting up concierge onboarding"
cortextos bus log-event task task_created info --meta '{"task_id":"'$TASK_ID'","agent":"'$CTX_AGENT_NAME'","template":"cortextos-concierge"}'
```

If task creation fails, continue with local artifacts and log the failure in memory.

## Step 2: Ask for One Outcome

Ask only the minimum questions needed:

1. What is one outcome you want cortextOS to help with first?
2. What would make this useful in the next 24 hours?
3. Which tools are involved?
4. What should agents never touch?

Do not ask for secrets. If credentials are missing, create a `[HUMAN]` task.

## Step 3: Discover Tools Safely

Read `.claude/skills/tool-discovery/SKILL.md` and run the safe discovery commands. Record findings in the onboarding profile with secrets masked as `<configured>` or `<missing>`.

## Step 4: Write Onboarding Profile

Create `concierge/onboarding-profile.json` using `schemas/onboarding-profile.schema.json`. Include:

- desired outcome
- 24-hour success signal
- boundaries and never-touch list
- available tools
- missing credentials as human tasks
- approval policy
- local timezone

## Step 5: Recommend Smallest Starter Team

Read `.claude/skills/template-recommender/SKILL.md`.

Write `concierge/starter-team-recommendation.json` using `schemas/starter-team.schema.json`. Recommend one primary starter agent whenever possible, with optional second agent only if it clearly unlocks the first workflow. Include why excluded agents are not needed yet.

## Step 6: Build Day-One Workflow

Read `.claude/skills/starter-workflow-builder/SKILL.md`.

Write `concierge/day-one-workflow.json` using `schemas/workflow-plan.schema.json` and a readable companion under `concierge/workflows/day-one.md`.

The workflow must be local-file-first and include:

- trigger/input
- agent roles
- exact first task
- approval gates
- expected output path
- done criteria
- rollback or pause condition

## Step 7: Create Approval Before Agent Creation

Before installing templates or creating agents:

```bash
APPR_ID=$(cortextos bus create-approval "Create approved starter agent team" "other" "Review concierge/starter-team-recommendation.json and concierge/day-one-workflow.json. Approval permits installing listed templates and creating listed agents only.")
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Approval needed: create starter agent team - check dashboard"
cortextos bus update-task "$TASK_ID" blocked
cortextos bus log-event task task_blocked info --meta '{"task_id":"'$TASK_ID'","blocked_by":"'$APPR_ID'","reason":"awaiting approval for agent creation"}'
```

Stop after requesting approval if the user's decision is required. When approved, unblock the task and continue. If rejected, update recommendations and do not create agents.

## Step 8: Write Handoff Docs

Read `.claude/skills/handoff-to-starter-agent/SKILL.md`.

For each approved starter agent, write:

- `concierge/handoffs/<agent-name>.md`
- first task title and description
- relevant files
- boundaries and approval rules
- success criteria

## Step 9: First-Week Plan

Read `.claude/skills/first-week-plan/SKILL.md`.

Write `concierge/first-week-plan.md` with:

- day 1: first workflow
- day 3: review and narrow/expand
- day 7: keep, change, or retire starter agents
- crons to keep
- user decisions still needed

Refresh `GOALS.md`, `goals.json`, and `MEMORY.md` with the user's chosen outcome, starter team, and active blockers. Do not include secrets.

## Step 10: Complete Onboarding

```bash
mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory
printf '\n## Concierge Setup - %s UTC\n- Status: complete or blocked with explicit approval/human task\n- Profile: concierge/onboarding-profile.json\n- Starter team: concierge/starter-team-recommendation.json\n- Workflow: concierge/day-one-workflow.json\n- Handoffs: concierge/handoffs/\n' "$(date -u +%H:%M:%S)" >> "memory/$TODAY.md"
cortextos bus update-heartbeat "concierge setup complete"
cortextos bus log-event action workflow_completed info --meta '{"agent":"'$CTX_AGENT_NAME'","workflow":"concierge-setup"}'
cortextos bus complete-task "$TASK_ID" --result "Concierge setup artifacts created and onboarding marked complete."
cortextos bus log-event task task_completed info --meta '{"task_id":"'$TASK_ID'","agent":"'$CTX_AGENT_NAME'"}'
```

If setup is blocked on approval or human action, do not touch `.onboarded` until the remaining action is explicit and visible.
