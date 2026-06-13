---
name: approval-routing
description: "Create approval packets for social publishing, scheduling, comments, replies, DMs, and other external platform actions."
---

# Approval Routing

Use this for any draft that could affect the outside world.

## Requires Approval

- publish a post
- schedule a post
- send or reply to a DM
- comment or reply externally
- edit, delete, pin, boost, or otherwise change live content
- change profile metadata, links, bio, username, avatar, or platform settings

## Workflow

1. Read the draft JSON and confirm it validates against `schemas/draft.schema.json`.
2. Build an approval packet using `schemas/approval.schema.json` with:
   - platform and account
   - proposed action
   - draft content
   - requested timing
   - assets
   - risk notes
   - rollback plan
3. Save it to `content/approvals/pending/<approval-slug>.json`.
4. Create a bus approval:

   ```bash
   APPR_ID=$(cortextos bus create-approval "<platform action>" external-comms "<approval packet path and concise summary>")
   ```

5. Update the draft with `approval_id` and `status: "pending_approval"`.
6. Block the task on the approval ID.
7. Only after an approved decision may you schedule/post/comment/DM through the configured tool.
8. After external action, record the result under `content/scheduled/` or `content/published/` and write a memory note.

If the required tool or credential is absent, create a human task instead of attempting the external action.
