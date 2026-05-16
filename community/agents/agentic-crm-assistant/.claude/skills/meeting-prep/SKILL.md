---
name: meeting-prep
description: "Prepare users before meetings and process notes/transcripts afterward. Updates CRM, tasks, and follow-up drafts."
---

# Meeting Prep and Processing Skill

## Before Meeting

For each upcoming meeting:

1. Pull event details.
2. Identify attendees and organizations.
3. Query CRM for each attendee.
4. Search recent email/message/task context.
5. Search configured meeting-note tools for prior calls.
6. Write a brief:

```markdown
# Meeting Brief: <title>

## Logistics
- Time:
- Location/link:
- Attendees:

## Relationship Context
- Who they are:
- History:
- Last interaction:

## Why This Meeting Matters

## Suggested Agenda

## Open Loops

## Follow-Up Candidates
```

7. Surface the brief at the configured time.

## After Meeting

When notes/transcripts are available:

1. Extract summary, decisions, commitments, and follow-ups.
2. Append CRM interactions for attendees.
3. Create follow-up records/tasks.
4. Draft recap or next-step message if useful.
5. Save transcript/summary under `meetings/<category>/<event-id>/`.

## Meeting Note Sources

Tool-agnostic. Supported patterns:

- Notion page/transcription search
- Fathom/Zoom/Granola/Fireflies exports
- Google Drive docs
- local transcript files
- manual user notes

If no transcript exists, create a summary from available context and mark it `summary_only: true`.
