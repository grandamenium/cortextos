# Artifact-Backed Theta Wave Cron

You are running the nightly theta-wave learning loop as a daemon-spawned Codex session. This prompt replaces fragile long-running PTY injection for the `theta-wave` cron.

Hard guardrails:

- Do not deploy, merge, rotate secrets, or change provider/account settings.
- Do not mark the cycle successful unless the `theta_sessions` row is written.
- Do not hide stale/error states. If the workflow cannot complete, record a truthful error status instead of leaving the dashboard ambiguous.
- Use UTC timestamps for internal records; the schedule fires at 10:00 PM America/Los_Angeles, which is normally the next UTC date at 05:00.

Required workflow:

1. Read `.claude/skills/theta-wave/SKILL.md`.
2. Determine `SESSION_ID` as `theta-YYYY-MM-DD` for the cron fire's UTC date unless the skill explicitly specifies a different target.
3. Create or update a `theta_sessions` placeholder row before deep work begins:
   - `session_id = SESSION_ID`
   - `ran_at = current UTC timestamp`
   - `status = error`
   - `synthesis_summary` must say the artifact-backed cron started and is not yet complete.
   - This intentional placeholder uses the current `theta_sessions` contract (`complete`, `error`, or `partial`) and must be patched to `complete` after the cycle succeeds.
4. Write a markdown session artifact under `output/YYYY-MM-DD-theta-wave-session.md`.
5. Execute the theta-wave cycle from the skill, including the orchestrator challenge step.
6. Patch the same `theta_sessions` row at completion:
   - `status = complete`
   - `analyst_report`, `challenger_notes`, and `synthesis_summary` populated from the artifact
   - `proposals_count`, `consolidated_memories_count`, and `duration_seconds` set truthfully
7. If any required step fails, patch the same row to:
   - `status = error`
   - `synthesis_summary` includes the exact blocker and artifact path
   - `duration_seconds` set if known
8. Before closing, run:

   ```bash
   cd /home/cortextos/cortextos && npx tsx scripts/theta-freshness-watchdog.ts --agent analyst --cron theta-wave --grace-minutes 0 --json
   ```

   If this reports stale for the session you just ran, fix the `theta_sessions` write or report the exact blocker. Do not claim completion from cron-fire alone.

Required final response:

- `SESSION_ID`
- theta artifact path
- `theta_sessions` write result: `complete` or `error`
- watchdog result
- any owner action needed
