# Self-healing watchdog scripts

Optional, opt-in operational scripts that auto-recover a cortextOS fleet from common failure modes. **These are stop-gaps, not fixes.** They sit alongside cortextOS rather than modifying its core, and they exist because some upstream bugs are still being worked through (see [open issues](https://github.com/grandamenium/cortextos/issues)).

If you're running an unattended single-operator deployment — or just want Telegram alerts when the daemon does something concerning — these scripts add a meaningful safety net.

## What's here

| Script | Purpose | Cadence |
|---|---|---|
| `watchdog.sh` | Daemon-level. Detects accumulated Telegram poller errors in PM2's daemon error log; restarts the daemon if a threshold of errors accumulates inside a 5-min window. | every 5 min |
| `agent-recover.sh` | Per-agent. Detects agents whose process is alive but stdout has been idle ≥6 min while the daemon is still injecting messages — i.e., a hung PTY. Restarts JUST that agent (no daemon-wide restart) with a 20-min cooldown. | every 5 min |
| `usage-monitor.sh` | Cost. Calls `ccusage blocks --json`, computes USD/hr for the active 5-hour Claude Code session window, sends Telegram alerts on tier transitions (default GREEN <$15, YELLOW $15–$30, RED >$30). | every 30 min |

Each script is matched by a launchd plist template you customize once.

## Install (macOS)

Prerequisites:

- `pm2` (already required by cortextOS)
- `jq` (already required by cortextOS)
- `ccusage` for `usage-monitor.sh` only (`npm install -g ccusage`)
- A registered Telegram bot for alerts. By default the scripts auto-detect the first enabled orchestrator's bot from `~/.cortextos/<instance>/config/enabled-agents.json`. You can override with `CORTEXTOS_ALERT_BOT_ENV`.

Steps:

```bash
# 1. Copy scripts into your local cortextOS state dir (so they live with your instance, not the repo)
mkdir -p ~/.cortextos/default/scripts ~/.cortextos/default/logs
cp scripts/self-healing/{watchdog,agent-recover,usage-monitor}.sh ~/.cortextos/default/scripts/
chmod +x ~/.cortextos/default/scripts/*.sh

# 2. Render plist templates (substitute {USER}, {HOME}, {INSTANCE} for your values, then drop into ~/Library/LaunchAgents)
USER=$(whoami) HOME_DIR="$HOME" INSTANCE=default
for f in scripts/self-healing/*.plist.template; do
  out="$HOME/Library/LaunchAgents/$(basename "${f%.template}")"
  sed -e "s|{USER}|$USER|g" -e "s|{HOME}|$HOME_DIR|g" -e "s|{INSTANCE}|$INSTANCE|g" "$f" > "$out"
done

# 3. Load the launchd jobs
for f in ~/Library/LaunchAgents/com.cortextos.{watchdog,agent-recover,usage-monitor}.plist; do
  launchctl load "$f"
done

# 4. Verify
launchctl list | grep cortextos
```

Each script writes to `~/.cortextos/<instance>/logs/<scriptname>.log`. Tail those to see what they're doing.

## Uninstall

```bash
for f in ~/Library/LaunchAgents/com.cortextos.{watchdog,agent-recover,usage-monitor}.plist; do
  launchctl unload "$f"
  rm "$f"
done
```

## Tuning

All thresholds live at the top of each script as shell variables — open the script, edit, the next launchd cycle picks up the new values. No restart needed.

### `watchdog.sh`
- `THRESHOLD` (default `150`) — error count in last polling cycle that triggers a restart. Lower if false-negatives bother you, raise if false-positives are firing too often.

### `agent-recover.sh`
- `IDLE_THRESHOLD_SEC` (default `360` / 6 min) — how long stdout must be idle before considering an agent hung
- `COOLDOWN_SEC` (default `1200` / 20 min) — minimum gap between restarts of the same agent

### `usage-monitor.sh`
- `YELLOW_THRESHOLD` (default `15`) and `RED_THRESHOLD` (default `30`) — USD/hr tier boundaries

## Caveats

- Only tested on macOS (launchd). A cron-based variant for Linux is straightforward — feel free to PR.
- Scripts assume `pm2` and `jq` on `$PATH`. The plist templates set `PATH` to standard Homebrew + system locations; if your install is non-standard, edit the plists.
- `agent-recover.sh` uses `node $CTX_FRAMEWORK_ROOT/dist/cli.js` to call `cortextos status`. Set `CTX_FRAMEWORK_ROOT` if your install path differs from default.

## Related upstream issues

These scripts compensate for behavior tracked in:
- [#296 — BUG-011 pendingRestarts regression — race still firing](https://github.com/grandamenium/cortextos/issues/296)
- [#326 — Agent PTY silently hangs after Telegram photo injection](https://github.com/grandamenium/cortextos/issues/326)
- [#275 — Dispatcher state machine failure causes exponential gap degradation](https://github.com/grandamenium/cortextos/issues/275)

If those get fixed upstream, you should be able to remove these scripts without losing reliability. Until then, they're a useful safety net.
