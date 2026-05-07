# P4 Migration Runbook — Mac → Linux LinkedIn Poster

**Status**: Pre-staged. Execute after PR #61 merges to RevOps-Global-GIT/cortextos main.
**Scope**: Migrate Greg's LinkedIn poster from Mac LaunchAgent to Linux self-hosted service. Kristina + Rachit onboard fresh via P2 login CLI.

---

## 0. Critical: Stop Mac LaunchAgent First

**Do this BEFORE any cookie migration or first Linux service start.**

Running both Mac and Linux poster simultaneously against the same LinkedIn account triggers account-takeover detection (dual-client from different IPs/fingerprints). LinkedIn revokes the `li_at` cookie when it detects this. The SOCKS tunnel (`socks-mac-tunnel.service`) does NOT prevent this — it changes the outbound IP but preserves the fingerprint mismatch.

```bash
# On Greg's Mac — unload BEFORE touching Linux service
launchctl unload ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster-greg-harned.plist

# Verify stopped
launchctl list | grep linkedin   # should return nothing
```

Only proceed to Linux setup after the Mac poster is confirmed stopped.

---

## 1. Prerequisites

- PR #61 merged; deployed to `/home/cortextos/cortextos/services/linkedin-poster-selfhost/`
- Build current: `cd services/linkedin-poster-selfhost && npm install && npm run build`
- Greg's Supabase auth UUID: `5a91ad05-9628-4325-95da-65d1febcabb3` (set as `SENDER_UUID`)
- Mac LaunchAgent stopped (see §0 above)

---

## 2. Systemd Install via `deploy/install-service.sh`

```bash
cd /home/cortextos/cortextos/services/linkedin-poster-selfhost

# First-run base dir (one time only)
sudo mkdir -p /var/lib/linkedin-poster/profiles
sudo chown cortextos:cortextos /var/lib/linkedin-poster

# Install service for Greg
sudo deploy/install-service.sh \
  --user greg \
  --sender-uuid 5a91ad05-9628-4325-95da-65d1febcabb3 \
  --port 3100 \
  --sender-name "Greg Harned" \
  --sender-linkedin-id gregoryharned
```

Fill in Supabase credentials if not already set:
```bash
sudo nano /etc/linkedin-poster/shared.env
# SUPABASE_URL=https://yyizocyaehmqrottmnaz.supabase.co
# SUPABASE_KEY=<service-role-key>
```

### Install Verification Gates

| Gate | Command | Expected |
|------|---------|----------|
| Unit template present | `test -f /etc/systemd/system/linkedin-poster@.service && echo OK` | `OK` |
| Per-user env file | `sudo test -f /etc/linkedin-poster/greg.env && echo OK` | `OK` |
| SENDER_UUID set | `sudo grep -q 'SENDER_UUID=5a91ad05' /etc/linkedin-poster/greg.env && echo OK` | `OK` |
| Shared env file | `sudo test -f /etc/linkedin-poster/shared.env && echo OK` | `OK` |
| Supabase key populated | `sudo grep -q 'your-service-role-key-here' /etc/linkedin-poster/shared.env && echo MISSING \|\| echo OK` | `OK` |
| Profile dir owned | `stat -c "%U %G %a" /var/lib/linkedin-poster/profiles/greg` | `cortextos cortextos 700` |

---

## 3. LinkedIn Session — Primary Path: Fresh Login from Linux IP

**Rsync is NOT the primary path.** Testing showed that LinkedIn binds sessions to the login fingerprint (IP, browser, device). Even a successful rsync produces a cookie that LinkedIn revokes when it first sees it from a different IP. Fresh login from the Linux server's own IP creates a session natively bound to that IP and survives restarts.

### 3a. Ensure X11/VNC forwarding is available

The login requires a headed browser on the Linux server. Use X11 forwarding or a local VNC session:

```bash
# Option A: SSH with X11 forwarding (from a Mac/Linux machine with X server)
ssh -X cortextos@100.69.129.2

# Option B: Connect via VNC if the server has a desktop session
# (configure as appropriate for your setup)

# Verify DISPLAY is set
echo $DISPLAY   # should show :0 or :10.0 etc.
```

### 3b. Run login-cli from the Linux server

