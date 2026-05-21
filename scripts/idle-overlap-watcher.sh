#!/bin/bash
# Idle-overlap watcher v2: any agent with >=1 pending task AND zero in_progress tasks = kick candidate.
# Improvement over v1: catches agents reporting "holding" / "healthy" / non-literal-idle states.
# Runs every 15min via orchestrator cron.
set -euo pipefail

OUTDIR=/home/cortextos/cortextos/orgs/revops-global/agents/orchestrator/output/idle-overlap-watch
mkdir -p "$OUTDIR"
LOG="$OUTDIR/$(date -u +%Y-%m-%dT%H%M%SZ).md"

# Get a clean task list once
TASKS=$(cortextos bus list-tasks 2>/dev/null)

# Pending count overall, excluding human-only operational tasks. Use here-strings instead of echo|awk pipelines:
# awk exits early below, and with pipefail an upstream SIGPIPE can abort the
# watcher before it writes a useful log.
PENDING_COUNT=$(awk '/^  ○/ && $4 != "greg" && $4 != "human" && $5 != "[HUMAN]" && $5 != "[MORNING]"' <<< "$TASKS" | wc -l)

# Find agents with assigned pending tasks
CANDIDATES=$(awk '/^  ○/ && $4 != "greg" && $4 != "human" && $5 != "[HUMAN]" && $5 != "[MORNING]" {print $4}' <<< "$TASKS" | sort -u | tr '\n' ' ')

{
echo "# Idle-overlap check v2 — $(date -u)"
echo ""
echo "- Pending tasks: $PENDING_COUNT"
echo "- Candidates (have pending): $CANDIDATES"
echo ""
} > "$LOG"

if [[ $PENDING_COUNT -lt 1 ]]; then
    echo "OK — no pending tasks." | tee -a "$LOG"
    exit 0
fi

KICKED=0
for AGENT in $CANDIDATES; do
    # Skip non-worker pseudo-agents and human operators.
    case "$AGENT" in
        orchestrator|orgo-1|cortextos|state|human|greg|"") continue ;;
    esac

    # Count in_progress tasks for this agent
    IN_PROGRESS=$(awk -v a="$AGENT" '/^  ●/ && $4 == a' <<< "$TASKS" | wc -l)

    # If already working >= 1 task, skip (don't pile on)
    if [[ $IN_PROGRESS -gt 0 ]]; then
        echo "- $AGENT: already in_progress on $IN_PROGRESS task(s) — skip" | tee -a "$LOG"
        continue
    fi

    # Pick highest-priority pending task (orange > blue > white)
    TASK_LINE=$(awk -v a="$AGENT" '/^  ○.*🟠/ && $4 == a && $5 != "[HUMAN]" && $5 != "[MORNING]" {print; exit}' <<< "$TASKS")
    if [[ -z "$TASK_LINE" ]]; then
        TASK_LINE=$(awk -v a="$AGENT" '/^  ○/ && $4 == a && $5 != "[HUMAN]" && $5 != "[MORNING]" {print; exit}' <<< "$TASKS")
    fi

    TASK_ID=$(awk '{print $3}' <<< "$TASK_LINE")
    TASK_TITLE=$(sed -E 's/^[^a-zA-Z]+task_[0-9_]+ +[a-zA-Z0-9_-]+ +//' <<< "$TASK_LINE")

    echo "- $AGENT: kicking on $TASK_ID — $TASK_TITLE" | tee -a "$LOG"
    cortextos bus send-message "$AGENT" high "IDLE-OVERLAP NUDGE — you have pending task $TASK_ID ($TASK_TITLE) and no in-progress work. Claim + start. If blocked, reply with blocker." 2>/dev/null || true
    KICKED=$((KICKED + 1))
done

# Telegram only when 2+ agents kicked (real imbalance signal)
if [[ $KICKED -ge 2 ]]; then
    cortextos bus send-telegram "${CTX_TELEGRAM_CHAT_ID:-8567114601}" "Idle-overlap watcher v2: $KICKED agents had pending tasks but no in_progress. Auto-kicked. Log: $LOG"
fi

echo "Done. Kicked=$KICKED." | tee -a "$LOG"
