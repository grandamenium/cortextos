#!/usr/bin/env bash
# Daily 18:00 Telegram digest
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Use platform-director's Telegram bot for sending
PD_ENV=/Users/arndt/cortextos/.claude/worktrees/objective-mclaren/orgs/phytomedic/agents/platform-director/.env
[ -f "$PD_ENV" ] && set -a && . "$PD_ENV" && set +a
export CTX_AGENT_NAME=platform-director
export CTX_ORG=phytomedic
TODAY=$(date +%Y-%m-%d)
CHAT_ID=${TELEGRAM_CHAT_ID:-353207237}
PHYTO=/Users/arndt/phytomedic-saas

PRS_MERGED=$(cd "$PHYTO" && gh pr list --state merged --search "merged:$TODAY" --limit 50 --json number,title 2>/dev/null | python3 -c "
import json,sys
try:
    prs = json.load(sys.stdin)
    print(f'{len(prs)} PRs merged today')
    for p in prs[:5]: print(f'  • #{p[\"number\"]} {p[\"title\"][:60]}')
except: print('PR fetch failed')
" 2>&1)

OPEN_PRS=$(cd "$PHYTO" && gh pr list --state open --limit 20 --json number 2>/dev/null | python3 -c "import json,sys; prs=json.load(sys.stdin); print(f'{len(prs)} open PRs')" 2>&1)
AGENTS=$(cortextos status 2>&1 | grep -c "running" || echo "?")
HUMAN=$(cortextos bus list-tasks 2>&1 | grep -c "HUMAN" || echo "0")
PHASE1=$(cortextos bus list-tasks 2>&1 | grep -E "SHADOW-01|B2B-02|B2B-03|UPLOAD-03|POLISH-04" | head -10)

MSG="📊 Daily Digest — $TODAY

🚀 PRs:
$PRS_MERGED
$OPEN_PRS

🤖 Fleet: $AGENTS/7 agents

🎯 B2B Phase 1:
$PHASE1

⚠️ HUMAN blocked: $HUMAN

— daily-digest cron"

cortextos bus send-telegram "$CHAT_ID" "$MSG" || echo "Telegram send failed"
echo "## $(date '+%H:%M') Daily digest sent ✓" >> /Users/arndt/cortextos/obsidian-vault/user/daily/$TODAY.md
