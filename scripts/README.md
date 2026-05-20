# cortextos/scripts

OS-level integrations and operational scripts for the SEB_company fleet. These files are version-controlled (live with the repo) and survive machine migration via `git clone` + manual re-registration.

## surface-poll.sh — dumb-poll surface-watcher

**Purpose:** Replaces the cortextos `*/5min` LLM-based surface-watcher with a pure-bash poller. Zero LLM tokens on clear pass.

**Schedule:** Windows Task Scheduler, every 5min, runs whether user is logged in or not. Wakes computer if sleeping.

**Logic:**
1. Call `cortextos bus check-inbox` + `cortextos bus read-all-heartbeats`
2. Hash combined state, compare to `.surface-poll-state.json`
3. If unchanged → exit silent (write timestamp to `.surface-poll.log` only)
4. If changed → grep heartbeats for MAJOR patterns: phase ship / NO-GO / crashed / context-capped / decision-needed / urgent inbox
5. If MAJOR detected → idempotency check (1hr cooldown on same event key), then `cortextos bus send-message seb_boss high "[surface-poll ...] MAJOR detected: ..."` (THIS spawns LLM session, only when needed)
6. Otherwise → silent state-change log

**State / log files (gitignored):**
- `.surface-poll-state.json` — last-state hash
- `.surface-poll-relayed.jsonl` — relayed event history (used for dedup)
- `.surface-poll.log` — append-only run log (~50ms entry per fire)

**Cost:** ~$0/day clear (no LLM). Spawns 1 seb_boss session per MAJOR event detection (rare).

## Audit

**Windows Task Scheduler GUI:** Task Scheduler → Task Scheduler Library → cortextos-surface-poll → last-run / next-run / history

**CLI (PowerShell):**
```powershell
Get-ScheduledTask -TaskName "cortextos-surface-poll" | Get-ScheduledTaskInfo
```

**CLI (cmd):**
```cmd
schtasks /query /tn cortextos-surface-poll /v /fo LIST
```

**Log file:** `tail -20 C:/Users/Sebas/cortextos/scripts/.surface-poll.log`

**Health-check:** seb_boss hourly-pulse cron checks mtime of `.surface-poll.log`. If last entry >15min old → bundles "surface-poll STALE" alert into pulse Telegram.

## Migration to new machine

1. `git clone <repo>` to `C:/Users/Sebas/cortextos/` (or update paths in scripts + XML if different)
2. Re-register Windows Task Scheduler from XML:
   ```cmd
   schtasks /create /xml "C:/Users/Sebas/cortextos/scripts/surface-poll.task.xml" /tn cortextos-surface-poll /f
   ```
3. Verify first fire:
   ```powershell
   Start-ScheduledTask -TaskName "cortextos-surface-poll"
   Get-ScheduledTask -TaskName "cortextos-surface-poll" | Get-ScheduledTaskInfo
   ```
4. Check log appears: `cat scripts/.surface-poll.log`

Documented in:
- `cortextos/orgs/SEB_company/agents/seb_boss/MEMORY.md` — fleet operational state
- Vault `Knowledge/seb-boss-distilled-context.md` — durable cross-bootstrap reference
- Vault `Knowledge/machine-migration-checklist.md` — full OS-level dep list

## Other scripts

- `install-whisper-model.sh` — whisper model download (legacy)
- `install-windows-pm2-startup.ps1` — PM2 service registration for cortextos daemon
- `migrate-runtime-field.ts` — agent config migration tool
- `self-healing/` — agent crash recovery scripts
- `setup-hooks.sh` — git hooks setup

## Pre-existing patterns to know about

- `cortextos bus send-message <agent> <priority> "<text>"` — bus dispatch
- `cortextos bus update-heartbeat "<status>"` — agent heartbeat refresh
- `cortextos bus check-inbox` — read assigned bus messages
- `cortextos bus read-all-heartbeats` — fleet liveness snapshot

All scripts use these stable APIs. CortextOS daemon must be running for any of this to work.
