# Cloudflare Tunnel — dashboard.clicktoacquire.com

Exposes the local Next.js dashboard (port 3000) at `https://dashboard.clicktoacquire.com` via a persistent Cloudflare Tunnel, with no open inbound firewall ports.

## Prerequisites

- `cloudflared` installed: `brew install cloudflared` (already present at `/opt/homebrew/bin/cloudflared`)
- A Cloudflare account that controls the `clicktoacquire.com` zone

---

## Setup — 3 commands (one browser click)

### Step 1 — Authenticate to Cloudflare (one-time, ~30 seconds)

```bash
cloudflared tunnel login
```

This opens your browser. Log in to Cloudflare and click **Authorize**. It saves `~/.cloudflared/cert.pem` — no token needed anywhere else.

### Step 2 — Create tunnel + route DNS + start launchd agent

```bash
./infra/cloudflare-tunnel/setup-tunnel.sh
```

This script (idempotent — safe to re-run):
- Creates the `cta-dashboard` tunnel → writes `~/.cloudflared/cta-dashboard.json`
- Routes `dashboard.clicktoacquire.com` CNAME → tunnel
- Loads the launchd agent (auto-restarts on reboot)

### Step 3 — Wait 30–60s for DNS, then visit

```
https://dashboard.clicktoacquire.com
```

Monitor tunnel health:

```bash
tail -f ~/.cloudflared/tunnel.log
```

---

## Files

| File | Location | Purpose |
|------|----------|---------|
| `~/.cloudflared/config.yml` | disk only | cloudflared config — tunnel name, credentials path, ingress rules |
| `~/.cloudflared/cta-dashboard.json` | disk only (created by setup script) | tunnel credentials — keep secret |
| `~/Library/LaunchAgents/com.cortextos.dashboard-tunnel.plist` | disk only | launchd agent — runs `cloudflared tunnel run` on login |
| `infra/cloudflare-tunnel/setup-tunnel.sh` | this repo | one-time provisioning script |

---

## Stopping / Unloading

```bash
launchctl unload ~/Library/LaunchAgents/com.cortextos.dashboard-tunnel.plist
```

## Logs

```bash
tail -f ~/.cloudflared/tunnel.log
```

---

## Dashboard Server (localhost:3000)

The tunnel proxies to `localhost:3000`. The dashboard must be running **in production mode** (`npm start`) when the tunnel is live — not dev mode.

### Auto-start (launchd)

A separate plist manages the dashboard server:

```bash
# Load once (survives reboots/login):
launchctl load ~/Library/LaunchAgents/com.cortextos.dashboard.plist

# Verify running:
lsof -i :3000 | grep LISTEN

# Logs:
tail -f ~/.cortextos/logs/dashboard.log
```

The plist runs `node /usr/local/lib/node_modules/npm/bin/npm-cli.js start` with `WorkingDirectory=/Users/robert/cortextos/dashboard`, `NODE_ENV=production`, `KeepAlive=true`, `RunAtLoad=true`.

> **Note:** `ecosystem.config.js` has a `cortextos-dashboard` entry but it uses `npm run dev` — do not use pm2 for this; launchd owns the production process.

### Stop / restart dashboard

```bash
launchctl unload ~/Library/LaunchAgents/com.cortextos.dashboard.plist
launchctl load  ~/Library/LaunchAgents/com.cortextos.dashboard.plist
```

### Morning checklist (first-time setup)

1. `cloudflared tunnel login` ← browser OAuth, one-time
2. `./infra/cloudflare-tunnel/setup-tunnel.sh` ← creates tunnel + DNS + loads agent
3. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login` → should be 200
4. Visit `https://dashboard.clicktoacquire.com`

### After a reboot

Both launchd agents (`com.cortextos.dashboard` and `com.cortextos.dashboard-tunnel`) have `RunAtLoad=true` and `KeepAlive=true` — they restart automatically. No manual steps needed after first-time setup.
