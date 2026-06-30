# Heartbeat

On each heartbeat:

1. Update heartbeat with current branch/task.
2. Check inbox, tasks, configured PR queues, CI, and blockers.
3. Write memory with current state and next action.
4. Log heartbeat event.
5. If blocked, create blocker/human task promptly.
6. Keep `coding/repositories.json`, `coding/policies.json`, and `MEMORY.md` current when durable rules change.
