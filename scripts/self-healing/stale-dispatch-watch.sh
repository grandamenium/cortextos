#!/usr/bin/env bash
# stale-dispatch-watch.sh — Theta-4 Proposal A: BA stale-dispatch triage
#
# WHY: backend-architect authors tasks that need cross-agent dispatch but are
# never picked up. Observed 2026-06-27: 17-19 tasks with p95=40 days pending
# with no assignee — invisible capacity leak. This script surfaces them weekly
# to platform-director for re-routing before they age further.
#
# WHAT: query all pending tasks authored by backend-architect with no assignee
# (or self-assigned). Flag any older than STALE_DAYS (default 7d). Route the
# list to platform-director via bus send-message.
#
# Run:  bash scripts/self-healing/stale-dispatch-watch.sh
# Exit: 0 = no stale tasks                   — no fire
#       1 = stale tasks found (>STALE_DAYS)  — report sent to platform-director
#       2 = probe error (bus unreadable)      — do NOT fire
set -euo pipefail

STALE_DAYS="${STALE_DISPATCH_DAYS:-7}"

# Probe: get all pending tasks as JSON
TASKS_JSON=$(cortextos bus list-tasks --status pending --format json 2>/dev/null) || {
  echo "STALE-DISPATCH-WATCH: probe error — bus list-tasks failed"
  exit 2
}

if [ -z "$TASKS_JSON" ] || [ "$TASKS_JSON" = "[]" ] || [ "$TASKS_JSON" = "null" ]; then
  echo "STALE-DISPATCH-WATCH: no pending tasks in bus — probe OK"
  exit 0
fi

# Find BA-authored tasks with no external assignee, older than STALE_DAYS
STALE=$(python3 - "$TASKS_JSON" "$STALE_DAYS" <<'PYEOF'
import json, sys, datetime

tasks = json.loads(sys.argv[1])
threshold_days = int(sys.argv[2])
now = datetime.datetime.now(datetime.timezone.utc)

stale = []
for t in tasks:
    author = t.get("author", "") or t.get("created_by", "")
    assignee = t.get("assignee", "") or ""
    if author != "backend-architect":
        continue
    # Only flag tasks with no assignee or self-assigned
    if assignee and assignee not in ("", "backend-architect"):
        continue
    created_raw = t.get("created_at", "") or ""
    if not created_raw:
        continue
    try:
        if isinstance(created_raw, int) or isinstance(created_raw, float):
            created_dt = datetime.datetime.fromtimestamp(
                created_raw / 1000, tz=datetime.timezone.utc
            )
        else:
            created_dt = datetime.datetime.fromisoformat(
                str(created_raw).replace("Z", "+00:00")
            )
        age_days = (now - created_dt).days
    except Exception:
        continue
    if age_days >= threshold_days:
        stale.append({
            "id": t.get("id", ""),
            "title": t.get("title", "")[:70],
            "age_days": age_days,
            "priority": t.get("priority", "normal"),
        })

stale.sort(key=lambda x: x["age_days"], reverse=True)
print(json.dumps(stale))
PYEOF
)

COUNT=$(echo "$STALE" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

if [ "$COUNT" -eq 0 ]; then
  echo "STALE-DISPATCH-WATCH: 0 BA-authored unassigned tasks >${STALE_DAYS}d — clean"
  cortextos bus log-event action stale_dispatch_watch info --meta "{\"stale_count\":0,\"threshold_days\":$STALE_DAYS}" 2>/dev/null || true
  exit 0
fi

# Build summary for PD
SUMMARY=$(echo "$STALE" | python3 -c "
import json, sys
tasks = json.load(sys.stdin)
lines = []
for t in tasks[:10]:
    lines.append(f\"  {t['age_days']}d [{t['priority']}] {t['id']}: {t['title']}\")
total = len(tasks)
header = f'STALE-DISPATCH-WATCH: {total} BA-authored pending tasks unassigned >{sys.argv[1]}d:'
body = chr(10).join(lines)
if total > 10:
    body += f'\n  ... +{total-10} more'
print(header + '\n' + body)
" "$STALE_DAYS" 2>/dev/null)

echo "$SUMMARY"

# Route to platform-director
MSG="STALE-DISPATCH-WATCH (weekly triage): $COUNT backend-architect-authored tasks have been in pending-dispatch with no assignee for >${STALE_DAYS} days. Top entries: $(echo "$STALE" | python3 -c "import json,sys; ts=json.load(sys.stdin); print(', '.join(f\"{t['age_days']}d {t['id']}\" for t in ts[:5]))" 2>/dev/null). Action: re-route to correct assignee or close if stale/superseded. Full list: cortextos bus list-tasks --status pending --format json | filter author=backend-architect+no-assignee."

cortextos bus send-message platform-director normal "$MSG" 2>/dev/null || {
  echo "STALE-DISPATCH-WATCH: failed to send message to platform-director"
}

cortextos bus log-event action stale_dispatch_watch warn --meta "{\"stale_count\":$COUNT,\"threshold_days\":$STALE_DAYS}" 2>/dev/null || true

exit 1
