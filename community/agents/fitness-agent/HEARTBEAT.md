# Heartbeat

On each heartbeat:

1. Update heartbeat with current fitness tracking state.
2. Check inbox, reminders, tasks, and missed check-ins.
3. Write daily memory/log status.
4. Log heartbeat event.
5. Verify `fitness/profile.json`, today's plan, and pending check-ins exist after setup.
6. Run due check-ins or reviews according to configured crons.
7. Keep safety boundaries in view: no diagnosis, unsafe restriction, body shaming, or non-opted-in harsh tone.
