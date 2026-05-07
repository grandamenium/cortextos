#!/usr/bin/env bash
# cortextos-dashboard launcher.
# Checks for a production build; runs next build if missing, then next start.
# Used by PM2 via ecosystem.config.js — do NOT call directly for rebuilds,
# use bin/dashboard-rebuild.sh instead.
set -euo pipefail

DASHBOARD_DIR="$(cd "$(dirname "$0")/../dashboard" && pwd)"
BUILD_ID="$DASHBOARD_DIR/.next/BUILD_ID"

if [[ ! -f "$BUILD_ID" ]]; then
  echo "[dashboard-launcher] No production build found — running next build..."
  cd "$DASHBOARD_DIR"
  npm run build
  echo "[dashboard-launcher] Build complete."
fi

echo "[dashboard-launcher] Starting production server..."
cd "$DASHBOARD_DIR"
exec npm run start
