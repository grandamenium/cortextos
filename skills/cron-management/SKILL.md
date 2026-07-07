---
name: cron-management
description: "Manage scheduled tasks (crons). Use when: setting up crons on session start, creating new recurring tasks, or troubleshooting scheduled tasks."
---

# Cron Management

Your scheduled tasks are **daemon-managed external crons**. They are stored in
`${CTX_ROOT}/state/{agent}/crons.json` and scheduled by the cortextOS daemon.
Crons survive agent restarts, context compactions, and daemon restarts automatically —
you do NOT need to recreate them on session start.

---

## On Session Start

Check that your crons are registered. You do not need to recreate them.

```bash
# List all crons with next_fire_at
cortextos bus list-crons $CTX_AGENT_NAME
```

If a cron is missing (not in the list), add it:

```bash
cortextos bus add-cron $CTX_AGENT_NAME <name> <interval|cron-expr> "<prompt>"
# Examples:
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 4h "Run heartbeat protocol"
cortextos bus add-cron $CTX_AGENT_NAME morning-briefing "0 9 * * *" "Send morning briefing"
```

---

## Adding a New Cron

```bash
# Interval shorthand (s/m/h/d/w)
cortextos bus add-cron $CTX_AGENT_NAME <name> <interval> "<prompt>"

# 5-field cron expression (minute hour dom month dow)
cortextos bus add-cron $CTX_AGENT_NAME <name> "<cron-expr>" "<prompt>"
```

**⚠️ Cron-expression hour/day/month fields are evaluated in the daemon
server's LOCAL timezone, not UTC** (confirmed 2026-07-06: the scheduler uses
`Date.getHours()`/`getDate()`/`getMonth()`, which read local time; the
daemon has no `TZ` override, so it inherits the host's system timezone).
If you write `"0 22 6 7 *"` intending "22:00 UTC," it actually fires at
22:00 in the server's local zone — a consistent, silent offset (7h for
Pacific in summer) that produces a cron which still "works" but at the
wrong real-world time, and looks like a missed/broken fire if you're
watching for the UTC-equivalent moment. Author hour/day/month fields in
the server's local time (check `date` on the host, or `$CTX_TIMEZONE`),
not UTC — this matters most for one-off, date-specific crons (a fixed
day+month+hour target), less for recurring daily/interval crons where the
offset is consistent and usually harmless.

The cron is written to `crons.json` atomically and the scheduler is reloaded.
No `/loop` call needed — the daemon fires crons directly into your PTY.

**`manualFireDisabled`:** If you want a cron to only fire on schedule (not manually
test-fired from the dashboard), set `manualFireDisabled: true` in the definition.
Contact the operator or use the dashboard edit form to set this flag.

---

## Removing a Cron

```bash
cortextos bus remove-cron $CTX_AGENT_NAME <name>
```

---

## Updating a Cron

Use the dashboard (`/workflows/[agent]/[name]`) or the bus command (if available):

```bash
cortextos bus update-cron $CTX_AGENT_NAME <name> --schedule <new-schedule>
cortextos bus update-cron $CTX_AGENT_NAME <name> --prompt "<new-prompt>"
cortextos bus update-cron $CTX_AGENT_NAME <name> --enabled false
```

---

## Checking Execution History

```bash
# Recent execution log (fired / retried / failed entries)
cortextos bus get-cron-log $CTX_AGENT_NAME

# Filtered to a specific cron
cortextos bus get-cron-log $CTX_AGENT_NAME --cron <name>
```

---

## Cron Expiry

External crons **do not expire**. They fire on schedule until disabled or removed.
The old 3-day `/loop` expiry no longer applies.

---

## Troubleshooting

**Cron not firing:**
1. `cortextos bus list-crons $CTX_AGENT_NAME` — confirm it is registered and has a `next_fire_at`
2. `cortextos bus get-cron-log $CTX_AGENT_NAME` — check for `status: retried` or `status: failed` entries
3. If PTY injection is failing, check the daemon log: `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/`

**Cron fires but agent does not react:**
- The daemon injects `[CRON: <name>] <prompt>` into your PTY. If you see this in your conversation history but did not act, it was an older session.
- Check daemon log; PTY injection retries 3 times (1s/4s/16s backoff).

**`crons.json` corrupted:**
- `readCrons` automatically falls back to `crons.json.bak` on parse failure.
- If both files are bad, add crons back via `cortextos bus add-cron`.
- See `CRONS_MIGRATION_GUIDE.md` for full recovery procedures.

**Crons disappeared after daemon reload (reload-to-empty):**
- The daemon's `lastGoodSchedule` protection keeps crons firing in memory during transient corruption.
- Check stderr logs for `WARNING: reload produced empty schedule` to confirm this triggered.
- Repair `crons.json` and the scheduler will pick up the fix on the next reload.

---

## Migration from config.json (legacy)

If your agent was set up before the external-crons migration, your crons lived in
`config.json`. The daemon auto-migrates them to `crons.json` on first boot.
A `.crons-migrated` marker file prevents re-runs. See `CRONS_MIGRATION_GUIDE.md`
for details and manual migration instructions.
