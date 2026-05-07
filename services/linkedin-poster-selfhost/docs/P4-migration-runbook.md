# P4 Migration Runbook — Mac → Linux LinkedIn Poster

**Status**: Pre-staged. Execute after PR #61 merges to RevOps-Global-GIT/cortextos main.
**Scope**: Migrate Greg's LinkedIn poster from Mac LaunchAgent to Linux self-hosted service. Kristina + Rachit onboard fresh via P2 login CLI (no rsync needed).

---

## 0. Prerequisites

- PR #61 merged; branch deployed to `/home/cortextos/cortextos/services/linkedin-poster-selfhost/`
- Build is current: `cd services/linkedin-poster-selfhost && npm install && npm run build`
- Tailscale connected on both ends: gregs-mac = `100.84.86.6`, Linux server = `100.69.129.2`
- SSH access: `ssh gregs-mac` resolves via Tailscale alias

---

## 1. Profile Rsync — Greg's Mac → Linux Server

Greg's Mac Playwright/Chrome profile is at:
```
~/.config/ms-playwright/linkedin-poster/<profile>/
```
or (if the Mac poster used a custom path, check `CHROME_PROFILE` in the launchd plist):
```
launchctl print gui/$(id -u) | grep CHROME_PROFILE
```

**Rsync command template:**
```bash
# Run from Greg's Mac (or from Linux server with reverse direction)
rsync -av --delete \
  "greg@100.84.86.6:/Users/gregharned/Library/Application Support/ms-playwright/linkedin-greg/" \
  cortextos@100.69.129.2:/var/lib/linkedin-poster/profiles/greg/

# Verify byte count on both ends afterward
du -sh "/Users/gregharned/Library/Application Support/ms-playwright/linkedin-greg/"
ssh cortextos@100.69.129.2 "du -sh /var/lib/linkedin-poster/profiles/greg/"
```

> **Note**: Playwright persistent context profiles differ from Chrome user data dirs — they contain a `Default/` subfolder with `Cookies`, `Local Storage`, etc. Rsync the profile root, not a parent.

**Snapshot before rsync (rollback source):**
```bash
# On Linux server — create snapshot before first rsync
cp -a /var/lib/linkedin-poster/profiles/greg/ \
      /var/lib/linkedin-poster/profiles/greg-snapshot-$(date -u +%Y%m%dT%H%M%SZ)/
```

---

## 2. Systemd Install via `deploy/install-service.sh`

```bash
cd /home/cortextos/cortextos/services/linkedin-poster-selfhost

# First-run base dir (one time only):
sudo mkdir -p /var/lib/linkedin-poster/profiles
sudo chown cortextos:cortextos /var/lib/linkedin-poster

# Install service for Greg
sudo deploy/install-service.sh \
  --user greg \
  --port 3100 \
  --sender-name "Greg Harned" \
  --sender-linkedin-id gregoryharned
```

**Fill in Supabase credentials** (if not already present):
```bash
sudo nano /etc/linkedin-poster/shared.env
# Set: SUPABASE_KEY=<service-role-key>
```

### Verification Gates

Run each check before proceeding. All must pass.

| Gate | Command | Expected |
|------|---------|----------|
| Unit loaded | `systemctl status linkedin-poster@greg` | `active (running)` |
| Profile dir owned | `stat -c "%U %G %a" /var/lib/linkedin-poster/profiles/greg` | `cortextos cortextos 700` |
| Per-user env file | `sudo test -f /etc/linkedin-poster/greg.env && echo OK` | `OK` |
| Shared env file | `sudo test -f /etc/linkedin-poster/shared.env && echo OK` | `OK` |
| Supabase key set | `sudo grep -q "your-service-role-key-here" /etc/linkedin-poster/shared.env && echo MISSING \|\| echo OK` | `OK` |
| HTTP server alive | `curl -s http://127.0.0.1:3100/health` | `{"ok":true,"userId":"greg"}` |

---

## 3. Login Validation

### 3a. Check `li_at` cookie present in profile

```bash
# Playwright profiles store cookies in a SQLite file
COOKIE_DB="/var/lib/linkedin-poster/profiles/greg/Default/Cookies"
sudo -u cortextos sqlite3 "$COOKIE_DB" \
  "SELECT name, expires_utc FROM cookies WHERE host_key LIKE '%linkedin%' AND name='li_at';"
```

Expected: one row with a future `expires_utc`. If missing, the profile has no valid LinkedIn session — run step 1 (rsync) again or use the P2 login CLI to re-auth.

> `expires_utc` is Chrome epoch (microseconds since 1601-01-01). A value > 13,300,000,000,000,000 is safely in the future as of 2026.

### 3b. Dry-run health check before enabling queue consumer

```bash
# Hit /health — browser must load and confirm authenticated LinkedIn feed
curl -s http://127.0.0.1:3100/health | jq .
# Expected: {"ok":true,"userId":"greg"}

# If ok=false: session expired — re-run P2 login CLI on Greg's Mac, re-rsync
```

### 3c. Optional: P2 login-cli dry run (if session uncertain)

```bash
# On Greg's Mac — this seeds a fresh profile to /tmp, validates on feed,
# then rsyncs. Safe to run even if service is already running (different temp dir).
cd /Users/gregharned/work/cortextos/services/linkedin-poster-selfhost
npm run login -- --user greg --server cortextos@100.69.129.2
```

---

## 4. Heartbeat Verification

After service starts, the heartbeat loop fires within 60s and upserts to `poster_heartbeats`.

