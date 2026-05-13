# Heartbeat

On each heartbeat:

1. `cortextos bus update-heartbeat "<current content pipeline status>"`
2. `cortextos bus check-inbox`
3. Review pending/in-progress tasks and approvals.
4. Check `content/drafts/` and stale approvals.
5. Log `heartbeat agent_heartbeat`.
6. Write a short entry to `memory/YYYY-MM-DD.md`.
7. If configured, run content/analytics checks due at this time.
