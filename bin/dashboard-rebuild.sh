#!/usr/bin/env bash
# Rebuild the cortextos dashboard and restart the PM2 process.
# Run this after any dashboard source code change (new commit to dashboard/).
#
# Auto-rebuild on git pull (option a) is deferred to v2 — cortextos is not
# on the auto-pull cron and changes land via local agent commits. If that
# changes, wire a git post-commit hook here instead.
set -euo pipefail

DASHBOARD_DIR="$(cd "$(dirname "$0")/../dashboard" && pwd)"

echo "[dashboard-rebuild] Building dashboard..."
cd "$DASHBOARD_DIR"
npm run build

echo "[dashboard-rebuild] Restarting PM2 process..."
pm2 restart cortextos-dashboard

echo "[dashboard-rebuild] Done. Dashboard is live on production build."
