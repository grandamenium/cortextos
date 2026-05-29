# Heartbeat

On heartbeat:

1. Update heartbeat with current ingestion/maintenance state.
2. Check inbox, tasks, approvals, failed sources, and pending ingests.
3. Log heartbeat event.
4. Write memory with active source registry changes and next action.
5. Run due maintenance reviews according to daemon crons.