**Query via Supabase CLI or dashboard:**
```sql
SELECT agent_name, browser_healthy, status, last_check_at
FROM poster_heartbeats
WHERE agent_name = 'linkedin-poster-selfhost-greg'
ORDER BY last_check_at DESC
LIMIT 1;
```

**Gate**: `browser_healthy = true` AND `last_check_at > NOW() - INTERVAL '5 minutes'`.

If `browser_healthy = false`: check service logs and re-validate session (step 3).

```bash
# Live log tail
journalctl -u linkedin-poster@greg -f --no-pager
```

---

## 5. Mac-Side Teardown

Only execute after Linux heartbeat shows `browser_healthy = true` for at least one full cycle (5 min).

### 5a. Find and unload the Mac LaunchAgent

```bash
# On Greg's Mac — find the plist
ls ~/Library/LaunchAgents/ | grep linkedin
# Typically: com.revopsglobal.linkedin-poster.plist

# Unload (stops the job without deleting it)
launchctl unload ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster.plist
```

### 5b. Verify Mac poster is stopped

```bash
# Should return nothing
launchctl list | grep linkedin
```

### 5c. Keep profile snapshot for rollback

```bash
# On Greg's Mac — archive current profile before removing
PROFILE_PATH=$(defaults read ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster.plist \
  EnvironmentVariables | grep CHROME_PROFILE | awk -F'"' '{print $2}')

cp -a "$PROFILE_PATH" \
   ~/linkedin-poster-profile-snapshot-$(date -u +%Y%m%dT%H%M%SZ)/
echo "Snapshot saved: ~/linkedin-poster-profile-snapshot-*"
```

### 5d. Remove plist (optional — only after 48h stable on Linux)

```bash
# Soft remove (keeps backup)
mv ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster.plist \
   ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster.plist.disabled
```

---

## 6. Rollback Procedure

If the Linux service is unhealthy and cannot be recovered quickly, revert to Mac:

```bash
# Step 1: Disable Linux service
sudo systemctl stop linkedin-poster@greg
sudo systemctl disable linkedin-poster@greg

# Step 2: Re-enable Mac LaunchAgent
# On Greg's Mac:
mv ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster.plist.disabled \
   ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster.plist
launchctl load ~/Library/LaunchAgents/com.revopsglobal.linkedin-poster.plist
launchctl list | grep linkedin  # confirm running

# Step 3: Restore Mac profile from snapshot if needed
PROFILE_PATH="..."  # from plist EnvironmentVariables
cp -a ~/linkedin-poster-profile-snapshot-<timestamp>/ "$PROFILE_PATH/"

# Step 4: Confirm Mac heartbeat in poster_heartbeats table
# (Mac poster uses agent_name without 'selfhost' prefix)
```

**Decision gate**: If Linux is not stable within 24h of migration, roll back. Do not leave both Mac and Linux posters running simultaneously — they will double-claim queue items.

---

## 7. Per-User Playbook — Kristina + Rachit

Kristina and Rachit authenticate fresh via the P2 login CLI — no profile rsync needed.

### 7a. Install service instance

```bash
# On Linux server
sudo deploy/install-service.sh \
  --user kristina \
  --port 3101 \
  --sender-name "Kristina [Last]" \
  --sender-linkedin-id <kristina-linkedin-id>

sudo deploy/install-service.sh \
  --user rachit \
  --port 3102 \
  --sender-name "Rachit [Last]" \
  --sender-linkedin-id <rachit-linkedin-id>
```

> Each user gets a unique port. Add to `/etc/linkedin-poster/<user>.env` if not set by script.

### 7b. Run P2 login CLI from Greg's Mac

```bash
# Kristina
npm run login -- --user kristina --server cortextos@100.69.129.2

# Rachit
npm run login -- --user rachit --server cortextos@100.69.129.2
```

This opens a headed Chrome window. Each user logs in to their own LinkedIn account (including 2FA). The CLI validates the session on the feed, then rsyncs the profile to the Linux server.

**Run sequentially** — two concurrent headed sessions on the same Mac can trigger expired OTP on the second login.

### 7c. Verify each user

```bash
# Kristina
curl -s http://127.0.0.1:3101/health  # {"ok":true,"userId":"kristina"}

# Rachit
curl -s http://127.0.0.1:3102/health  # {"ok":true,"userId":"rachit"}
```

```sql
-- Heartbeat check (within 5 min of service start)
SELECT agent_name, browser_healthy, last_check_at
FROM poster_heartbeats
WHERE agent_name IN (
  'linkedin-poster-selfhost-kristina',
  'linkedin-poster-selfhost-rachit'
)
ORDER BY last_check_at DESC;
```

### 7d. Queue consumer scoping

The `QueueConsumer` scopes `linkedin_engagement_queue` items by `sender_id` matching `USER_ID`. Ensure RGOS engagement queue rows use the correct `sender_id` values (`kristina`, `rachit`) that match the `--user` flag used at install time.

---

## Post-Migration Checklist

- [ ] Greg: `browser_healthy=true` in poster_heartbeats, stable 24h
- [ ] Greg: Mac LaunchAgent unloaded and plist disabled
- [ ] Kristina: /health returns ok, heartbeat confirmed
- [ ] Rachit: /health returns ok, heartbeat confirmed
- [ ] No double-claiming: verify no Mac poster still running (`launchctl list | grep linkedin`)
- [ ] RGOS engagement queue processing: insert test row per user, confirm `status=posted`
- [ ] Notify orchestrator: P4 complete, ready for production engagement traffic
