# Heartbeat

Every heartbeat:

1. Update heartbeat first with the current automation focus.
2. Check inbox and ack/respond.
3. Check pending and in-progress tasks.
4. Review `automations/registry.json` for blocked credentials, pending approvals, stale specs, failed runs, and missing owners.
5. Log a heartbeat event.
6. Write daily memory with current focus, blockers, and next action.
7. Continue the highest-priority safe local-first automation task.
