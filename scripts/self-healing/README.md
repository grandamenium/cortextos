# Self-healing watchdog scripts

Optional, opt-in operational scripts that auto-recover a cortextOS fleet from common failure modes. **These are stop-gaps, not fixes.** They sit alongside cortextOS rather than modifying its core, and they exist because some upstream bugs are still being worked through (see [open issues](https://github.com/grandamenium/cortextos/issues)).

If you're running an unattended single-operator deployment — or just want Telegram alerts when the daemon does something concerning — these scripts add a meaningful safety net.

## What's here

| Script | Purpose | Cadence |
|---|---|---|
| `watchdog.sh` | Daemon-level. Detects accumulated Telegram poller errors in PM2's daemon error log; restarts the daemon if a threshold of errors accumulates inside a 5-min window. | every 5 min |
| `agent-recover.sh` | Per-agent. Detects agents whose process is alive but stdout has been idle ≥6 min while the daemon is still injecting messages — i.e., a hung PTY. Restarts JUST that agent (no daemon-wide restart) with a 20-min cooldown. | every 5 min |
| `usage-monitor.sh` | Cost. Calls `ccusage blocks --json`, computes USD/hr for the active 5-hour Claude Code session window, sends Telegram alerts on tier transitions (default GREEN <$15, YELLOW $15–$30, RED >$30). | every 30 min |
| `compact-boundary-watcher.sh` | Context. Scans every active Claude Code session JSONL under `~/.claude/projects/`; when a turn crosses a configured cache_read tier at a text-only or 5-min-idle boundary, sends a Telegram hint with the canned `/compact` prompt pre-quoted. Operator-typed `/compact` is the only way to keep a session below the 200K-context cliff; this surfaces the moment the agent cannot. Defaults: tiers 120K / 150K / 170K (≈ 60/75/85% of 200K). Idempotent — 1 hint per (session, tier). | every 10 min |

Each script is matched by a launchd plist template you customize once.

## Install (macOS)

**Automatic:** `cortextos install` now copies the scripts into `~/.cortextos/<instance>/scripts/`, renders the plist templates, and `launchctl bootstrap`s each into your user session — no manual sed/copy/load needed. The 2026-05-14 fleet-resilience post-mortem traced a 9-hour silent outage to this manual step being skipped. Folding the install closes that gap.

Opt-out: `cortextos install --skip-self-healing` if you'd rather wire your own supervision.

Prerequisites:

- `pm2` (already required by cortextOS)
- `jq` (already required by cortextOS)
- `ccusage` for `usage-monitor.sh` only (`npm install -g ccusage`)
- A registered Telegram bot for alerts. By default the scripts auto-detect the first enabled orchestrator's bot from `~/.cortextos/<instance>/config/enabled-agents.json`. You can override with `CORTEXTOS_ALERT_BOT_ENV`.

Verify after install:

```bash
launchctl list | grep cortextos    # expect 4 lines (one per service)
```

### Manual install (rarely needed)

If `cortextos install` couldn't complete the launchd step for some reason (Gatekeeper, locked-down macOS, etc.), the manual version is:

```bash
# 1. Copy scripts into your local cortextOS state dir
mkdir -p ~/.cortextos/default/scripts ~/.cortextos/default/logs
cp scripts/self-healing/{watchdog,agent-recover,usage-monitor,compact-boundary-watcher}.sh ~/.cortextos/default/scripts/
chmod +x ~/.cortextos/default/scripts/*.sh

# 2. Render plist templates ({HOME}, {INSTANCE} are the only tokens used)
INSTANCE=default
for f in scripts/self-healing/*.plist.template; do
  out="$HOME/Library/LaunchAgents/$(basename "${f%.template}")"
  sed -e "s|{HOME}|$HOME|g" -e "s|{INSTANCE}|$INSTANCE|g" "$f" > "$out"
done

# 3. Bootstrap the launchd jobs (modern macOS) — falls back to `launchctl load -w` if bootstrap fails
UID_=$(id -u)
for f in ~/Library/LaunchAgents/com.cortextos.{watchdog,agent-recover,usage-monitor,compact-boundary-watcher}.plist; do
  launchctl bootstrap gui/$UID_ "$f"
done
```

Each script writes to `~/.cortextos/<instance>/logs/<scriptname>.log`. Tail those to see what they're doing.

## Uninstall

**Automatic:** `cortextos uninstall` bootouts the services and removes the plist files.

**Manual:** 

```bash
UID_=$(id -u)
for s in watchdog agent-recover usage-monitor compact-boundary-watcher; do
  launchctl bootout gui/$UID_/com.cortextos.$s
  rm "$HOME/Library/LaunchAgents/com.cortextos.$s.plist"
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

### `compact-boundary-watcher.sh`
- `COMPACT_TIERS` (default `120,150,170`) — comma-separated cache_read tier thresholds in K tokens. One Telegram hint is emitted per `(session, tier)`. For 1M-Opus deployments override to e.g. `350,500,700`.
- `COMPACT_SINCE_MINUTES` (default `5`) — only consider sessions whose JSONL has activity within this window. Tighter than the 10-min cron cadence so the hint stays "fresh."
- `COMPACT_ANALYZE_PY` — override path to `analyze.py` if `$CTX_FRAMEWORK_ROOT/scripts/session-analysis/analyze.py` doesn't resolve.
- Idempotency state: `~/.cortextos/<instance>/compact-watcher-state.tsv`. Delete to re-arm all sessions.

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
