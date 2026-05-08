---
name: cron-management
description: "Manage scheduled tasks (crons). Crons are daemon-managed and stored in crons.json — they survive restarts automatically. Use when: verifying crons on session start, creating new recurring tasks, updating or removing crons, troubleshooting scheduled tasks, or using the dashboard test-fire button."
---

# Cron Management

Crons are **daemon-managed**. They are stored in `${CTX_ROOT}/state/$CTX_AGENT_NAME/crons.json`
and dispatched by the cortextOS daemon. Crons survive agent restarts, context compactions,
and daemon restarts automatically. You do NOT need to recreate them on session start.

**Daemon crons are the only persistent scheduling path on this runtime.** Session-local
schedulers — anything that lives only inside the agent's process — die on restart and
silently drop their work. Always register recurring or future-dated jobs via the bus
commands below so the daemon owns dispatch.

Editing `config.json.crons[]` while the agent is running does NOT hot-reload — the daemon
only re-reads `config.json` on agent boot. Mid-session changes go through `bus add-cron` /
`bus update-cron` / `bus remove-cron`, which trigger an automatic scheduler reload.

---

## Handling a Cron Fire

When a registered cron fires, the daemon injects a message into your session in this exact
shape:

```
[CRON FIRED <iso-timestamp>] <cron-name>: <prompt>
```

Treat the inject as if the user just sent you `<prompt>`. Run it to completion. Then —
**mandatory** — close the loop with `update-cron-fire` so the daemon's gap-detection knows
you actually handled it (not just that the prompt was injected):

```bash
cortextos bus update-cron-fire <cron-name> --interval <interval>
```

`<interval>` matches the cron's schedule shorthand (`6h`, `30m`, `1d`) or the expected gap
between fires for a 5-field expression. If you skip this step the daemon will eventually
nudge you with a "cron seems stuck" reminder even though you handled it. The audit trail
lives in `state/<agent>/cron-state.json` — the daemon trusts that file, so write to it on
every fire.

**One-shot crons** (cron-expression form, see below) are the only exception: a one-shot
removes itself at the end of its handler, so its `last_fire` never matters again.

---

## On Session Start

Check that your crons are registered. Do not recreate them unless they are missing.

```bash
cortextos bus list-crons $CTX_AGENT_NAME
```

If a cron is missing from the list, add it:

```bash
cortextos bus add-cron $CTX_AGENT_NAME <name> <interval|cron-expr> "<prompt>"
```

---

## Adding a Recurring Cron

**Interval shorthand** (s/m/h/d/w):
```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 6h "Read HEARTBEAT.md and follow its instructions."
cortextos bus add-cron $CTX_AGENT_NAME health-check 30m "Check system health and report anomalies."
```

**5-field cron expression** (minute hour dom month dow):
```bash
cortextos bus add-cron $CTX_AGENT_NAME morning-report "0 9 * * 1-5" "Generate and send the daily analytics report."
cortextos bus add-cron $CTX_AGENT_NAME weekly-summary "0 17 * * 5" "Compile and deliver the weekly summary."
```

The daemon reloads automatically after `add-cron`. Confirm with `list-crons`.

---

## Updating a Cron

```bash
# Change the schedule
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --interval 4h

# Update the prompt
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --prompt "New prompt text."

# Disable (stops firing without removing it)
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --enabled false

# Re-enable
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --enabled true
```

---

## Removing a Cron

```bash
cortextos bus remove-cron $CTX_AGENT_NAME <name>
```

---

## One-Shot Reminder via Cron Expression

There is no daemon-side `fire_at` (yet). The pattern for "fire once at a specific time" is
a future-dated 5-field cron expression plus a self-removing handler:

```bash
# Remind me on May 8 at 15:30 local time to send the weekly report.
# Format: minute hour day month dow
cortextos bus add-cron $CTX_AGENT_NAME may8-report "30 15 8 5 *" \
  'Send the weekly report. Then remove this cron: cortextos bus remove-cron '"$CTX_AGENT_NAME"' may8-report'
```

When the cron fires, your handler does the work AND removes the cron. If you forget the
remove step the cron will fire again next year on May 8 — same reason `update-cron-fire`
is mandatory for recurring crons: the loop only closes when you say it does.

If you need a reminder less than 24 hours out and the date math is awkward, use a short
interval shorthand that you remove on first fire instead:

```bash
cortextos bus add-cron $CTX_AGENT_NAME quick-reminder 90m \
  'Check the soak run. Then: cortextos bus remove-cron '"$CTX_AGENT_NAME"' quick-reminder'
```

---

## Testing a Cron Immediately

From the dashboard (`/workflows/$CTX_AGENT_NAME/<name>`), click **Test Fire** to inject the
cron's prompt immediately. A 30-second cooldown prevents accidental rapid-fires.

Set `manualFireDisabled: true` on a cron definition to block dashboard test-fires (e.g. for
crons that must only fire on schedule).

---

## Checking Execution History

```bash
# All crons for this agent
cortextos bus get-cron-log $CTX_AGENT_NAME

# Filter to a specific cron
cortextos bus get-cron-log $CTX_AGENT_NAME <name>
```

Each log entry: `ts`, `cron`, `status` (fired/retried/failed), `attempt`, `duration_ms`, `error`.

---

## Troubleshooting

**Cron not firing:**
1. `cortextos bus list-crons $CTX_AGENT_NAME` — confirm it is registered and not disabled.
2. `cortextos bus get-cron-log $CTX_AGENT_NAME <name>` — check for `status: failed` entries.
3. Check daemon log: `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/`

**`crons.json` corrupted:**
- `readCrons` automatically falls back to `crons.json.bak` on parse failure. Usually self-healing.
- If both files are bad, re-add crons via `add-cron` or force re-migration:
  `cortextos bus migrate-crons $CTX_AGENT_NAME --force`

**Scheduler retained stale schedule after reload:**
- If a reload produces an empty schedule (transient corruption), the daemon keeps the last-good
  schedule in memory (`lastGoodSchedule`). Crons keep firing. Repair `crons.json` and the
  scheduler recovers automatically on the next reload.
