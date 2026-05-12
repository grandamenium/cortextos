---
name: calendar-management
description: "Tool-agnostic calendar management: schedule review, conflict detection, protected time, meeting prep chaining, and follow-up creation."
---

# Calendar Management Skill

Use the calendar provider configured in `TOOLS.md`.

## Morning Review

1. List today's events and tomorrow's early events.
2. Check protected time from `USER.md`.
3. Identify conflicts, unclear locations, missing links, or no-prep meetings.
4. Chain to `meeting-prep` for meetings in the next 24h.
5. Send a concise summary if configured.

## Evening Review

1. List tomorrow's events.
2. Prepare briefs for tomorrow's meetings.
3. Identify decisions needed from the user.
4. Create follow-up tasks for unresolved items.

## Scheduling Rules

Before creating or moving an event:

- Check protected blocks.
- Check all configured calendars.
- Apply buffer rules.
- Prefer configured meeting windows.
- If a conflict exists, propose alternatives.

Creating, moving, or deleting events requires approval unless setup says calendar writes are autonomous.

## Meeting Prep Chain

For each meeting:

- identify attendees
- query CRM
- inspect relevant emails/messages/tasks
- search meeting notes if available
- write a brief under `meetings/<category>/<event-id>/brief.md`
- create a reminder/delivery task or cron according to setup
