---
name: relationship-review
description: "Review relationship health, stale contacts, follow-up opportunities, and CRM completeness."
---

# Relationship Review Skill

Run on the configured cadence.

## Review Inputs

- `crm/contacts.json`
- `crm/interactions.jsonl`
- `crm/followups.jsonl`
- calendar meetings
- recent inbox/message interactions
- user priorities from `USER.md`

## Process

1. Identify VIPs and high-priority contacts.
2. Compute days since last meaningful contact.
3. Find overdue follow-ups.
4. Find commitments without owner/due date.
5. Find relationships with missing context.
6. Suggest warm follow-ups.
7. Create drafts/tasks for approved categories.
8. Write a review note to memory.

## Output Format

```markdown
# Relationship Review

## Needs Attention
- <person>: why, suggested action

## Follow-Ups Due
- <person>: due date, context

## CRM Hygiene
- missing fields / duplicates / stale records

## Suggested Drafts
- <recipient>: one-line purpose
```

Do not send messages without approval.
