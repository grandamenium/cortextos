---
name: cron-management
description: "Manage persistent recurring scheduled tasks via the cortextos bus. Crons are stored in crons.json, loaded and dispatched by the daemon, and survive agent restarts. Use this skill for all cron CRUD: create, update, remove, list, test-fire, and inspect execution history. Never use CronCreate or /loop for persistent recurring work — those are session-only and die on restart."
triggers: ["remind me", "every day", "every hour", "every week", "schedule", "recurring", "daily", "weekly", "cron", "loop", "check regularly", "monitor", "keep an eye on", "set up a reminder", "repeat every", "run every", "automate", "schedule task", "list crons", "show crons", "fire cron now", "test cron", "cron log", "cron history", "scheduled task", "cron not firing", "persist cron"]
external_calls: []
description: "The user wants something to happen on a recurring schedule, or you just restarted and need to verify your crons are still running. You need to create a new scheduled task, restore crons that were lost on restart, add or remove a cron from config.json so it persists across sessions, or troubleshoot why a scheduled workflow stopped firing. Crons die on restart — this skill is how you ensure scheduled work survives."
triggers: ["remind me", "every day", "every hour", "every week", "schedule", "recurring", "daily", "weekly", "cron", "loop", "check regularly", "monitor", "keep an eye on", "set up a reminder", "repeat every", "run every", "automate", "schedule task", "restore crons", "crons missing", "cron not firing", "session start crons", "recreate crons", "persist cron", "add to config.json"]
---

# Cron Management

Crons are stored in `crons.json` (per-agent) and dispatched by the cortextOS daemon. They survive agent restarts and session boundaries. `crons.json` is the source of truth — use these bus commands for all CRUD operations. Never write to `crons.json` directly; never use CronCreate or `/loop` for persistent recurring work.

---

## Listing your crons

```bash
cortextos bus list-crons $CTX_AGENT_NAME
```

Sample output:
```
NAME          SCHEDULE   LAST_FIRE             NEXT_FIRE             PROMPT
heartbeat     6h         2026-04-30T12:00:00Z  2026-04-30T18:00:00Z  Read HEARTBEAT.md and follow its instru...
daily-report  0 9 * * *  2026-04-30T09:00:00Z  2026-05-01T09:00:00Z  Generate and send daily analytics repor...
```

For machine-readable output:
```bash
cortextos bus list-crons $CTX_AGENT_NAME --json
```

---

## Adding a recurring cron

```bash
cortextos bus add-cron <agent> <name> <interval> <prompt...>
```

**Interval form** — use for simple repeated intervals:
```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 6h Read HEARTBEAT.md and follow its instructions.
cortextos bus add-cron $CTX_AGENT_NAME health-check 30m Check system health and report anomalies.
cortextos bus add-cron $CTX_AGENT_NAME daily-sweep 1d Run the full daily workflow.
```

**Cron expression form** — use for calendar-anchored schedules (specific time of day, weekdays only, etc.):
```bash
cortextos bus add-cron $CTX_AGENT_NAME morning-report "0 9 * * 1-5" Generate and send the daily analytics report.
cortextos bus add-cron $CTX_AGENT_NAME weekly-summary "0 17 * * 5" Compile and deliver the weekly summary.
```

The prompt argument is variadic — all remaining words are joined. Quoting is optional but recommended for clarity. Optionally add a human-readable description:
```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 6h --desc "Agent liveness heartbeat" Read HEARTBEAT.md and follow its instructions.
```

The daemon scheduler reloads automatically after `add-cron` — no agent restart needed. Confirm with `list-crons`.

---

## Updating a cron

At least one option is required. All options may be combined.

```bash
# Change the interval
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --interval 4h

# Switch to a cron expression
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --cron-expr "0 */4 * * *"

# --cron-expr is an alias for --interval; both accept interval strings or 5-field expressions
cortextos bus update-cron $CTX_AGENT_NAME morning-report --interval "0 8 * * 1-5"

# Update the prompt
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --prompt "Read HEARTBEAT.md, follow instructions, then log state."

# Disable a cron (stops firing without removing it)
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --enabled false

# Re-enable
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --enabled true

# Update multiple fields at once
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --interval 8h --prompt "Read HEARTBEAT.md and follow its instructions."
```

