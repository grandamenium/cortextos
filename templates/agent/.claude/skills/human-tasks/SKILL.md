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

## Title Format — Plain-English Next-Action (REQUIRED)

Greg's directive 2026-05-19: titles must be plain-English actions he can execute immediately, not agent-jargon.

**Rules:**
- Start with an action verb: "Go to", "Open", "Click", "Log in to", "Cancel", "Approve", "Paste"
- Name the specific URL, app, or account — never "the system" or "the platform"
- No jargon: no "control path", "restore", "gate", "CU", "VM", "orch", "STACK-N", "blocklist"
- Max ~12 words

| Bad (jargon) | Good (plain-English) |
|---|---|
| Restore control path for support@ Claude Max cancellation | Go to claude.ai and cancel the Claude Max plan for support@revopsglobal.ai |
| Clear Claude.ai Cloudflare gate on Greg Mac | Open claude.ai on your Mac and complete the Cloudflare security check |
| Hub-QA Chrome: re-login to hub.revopsglobal.com | Log back in to hub.revopsglobal.com in the Hub-QA browser |
| Codex-CU Chrome: re-login Google Workspace | Log in to Google Workspace at accounts.google.com in the Codex browser |

**Auto-rewrite (LLM):** Run before creating the task — translates jargon to plain-English automatically:
```bash
PLAIN_TITLE=$(node /home/cortextos/cortextos/scripts/rewrite-human-task.js \
  "<your jargon title>" "<optional description context>")
# Falls back to original title if LLM unavailable — always safe to run
```

---

## Creating a Human Task

Three signals tell the dashboard to route this to "Your Tasks" — all three are required:
1. Title must start with `[HUMAN]`
2. `--assignee human`
3. `--project human-tasks`

```bash
# 0. Rewrite title to plain-English (always run this first)
PLAIN_TITLE=$(node /home/cortextos/cortextos/scripts/rewrite-human-task.js \
  "<what needs to be done>" "<description context>")

# 1. Create the human task with clear step-by-step instructions
HUMAN_TASK_ID=$(cortextos bus create-task \
  "[HUMAN] ${PLAIN_TITLE}" \
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
  "Human task created: [HUMAN] ${PLAIN_TITLE} — needed before I can proceed with <your task title>"

# 4. Notify user directly if urgent
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "I need your help: [HUMAN] ${PLAIN_TITLE} — I've created a task with instructions. Check dashboard."
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

---

## Worked Example: When to create vs when to solve yourself

**Correct -- create a human task (genuine capability boundary):**
```bash
cortextos bus create-task "Raise Gemini API spending cap" \
  --desc "KB queries returning 429 RESOURCE_EXHAUSTED. Greg needs to visit ai.studio/spend and raise the monthly cap. Agents cannot do this -- requires Google account access." \
  --assignee human \
  --priority high
```

**Incorrect -- do NOT create a human task (solve it yourself):**
- "Need to install a Python package" -- run pip install
- "Need to create a directory" -- run mkdir
- "Need to read a config file" -- use Read tool
- "Need to restart an agent" -- use cortextos bus self-restart
- "Need to check git status" -- run git status

Per feedback memory: be self-sufficient. Only escalate genuine capability boundaries.


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
