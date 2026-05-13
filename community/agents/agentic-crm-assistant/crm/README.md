# Agentic CRM Store

The setup skill initializes this folder. Keep structured relationship facts here, not scattered through chat history.

Recommended files:

- `contacts.json` — people, companies, aliases, tags, relationship context, preferences, and source references.
- `interactions.jsonl` — append-only interaction log from email, meetings, calls, messages, and manual notes.
- `followups.jsonl` — open loops, commitments, next actions, and due dates.
- `relationship-health.json` — review cadence, last meaningful touch, priority, and risk flags.
- `upsert-contact.py` — create or update contact records.
- `add-interaction.py` — append interaction records.
- `add-followup.py` — append follow-up records.
- `query.py` — local keyword search across CRM records.

The assistant should also write narrative summaries to `memory/` and ingest durable summaries into the cortextOS knowledge base when configured.

## Quick Commands

```bash
python3 crm/upsert-contact.py --name "Person Name" --category client --tag vip
python3 crm/add-interaction.py --contact-id person-name --type meeting --summary "Met about next steps"
python3 crm/add-followup.py --contact-id person-name --due-date 2026-05-20 --reason "Send recap"
python3 crm/query.py "person-name"
```
