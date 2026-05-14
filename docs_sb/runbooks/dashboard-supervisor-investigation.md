# Runbook — Dashboard supervisor investigation

**Origin:** 2026-05-14 outage post-mortem. The `cortextos-dashboard` PM2 process hit **327 restarts** without any human intervention, all caused by a persistent `EADDRINUSE :3000` against some other process on the same host. PR #43 fixed the *symptom* by adding a pre-bind port probe inside the dashboard (`src/utils/port-probe.ts`); PR #52's `max_restarts: 3` change to the generator block (`src/cli/ecosystem.ts:117`) keeps a future regeneration from re-introducing the 50-restart cap. The **root cause supervisor** still lives outside this repo and needs to be tracked down by hand.

## Symptoms

- `pm2 list` shows `cortextos-dashboard` with a restart count well into the hundreds.
- `pm2 logs cortextos-dashboard --err --lines 100` shows repeated `Error: listen EADDRINUSE :3000` (or whatever port the dashboard was configured for).
- The dashboard appears to "work" sometimes (the port-probe fallback succeeded on that boot) but is at heart unstable.

If you see this on a fresh box: the fix is to find the supervisor that has the dashboard registered and either correct its `max_restarts` cap or remove the duplicate registration entirely.

## Where to look

Three candidates, in order of likelihood on a typical macOS dev box.

### 1. PM2 startup registry (most common)

`pm2 startup` writes a launchd plist (macOS) or systemd unit (Linux) that resurrects PM2's saved dump on boot. The saved dump lives at `~/.pm2/dump.pm2`.

```bash
# Is dashboard in the saved registry?
jq '.[] | select(.name=="cortextos-dashboard") | {name, max_restarts: .pm2_env.max_restarts, exec_mode: .pm2_env.exec_mode}' ~/.pm2/dump.pm2

# If yes and max_restarts is high (>10), fix it:
pm2 delete cortextos-dashboard         # remove the rogue registration
cortextos ecosystem                    # regenerate ecosystem.config.js with max_restarts: 3
pm2 start ecosystem.config.js          # re-register from the corrected config
pm2 save                               # persist the fixed registration
```

### 2. User launchd plist (less common, but real)

Someone (you, an old install script, an LLM-generated helper) may have written a one-off plist that supervises the dashboard directly:

```bash
ls -la ~/Library/LaunchAgents/ | grep -i dashboard
ls -la ~/Library/LaunchAgents/ | grep -i cortextos

# For each suspicious plist:
launchctl list | grep -i dashboard
launchctl bootout gui/$(id -u)/<label-from-the-plist>
rm ~/Library/LaunchAgents/<filename>.plist
```

### 3. Systemd unit (Linux only)

```bash
systemctl --user list-units --type=service | grep -iE 'dashboard|cortextos'
systemctl status pm2-$USER.service     # PM2's own systemd unit, if installed
```

PM2's systemd unit is the analog of the macOS launchd registration — fix it the same way as candidate #1.

## Verifying the fix

After whichever candidate matched, confirm the new `max_restarts` is in force:

```bash
# Run the dashboard, then check the live process:
pm2 jlist | jq '.[] | select(.name=="cortextos-dashboard") | .pm2_env.max_restarts'
# Expect: 3
```

Then deliberately occupy the dashboard's port to verify the cap fires fast:

```bash
# Terminal A: occupy port 3010 (or whatever your dashboard uses)
python3 -m http.server 3010

# Terminal B: tail the dashboard
pm2 logs cortextos-dashboard --err
# After 3 restarts (~15s at default restart_delay), PM2 should mark the process
# as "errored" and stop restarting. `pm2 list` shows status "errored" + restarts=3.
```

If you see 50 or 327 restarts again, the supervisor you patched wasn't the one actually managing the dashboard. Recheck the three candidates.

## Related changes in-tree

- `src/utils/port-probe.ts` — pre-bind probe, ships in PR #43. Falls through `3010 → 3020 → 3030` so the dashboard recovers from a port collision instead of crashing.
- `src/cli/ecosystem.ts:117` — generator dashboard block now `max_restarts: 3` (PR #52). Replaces the previous `50` cap.
- `ecosystem.config.js` (root, hand-written) — defines `cortextos-daemon` only; the dashboard entry exists only in generator output.