```bash
# On Linux server (with DISPLAY set)
cd /home/cortextos/cortextos/services/linkedin-poster-selfhost

# Install Playwright browser if not already installed
npx playwright install chromium

# Run login CLI — opens headed Chrome bound to Linux IP
DISPLAY=:0 npx tsx src/login-cli.ts \
  --user greg \
  --server localhost \
  --remote-base /var/lib/linkedin-poster/profiles
```

> The `--server localhost` flag makes the CLI rsync the profile to `/var/lib/linkedin-poster/profiles/greg/` locally (no SSH hop needed since we're on the server).

In the Chrome window: log in to LinkedIn with `gregharned@gmail.com` (NO dot — not greg.harned), complete 2FA. The CLI waits up to 5 minutes, validates on the feed, then writes the profile.

### 3c. Validate the session

```bash
# Start the service
systemctl start linkedin-poster@greg

# Check /health
curl -s http://127.0.0.1:3100/health
# Expected: {"ok":true,"userId":"greg"}
```

---

## 4. Profile Rsync — Best-Effort Optimization Only

> **Warning**: Rsync has a high failure rate for LinkedIn sessions due to IP/fingerprint binding. Use the fresh-login path (§3) if rsync fails. Do NOT retry rsync in a loop — repeated failures from two IPs accelerate cookie revocation.

If you want to attempt rsync as a time-saver (e.g. Greg's session is healthy and you want to skip the interactive login):

```bash
# 1. Stop Mac poster FIRST (§0) and wait 60s for LinkedIn to settle
# 2. Snapshot before rsync
cp -a /var/lib/linkedin-poster/profiles/greg/ \
      /var/lib/linkedin-poster/profiles/greg-snapshot-$(date -u +%Y%m%dT%H%M%SZ)/

# 3. Rsync from Mac
rsync -av --delete \
  "greg@100.84.86.6:/Users/gregharned/Library/Application Support/ms-playwright/linkedin-greg/" \
  /var/lib/linkedin-poster/profiles/greg/

# 4. Immediately test /health
systemctl start linkedin-poster@greg
sleep 10
curl -s http://127.0.0.1:3100/health
```

If `/health` returns `{"ok":false}`, the cookie was rejected. Stop the service, restore the snapshot, and use the fresh-login path (§3):
```bash
systemctl stop linkedin-poster@greg
rm -rf /var/lib/linkedin-poster/profiles/greg/
cp -a /var/lib/linkedin-poster/profiles/greg-snapshot-<timestamp>/ \
      /var/lib/linkedin-poster/profiles/greg/
# Then follow §3
```

---

## 5. SOCKS Tunnel — Architectural Note (Does Not Solve Cookie Revocation)

`socks-mac-tunnel.service` (already installed at `/etc/systemd/system/`) establishes a persistent SOCKS5 proxy on `127.0.0.1:1080` via autossh through Greg's Mac. The poster's `browser.ts` supports `SOCKS_PROXY=socks5://127.0.0.1:1080` to route Chromium traffic through this tunnel.

**What the SOCKS tunnel provides:**
- Outbound requests appear to come from Greg's Mac IP (`100.84.86.6`) rather than the Linux server IP
- Useful if LinkedIn's regional detection blocks the Linux server's IP

**What the SOCKS tunnel does NOT provide:**
- It does NOT prevent cookie revocation from dual-client detection — LinkedIn tracks session tokens and device fingerprints separately from IP
- Enabling SOCKS while both Mac and Linux posters run simultaneously still triggers takeover detection

**When to use SOCKS:**
- If fresh Linux login fails due to geographic/IP blocking
- As a last resort — enable only after Mac LaunchAgent is stopped and profile is confirmed empty

```bash
# Enable SOCKS routing (add to /etc/linkedin-poster/greg.env)
sudo bash -c 'echo "SOCKS_PROXY=socks5://127.0.0.1:1080" >> /etc/linkedin-poster/greg.env'
systemctl restart linkedin-poster@greg
```

---

## 6. Heartbeat Verification

After service starts, heartbeat fires within 60s. Verify in Supabase:

```sql
SELECT agent_name, browser_healthy, status, last_check_at
FROM poster_heartbeats
WHERE agent_name = 'linkedin-poster-selfhost-greg'
ORDER BY last_check_at DESC
LIMIT 1;
```

**Gate**: `browser_healthy = true` AND `last_check_at > NOW() - INTERVAL '5 minutes'`.

```bash
# Live logs
journalctl -u linkedin-poster@greg -f --no-pager
```

---

## 7. Mac-Side Teardown (after 24h stable on Linux)

Only after Linux heartbeat shows `browser_healthy = true` for a full 24-hour cycle.

```bash
# Mac — soft-remove plist (keeps for rollback)
mv ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster-greg-harned.plist \
   ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster-greg-harned.plist.disabled

# Keep Mac profile snapshot
PROFILE_PATH="$HOME/linkedin-poster-profile-mac-snapshot-$(date -u +%Y%m%dT%H%M%SZ)"
# Copy from wherever the LaunchAgent profile dir was:
# (check old plist for CHROME_PROFILE or PLAYWRIGHT_PROFILE path)
```

---

## 8. Rollback Procedure

If Linux service is not stable within 24h:

```bash
# 1. Stop Linux service
sudo systemctl stop linkedin-poster@greg
sudo systemctl disable linkedin-poster@greg

# 2. Re-enable Mac LaunchAgent
# On Greg's Mac:
mv ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster-greg-harned.plist.disabled \
   ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster-greg-harned.plist
launchctl load ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster-greg-harned.plist
launchctl list | grep linkedin  # confirm running

# 3. Confirm Mac heartbeat in poster_heartbeats (Mac uses different agent_name without 'selfhost')
```

**Never run both simultaneously** — dual-client from two IPs is the primary cause of cookie revocation.

---

## 9. Per-User Playbook — Kristina + Rachit

Kristina and Rachit authenticate fresh via login-cli — no profile rsync. Each gets their own SENDER_UUID from `auth.users`.

### 9a. Get Supabase UUIDs

```sql
SELECT email, id FROM auth.users
WHERE email IN ('kristina@revopsglobal.com', 'rachit@revopsglobal.com');
```

### 9b. Install service instances

```bash
sudo deploy/install-service.sh \
  --user kristina \
  --sender-uuid <kristina-uuid-here> \
  --port 3101 \
  --sender-name "Kristina [Last]"

sudo deploy/install-service.sh \
  --user rachit \
  --sender-uuid <rachit-uuid-here> \
  --port 3102 \
  --sender-name "Rachit [Last]"
```

### 9c. Fresh login for each user (sequential, not parallel)

Run on the Linux server with DISPLAY set. Each user logs in to their own LinkedIn account in the Chrome window that opens.

```bash
# Kristina
DISPLAY=:0 npx tsx src/login-cli.ts --user kristina --server localhost --remote-base /var/lib/linkedin-poster/profiles
systemctl start linkedin-poster@kristina
curl -s http://127.0.0.1:3101/health   # expect ok:true

# Wait for Kristina to confirm, then Rachit
DISPLAY=:0 npx tsx src/login-cli.ts --user rachit --server localhost --remote-base /var/lib/linkedin-poster/profiles
systemctl start linkedin-poster@rachit
curl -s http://127.0.0.1:3102/health   # expect ok:true
```

**Run sequentially** — parallel headed sessions from the same display can share keyboard focus and produce duplicate input.

### 9d. Queue consumer scoping

`linkedin_engagement_queue.sender_id` and `linkedin_poster_jobs.requested_by` are UUID columns. Ensure RGOS engagement queue rows use the correct `SENDER_UUID` values (not string handles). The install-service.sh writes `SENDER_UUID` to the per-user env file.

---

## 10. Post-Migration Checklist

- [ ] Mac LaunchAgent stopped **before** any Linux session attempt
- [ ] Greg: fresh Linux login via login-cli, `/health` returns `ok:true`
- [ ] Greg: `browser_healthy=true` in `poster_heartbeats`, stable 24h
- [ ] Greg: Mac plist `.disabled` soft-removed
- [ ] Kristina: fresh login, `/health` ok, heartbeat confirmed
- [ ] Rachit: fresh login, `/health` ok, heartbeat confirmed
- [ ] No dual-client: `launchctl list | grep linkedin` on Mac returns nothing
- [ ] Queue processing: insert test engagement row per user, confirm `status=posted`
- [ ] Notify orchestrator: P4 complete, ready for production engagement traffic