---

## Removing a cron

```bash
cortextos bus remove-cron $CTX_AGENT_NAME <name>
```

Example:
```bash
cortextos bus remove-cron $CTX_AGENT_NAME heartbeat
```

Confirm the cron is gone:
```bash
cortextos bus list-crons $CTX_AGENT_NAME
```

---

## Testing a cron immediately

```bash
cortextos bus test-cron-fire $CTX_AGENT_NAME <name>
```

Fires the cron's prompt into the agent's PTY right now via daemon IPC, without waiting for the next scheduled time. Use this to verify the prompt works correctly before relying on the schedule.

```bash
cortextos bus test-cron-fire $CTX_AGENT_NAME heartbeat
```

---

## Inspecting execution history

**All crons for this agent:**
```bash
cortextos bus get-cron-log $CTX_AGENT_NAME
```

**Filter by cron name:**
```bash
cortextos bus get-cron-log $CTX_AGENT_NAME heartbeat
```

**Limit entries (default 50):**
```bash
cortextos bus get-cron-log $CTX_AGENT_NAME heartbeat --limit 20
```

**Machine-readable JSON:**
```bash
cortextos bus get-cron-log $CTX_AGENT_NAME heartbeat --json
```

Each log entry contains:
- `ts` — ISO timestamp of the execution attempt
- `cron` — cron name
- `status` — `fired` | `retried` | `failed`
- `attempt` — attempt number (1 = first try)
- `duration_ms` — execution duration in milliseconds
- `error` — error message if status is `failed`

---

## One-shot reminders (gap — not yet supported)

The persistent cron system does not currently support one-shot (fire-once) entries. `CronDefinition` has no `fire_at` field.

For one-time reminders, fall back to the Claude Code built-in CronCreate with `recurring: false`:
```
CronCreate — name: "remind-user-3pm", prompt: "Remind the user about the 3pm call.", schedule: "0 15 * * *", recurring: false
```

**Important**: this cron is session-only. It will NOT survive an agent restart. Until persistent one-shot support is added to `crons.json`, one-shot reminders must be recreated manually if the agent restarts before they fire.
`config.json` under the `crons` array is the single source of truth for ALL scheduled tasks — recurring AND one-shot reminders. Every cron you create must be written to config.json first so it survives restarts.
## Two cron types
**Recurring** — fires on a repeating interval forever.
```json
{ "name": "heartbeat", "type": "recurring", "interval": "4h", "prompt": "Read HEARTBEAT.md and follow its instructions." }
**Once** — fires at a specific datetime, then is deleted.
```json
{ "name": "remind-user-3pm", "type": "once", "fire_at": "2026-04-02T15:00:00Z", "prompt": "Remind the user about the 3pm call." }
`type` defaults to `"recurring"` if omitted (backward compatible with existing config.json files).
## On Session Start
Restore all crons from config.json:
1. Run CronList — note which crons are already active (avoid duplicates)
2. For each entry in `config.json` crons:
   - **type: recurring** (or no type): call `/loop {interval} {prompt}` if not already active
   - **type: once**: check if `fire_at` is in the future
     - Yes: recreate with CronCreate (set `recurring: false`, compute cron expression from fire_at)
     - No (already past): delete this entry from config.json — it expired while you were offline
## Creating a Recurring Cron
1. Write to `config.json` first:
   ```json
   { "name": "descriptive-name", "type": "recurring", "interval": "1h", "prompt": "What to do each cycle" }
   ```
2. Create the live cron: `/loop 1h What to do each cycle`
3. Confirm to the user that the cron is active and persisted
## Creating a One-Shot Reminder
When a user asks for a one-time reminder (e.g. "remind me at 3pm"):
1. Write to `config.json` first:
   ```json
   { "name": "remind-user-3pm", "type": "once", "fire_at": "2026-04-02T15:00:00Z", "prompt": "Remind the user about the 3pm call." }
   ```
