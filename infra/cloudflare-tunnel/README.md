# Cloudflare Tunnel — dashboard.clicktoacquire.com

Exposes the local Next.js dashboard (port 3000) at `https://dashboard.clicktoacquire.com` via a persistent Cloudflare Tunnel, with no open inbound firewall ports.

## Prerequisites

- `cloudflared` installed: `brew install cloudflared` (already present at `/opt/homebrew/bin/cloudflared`)
- A Cloudflare account that controls the `clicktoacquire.com` zone

---

## One-Minute Setup

### Step 1 — Create a CF API Token

1. Go to **https://dash.cloudflare.com/profile/api-tokens**
2. Click **Create Token** → use a custom token
3. Grant these permissions:
   - **Zone → DNS → Edit** (scope: `clicktoacquire.com`)
   - **Account → Cloudflare Tunnel → Edit**
4. Copy the token

### Step 2 — Export the token and run the setup script

```bash
export CF_API_TOKEN=<paste token here>
./infra/cloudflare-tunnel/setup-tunnel.sh
```

This script:
- Creates the `cta-dashboard` tunnel in Cloudflare
- Routes `dashboard.clicktoacquire.com` DNS to the tunnel
- Prints next steps

The tunnel credentials JSON is written to `~/.cloudflared/cta-dashboard.json` (gitignored, never committed).

### Step 3 — Load the launchd agent (auto-starts on login)

```bash
launchctl load ~/Library/LaunchAgents/com.cortextos.dashboard-tunnel.plist
```

Verify it started:

```bash
launchctl list | grep dashboard-tunnel
tail -f ~/.cloudflared/tunnel.log
```

### Step 4 — Visit the dashboard

```
https://dashboard.clicktoacquire.com
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

### Morning checklist (when CF token is ready)

1. `launchctl load ~/Library/LaunchAgents/com.cortextos.dashboard.plist` (if not already loaded)
2. `export CF_API_TOKEN=<token>`
3. `./infra/cloudflare-tunnel/setup-tunnel.sh`
4. `launchctl load ~/Library/LaunchAgents/com.cortextos.dashboard-tunnel.plist`
5. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login` → should be 200
6. Visit `https://dashboard.clicktoacquire.com`
