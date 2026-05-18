---
name: crm-management
description: "Maintain the structured agentic CRM: contacts, companies, interactions, follow-ups, relationship health, and search."
---

# CRM Management Skill

The local CRM is the default source of truth unless setup configures an external CRM.

## Files

| File | Purpose |
|---|---|
| `crm/contacts.json` | People and company records |
| `crm/interactions.jsonl` | Append-only interaction log |
| `crm/followups.jsonl` | Open loops and next actions |
| `crm/relationship-health.json` | Review cadence, last touch, priority, and stale flags |
| `crm/query.py` | Local CRM keyword search |
| `crm/upsert-contact.py` | Create or update contact records |
| `crm/add-interaction.py` | Append interaction records safely |
| `crm/add-followup.py` | Append follow-up records safely |

## Contact Schema

```json
{
  "id": "stable-slug",
  "type": "person|company",
  "name": "Full name or company",
  "category": "vip|family|friend|client|prospect|partner|investor|vendor|community|other",
  "priority": "critical|high|normal|low",
  "relationship_strength": 1,
  "tags": [],
  "aliases": [],
  "emails": [],
  "phones": [],
  "handles": {},
  "company": null,
  "role": null,
  "location": null,
  "context": "How the user knows them",
  "preferences": {},
  "important_dates": [],
  "last_meaningful_contact": null,
  "followup_cadence_days": null,
  "notes": "",
  "source_refs": []
}
```

## Interaction Schema

```json
{
  "ts": "ISO timestamp",
  "contact_id": "stable-slug",
  "type": "email|meeting|call|message|social|manual|task",
  "summary": "What happened",
  "sentiment": "positive|neutral|negative|unknown",
  "commitments": [],
  "followups_created": [],
  "source_ref": "file, thread, event, transcript, or manual note"
}
```

## Core Rules

- Update CRM when a meaningful relationship fact appears.
- Do not add low-signal bulk contacts unless the user configured that category.
- Never auto-delete relationship history.
- Use stable IDs and append interactions instead of overwriting history.
- If external CRM sync is configured, local files remain the audit trail unless setup says otherwise.

## Common Operations

### Search

```bash
python3 crm/query.py "<name|email|company|tag>"
```

### Add Interaction

Use:

```bash
python3 crm/add-interaction.py \
  --contact-id "<id>" \
  --type email \
  --summary "What happened" \
  --source-ref "<thread/event/file>"
```

Then update `last_meaningful_contact` if appropriate.

### Add or Update Contact

Use:

```bash
python3 crm/upsert-contact.py \
  --name "Person Name" \
  --category client \
  --priority high \
  --tag vip \
  --context "How the user knows them"
```

### Create Follow-Up

Use:

```bash
python3 crm/add-followup.py \
  --contact-id "<id>" \
  --due-date "YYYY-MM-DD" \
  --priority high \
  --reason "why this matters" \
  --suggested-action "what to do"
```

### Relationship Health

Flag as stale when:

- VIP/critical contact has no meaningful touch inside configured cadence.
- A commitment has no owner/due date.
- An important thread is waiting on the user.
- A meeting ended without follow-up.
