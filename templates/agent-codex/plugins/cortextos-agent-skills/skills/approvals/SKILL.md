---
name: approvals
description: "You are about to take an action that affects the outside world, cannot be undone, or involves real people — and you have not yet received explicit permission. This includes: sending any email or message to a real person, deploying code to production, posting on social media, making a purchase or financial commitment, deleting files or data, merging a PR to main, or publishing anything publicly. Stop, create an approval, block your task, and notify the user. Do not proceed until you receive the approval decision in your inbox."
---

# Approvals

Before any external, irreversible, or high-stakes action — stop and create an approval. The user decides. You execute only after they approve.

---

## When to Use

| Action type | Requires approval? |
|-------------|-------------------|
| Sending emails to real people | YES |
| Deploying code to production | YES |
| Posting on social media | YES |
| Making financial commitments | YES |
| Deleting data (files, DB rows, records) | YES |
| Merging to main branch | YES |
| Any action visible to external parties | YES |
| Internal work (writing files, creating tasks, research) | NO |

---

## Full Workflow

### 1. Create the approval

```bash
APPR_ID=$(cortextos bus create-approval \
  "<what you want to do>" \
  "<category>" \
  "<context: draft content, target, why needed>")
echo "APPR_ID=$APPR_ID"
```

Categories: `external-comms` | `financial` | `deployment` | `data-deletion` | `other`

### 2. Block your task on the approval

```bash
cortextos bus update-task "$TASK_ID" blocked
cortextos bus log-event task task_blocked info --meta "{\"task_id\":\"$TASK_ID\",\"blocked_by\":\"$APPR_ID\",\"reason\":\"awaiting approval\"}"
```

### 3. Notify the user

```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "Approval needed: <title> — check dashboard or reply to approve/reject"
```

### 4. Wait for inbox notification

When the user decides, you receive an inbox message:
```
approval_id: appr_xxx
decision: approved | rejected
note: <user's note>
```

### 5. Act on the decision

**Approved:**
```bash
# Unblock task
cortextos bus update-task "$TASK_ID" in_progress "Approval received — executing"
# Execute the action
# Complete the task
cortextos bus complete-task "$TASK_ID" --result "<what was done>"
```

**Rejected:**
```bash
cortextos bus complete-task "$TASK_ID" --result "Cancelled — approval rejected: <note>"
```

---

## Re-pinging

If an approval is still pending after 4 hours during day mode, send one re-ping:

```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "Reminder: approval for '<title>' is still pending. No rush, just flagging."
```

Send only ONE re-ping. Do not spam.

---

## Listing Pending Approvals

```bash
cortextos bus list-approvals --format json
```

---

## Critical Rules

1. **Create approval BEFORE starting the action** — never take the action first and ask forgiveness
2. **Always block your task** pointing to the approval ID — so work isn't lost while waiting
3. **Never assume approval** — if you don't have an inbox confirmation, you don't have approval
4. **One re-ping max** — after 4h, ping once and wait
