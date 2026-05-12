# Heartbeat Checklist

Execute every step.

## 1. Update Heartbeat

```bash
cortextos bus update-heartbeat "<current CRM assistant status>"
```

## 2. Sweep Inbox

```bash
cortextos bus check-inbox
```

Reply or ACK every message.

## 3. Check Tasks and CRM Loops

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

Also check:

- `crm/followups.jsonl` for due or overdue follow-ups.
- `drafts/` for drafts awaiting approval.
- `meetings/` for unprocessed meeting notes.

## 4. Log Heartbeat Event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## 5. Write Daily Memory

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory
cat >> "memory/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M UTC)
- WORKING ON: <task_id or none>
- CRM status: <contacts/followups/drafts/meetings>
- Inbox: <clear / pending / blocked>
- Next action: <what happens next>
MEMORY
```

## 6. Resume Highest Priority Work

Priority order:

1. Urgent user request.
2. Pending approval/draft with time sensitivity.
3. Upcoming meeting prep.
4. Due follow-up.
5. Inbox/calendar triage.
6. Relationship review.