2. Create the live cron via CronCreate with `recurring: false` and the cron expression for that time
3. After the reminder fires, delete the entry from config.json
## Removing a Cron
1. Cancel the active cron via CronDelete
2. Remove the entry from `config.json`
## Cron Expiry
Built-in crons expire after 7 days. Since your session restarts via the daemon, this is not an issue — crons are recreated from config.json on each fresh start. The 7-day window covers any normal restart cycle.

---

## Troubleshooting

**Cron not firing on schedule**
1. Check `list-crons` — confirm `next_fire_at` is in the future and the cron is not disabled.
2. Check `get-cron-log` for recent entries — `status: failed` entries show the error field.
3. If `next_fire_at` is stale, the daemon may not have reloaded. Restart the agent or run `cortextos bus migrate-crons $CTX_AGENT_NAME --force`.

**Cron failing repeatedly**
- `get-cron-log $CTX_AGENT_NAME <name>` — look for `status: failed` and read the `error` field.
- Common causes: prompt syntax error, permission issue, or dependency unavailable.

**Just-added cron not registered**
- The daemon reloads automatically after `add-cron`. If the cron still does not appear in `list-crons`, force a reload:
  ```bash
  cortextos bus migrate-crons $CTX_AGENT_NAME --force
  ```

**Disabling without deleting**
- Use `update-cron --enabled false` to pause a cron. It remains in `crons.json` and can be re-enabled later with `--enabled true`.

**`crons.json` corrupted or emptied**
- Every `writeCrons` call preserves the previous file as `crons.json.bak`. If the primary file is unreadable, `readCrons` automatically falls back to `.bak` — no operator intervention needed for a single corruption event.
- If both files are bad, restore via `add-cron` or re-migrate: `cortextos bus migrate-crons $CTX_AGENT_NAME --force`.

**Scheduler retained stale schedule after reload (lastGoodSchedule)**
- If a reload produces an empty schedule (transient corruption), the daemon keeps the last-good schedule in memory and logs `WARNING: reload produced empty schedule`. Crons keep firing. Repair `crons.json` and the scheduler recovers automatically on the next reload.

**Preventing dashboard test-fires**
- Set `manualFireDisabled: true` on a cron definition to block test-fire requests from the dashboard (HTTP 403). Use for crons that must only fire on schedule.

---

## Examples

### Add a heartbeat cron every 6 hours

```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 6h Read HEARTBEAT.md and follow its instructions.
cortextos bus list-crons $CTX_AGENT_NAME
```

### Schedule a weekday 9am report

```bash
cortextos bus add-cron $CTX_AGENT_NAME morning-report "0 9 * * 1-5" Generate and send the daily analytics report.
cortextos bus list-crons $CTX_AGENT_NAME
```

### Test that a cron fires correctly

```bash
cortextos bus test-cron-fire $CTX_AGENT_NAME morning-report
# Watch agent PTY — the prompt should inject immediately
cortextos bus get-cron-log $CTX_AGENT_NAME morning-report --limit 1
```

### Debug why a cron is not firing on schedule

```bash
# Step 1: confirm the cron exists and is enabled
cortextos bus list-crons $CTX_AGENT_NAME

# Step 2: check execution history for errors
cortextos bus get-cron-log $CTX_AGENT_NAME morning-report --limit 10

# Step 3: if no log entries and cron looks correct, force daemon reload
cortextos bus migrate-crons $CTX_AGENT_NAME --force

# Step 4: test-fire to verify prompt works
cortextos bus test-cron-fire $CTX_AGENT_NAME morning-report
```
- Cron not firing after restart: check config.json — the entry may be missing or have an expired fire_at
- Duplicate crons: always run CronList before recreating; if a cron is already active, skip it
- One-shot that already fired: if fire_at is in the past and the entry is still in config.json, the reminder was likely missed during a restart — delete the entry, notify the user
