---
name: human-tasks
description: "You have hit a blocker that is not a permission issue — it is a capability issue. You genuinely cannot complete the next step because it requires a human: making a payment, entering credentials for a service you cannot access, physical action, a decision that only the user can make, or anything else outside your capabilities. You need to create a clear [HUMAN] task with step-by-step instructions, block your own work on it, and notify the orchestrator so this surfaces in the next briefing."
triggers: ["human task", "need human", "can't do this myself", "requires human", "needs you to", "blocked by human", "human input needed", "waiting for human", "human only", "physical access", "payment required", "login required", "credentials I don't have", "needs human action", "only you can", "human decision", "manual step required", "create human task", "assign to human", "[HUMAN]"]
---

# Human Tasks

A human task is for when you CANNOT do something — it requires human capability. This is different from an approval (where you can do it but need permission).

| Situation | Use |
|-----------|-----|
| "I can do this but need sign-off" | Approval (see approvals skill) |
| "I cannot do this at all — needs a human" | Human task (this skill) |

---

## Creating a Human Task

Three signals tell the dashboard to route this to "Your Tasks" — all three are required:
1. Title must start with `[HUMAN]`
2. `--assignee human`
3. `--project human-tasks`

```bash
# 1. Create the human task with clear step-by-step instructions
HUMAN_TASK_ID=$(cortextos bus create-task \
  "[HUMAN] <what needs to be done>" \
  --desc "<step-by-step instructions — be specific enough for the human to complete without asking you>" \
  --assignee human \
  --priority normal \
  --project human-tasks)

echo "HUMAN_TASK_ID=$HUMAN_TASK_ID"

# 2. Block your own task on it
cortextos bus update-task "$YOUR_TASK_ID" blocked
cortextos bus log-event task task_blocked info --meta "{\"task_id\":\"$YOUR_TASK_ID\",\"blocked_by\":\"$HUMAN_TASK_ID\",\"reason\":\"human dependency\"}"

# 3. Notify orchestrator to surface in next briefing
cortextos bus send-message "$CTX_ORCHESTRATOR_AGENT" normal \
  "Human task created: [HUMAN] <title> — needed before I can proceed with <your task title>"

# 4. Notify user directly if urgent
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "I need your help: [HUMAN] <title> — I've created a task with instructions. Check dashboard."
```

---

## When Human Completes the Task

You receive an inbox message automatically when the human task is marked complete. On receiving it:

```bash
# Unblock immediately — don't wait
cortextos bus update-task "$YOUR_TASK_ID" in_progress \
  "Human task completed — resuming"

# Resume work
```

---

## Writing Good Human Task Instructions

The instructions field should be complete enough that the human can execute without coming back to ask you questions.

**Bad:** "Set up the API key"

**Good:** "1. Go to openai.com/account/api-keys. 2. Click 'Create new secret key'. 3. Name it 'cortextos-myorg'. 4. Copy the key (starts with sk-...). 5. Open Terminal and run: echo 'OPENAI_API_KEY=<your-key>' >> ~/cortextos/orgs/myorg/.env"

---

## Consequence

Leaving work undone without creating a human task = invisible blocker. The system stalls silently. Create the human task within 1 heartbeat of discovering you're blocked by a human dependency.
