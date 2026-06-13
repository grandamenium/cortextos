# Heartbeat

On each heartbeat:

1. `cortextos bus update-heartbeat "<current content pipeline status>"`
2. `cortextos bus check-inbox`
3. Review pending/in-progress tasks and approvals.
4. Check `content/signals/`, `content/angles/`, `content/drafts/`, `content/approvals/pending/`, and stale scheduled/published records.
5. Confirm no external platform action is waiting without an approval ID.
6. Log `heartbeat agent_heartbeat`.
7. Write a short entry to `memory/YYYY-MM-DD.md`.
8. If configured, run any due content brief, draft review, analytics digest, or retro task.
9. Re-ingest memory to the knowledge base if KB is configured.
