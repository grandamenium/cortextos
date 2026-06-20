#!/usr/bin/env bash
# Probes API endpoints to auto-detect when User completed HUMAN tasks
# Runs hourly via cron
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PD_ENV=/Users/arndt/cortextos/.claude/worktrees/objective-mclaren/orgs/phytomedic/agents/platform-director/.env
[ -f "$PD_ENV" ] && set -a && . "$PD_ENV" && set +a
export CTX_AGENT_NAME=human-task-pulse
export CTX_ORG=phytomedic
PHYTO=/Users/arndt/phytomedic-saas
LOG=/Users/arndt/cortextos/logs/human-task-pulse.log
TODAY=$(date +%Y-%m-%d)
mkdir -p $(dirname "$LOG")

echo "=== $(date) HUMAN-task-pulse run ===" >> "$LOG"

# ─── Probe 1: Yousign production API keys ─────────
# Check if YOUSIGN_API_KEY env var is set in Vercel
YOUSIGN_OK="no"
if cd "$PHYTO" && npx vercel env ls production 2>/dev/null | grep -q "YOUSIGN_API_KEY"; then
  YOUSIGN_OK="yes"
fi
echo "Yousign API key in Vercel prod: $YOUSIGN_OK" >> "$LOG"

if [ "$YOUSIGN_OK" = "yes" ]; then
  # Find + close Yousign HUMAN task
  TASK_ID=$(cortextos bus list-tasks 2>&1 | grep -i "yousign" | grep -E "HUMAN" | grep -oE "task_[0-9_]+" | head -1)
  if [ -n "$TASK_ID" ]; then
    cortextos bus complete-task "$TASK_ID" --result "VERIFIED auto-detected: YOUSIGN_API_KEY set in Vercel production env at $(date -Iseconds). Auto-closed by human-task-pulse." 2>&1 | head -1 >> "$LOG"
    echo "✓ Auto-closed Yousign task $TASK_ID" >> "$LOG"
  fi
fi

# ─── Probe 2: Cannaflow merchant onboarding ─────────
# Check if any Cannaflow pharmacy was synced recently (indicates merchant active)
CANNAFLOW_OK="no"
if cd "$PHYTO" && npx convex run --prod functions/admin:listCatalogProviders 2>/dev/null | grep -q "cannaflow"; then
  # Provider is registered — check if it has pharmacies
  CANNAFLOW_OK="yes"
fi
echo "Cannaflow merchant active: $CANNAFLOW_OK" >> "$LOG"

if [ "$CANNAFLOW_OK" = "yes" ]; then
  TASK_ID=$(cortextos bus list-tasks 2>&1 | grep -i "cannaflow" | grep -E "HUMAN" | grep -oE "task_[0-9_]+" | head -1)
  if [ -n "$TASK_ID" ]; then
    cortextos bus complete-task "$TASK_ID" --result "VERIFIED auto-detected: Cannaflow provider returns pharmacies at $(date -Iseconds). Auto-closed by human-task-pulse." 2>&1 | head -1 >> "$LOG"
    echo "✓ Auto-closed Cannaflow task $TASK_ID" >> "$LOG"
  fi
fi

# ─── Probe 3: DAILY_API_KEY ─────────
DAILY_OK="no"
if cd "$PHYTO" && npx vercel env ls production 2>/dev/null | grep -q "DAILY_API_KEY"; then
  DAILY_OK="yes"
fi
echo "Daily.co API key in Vercel: $DAILY_OK" >> "$LOG"

# ─── Probe 4: nudge user if Yousign/Cannaflow still open & age > 7d ─────────
NEEDS_NUDGE=$(cortextos bus list-tasks 2>&1 | grep -E "HUMAN.*Yousign|HUMAN.*Cannaflow")
if [ -n "$NEEDS_NUDGE" ] && [ "$YOUSIGN_OK" = "no" ] && [ $(date +%H) = "10" ]; then
  # Send nudge at 10:00 daily if blocked
  CHAT_ID=${TELEGRAM_CHAT_ID:-353207237}
  cortextos bus send-telegram "$CHAT_ID" "⏰ HUMAN-task nudge: Yousign + Cannaflow noch nicht erkannt. Mit jedem Tag offen wartet System auf Dich.

$NEEDS_NUDGE" 2>&1 | head -1 >> "$LOG"
  echo "✓ Nudge sent" >> "$LOG"
fi

echo "" >> "$LOG"
