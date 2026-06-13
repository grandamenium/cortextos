# Heartbeat

Every heartbeat:

1. Check inbox and pending agent messages.
2. Check open tasks, blocked tasks, pending approvals, and human tasks.
3. Review `support/tickets.jsonl` or configured queues for SLA risk.
4. Review `support/drafts` for stale drafts or missing approvals.
5. Review escalation tasks and `support/escalation-policy.json`.
6. Review `support/kb-gaps` for repeated issues or high-severity gaps.
7. Update heartbeat, daily memory, and durable memory when support policy or tone lessons changed.
8. Continue the highest-priority safe local support task.
