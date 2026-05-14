#!/usr/bin/env bash
set -euo pipefail

# setup-tunnel.sh — provision Cloudflare Tunnel for dashboard.clicktoacquire.com
#
# Run ONCE after logging in:
#   cloudflared tunnel login   ← opens browser, stores ~/.cloudflared/cert.pem
#   ./infra/cloudflare-tunnel/setup-tunnel.sh

TUNNEL_NAME="cta-dashboard"
HOSTNAME="dashboard.clicktoacquire.com"
CLOUDFLARED="/opt/homebrew/bin/cloudflared"
CERT="$HOME/.cloudflared/cert.pem"
CREDS="$HOME/.cloudflared/${TUNNEL_NAME}.json"
PLIST="$HOME/Library/LaunchAgents/com.cortextos.dashboard-tunnel.plist"

# --- pre-flight ---

if [[ ! -x "$CLOUDFLARED" ]]; then
  echo "ERROR: cloudflared not found at $CLOUDFLARED"
  echo "  Install with: brew install cloudflared"
  exit 1
fi

if [[ ! -f "$CERT" ]]; then
  echo "ERROR: Cloudflare certificate not found at $CERT"
  echo ""
  echo "  Run this first (opens browser, ~30 seconds):"
  echo "    cloudflared tunnel login"
  echo ""
  echo "  Then re-run this script."
  exit 1
fi

# --- create tunnel (idempotent — skip if credentials already exist) ---

if [[ -f "$CREDS" ]]; then
  echo "Tunnel credentials already exist at $CREDS — skipping tunnel create."
else
  echo "Creating tunnel: $TUNNEL_NAME"
  "$CLOUDFLARED" tunnel create "$TUNNEL_NAME"
fi

# --- wire DNS (idempotent — cloudflared upserts the CNAME) ---

echo "Routing DNS: $HOSTNAME -> $TUNNEL_NAME"
"$CLOUDFLARED" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

# --- load launchd agent ---

if launchctl list | grep -q "com.cortextos.dashboard-tunnel"; then
  echo "Tunnel launchd job already loaded — reloading..."
  launchctl unload "$PLIST" 2>/dev/null || true
fi

launchctl load "$PLIST"
echo "Tunnel launchd job loaded."

# --- verify ---

sleep 3
if launchctl list | grep -q "com.cortextos.dashboard-tunnel"; then
  echo ""
  echo "✓ Tunnel running."
  echo "✓ DNS routed: $HOSTNAME -> $TUNNEL_NAME"
  echo ""
  echo "Allow 30–60s for DNS to propagate, then visit:"
  echo "  https://$HOSTNAME"
  echo ""
  echo "Monitor tunnel log:"
  echo "  tail -f ~/.cloudflared/tunnel.log"
else
  echo ""
  echo "WARNING: tunnel launchd job did not start."
  echo "  Check: tail -f ~/.cloudflared/tunnel.log"
fi
