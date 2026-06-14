#!/usr/bin/env bash
# Test harness for dispatch-marker.sh — isolated tmp store per case, no bus.
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/self-healing/dispatch-marker.sh"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

mkstore(){ local d; d=$(mktemp -d); mkdir -p "$d/audit" "$d/.claims"; echo "$d"; }
mktask(){ # dir id title status assigned_to [descr]  — file MUST match task_*.json glob
  local d="$1" id="$2" title="$3" st="$4" ass="$5" desc="${6:-}"
  python3 - "$d/task_$id.json" "$id" "$title" "$st" "$ass" "$desc" <<'PY'
import json,sys
p,id,title,st,ass,desc=sys.argv[1:7]
json.dump({"id":id,"title":title,"description":desc,"type":"agent","needs_approval":False,
"status":st,"assigned_to":ass,"created_by":"systems-analyst","org":"phytomedic","priority":"normal",
"project":"","kpi_key":None,"created_at":"2026-06-01T00:00:00Z","updated_at":"2026-06-01T00:00:00Z",
"completed_at":None,"due_date":None,"archived":False,"result":None},open(p,"w"),indent=2)
PY
}
run(){ DISPATCH_TASK_DIR="$1" DISPATCH_NO_BUS=1 bash "$SCRIPT" >"$1/.out" 2>&1; }
field(){ jq -r "$2" "$1/task_$3.json"; }

echo "TEST dispatch-marker"

# 1. happy path: marker:frontend-dev, assigned SA -> reassigned + title rewritten + audit
d=$(mkstore); mktask "$d" t1 "[PRE-DISPATCH-READY:frontend-dev] fix tag pills" pending systems-analyst
run "$d"
[ "$(field "$d" .assigned_to t1)" = frontend-dev ] && ok "1a reassigned to frontend-dev" || no "1a assignee=$(field "$d" .assigned_to t1)"
case "$(field "$d" .title t1)" in "[DISPATCHED:frontend-dev]"*) ok "1b title rewritten";; *) no "1b title=$(field "$d" .title t1)";; esac
grep -q '"event": "marker_dispatch"' "$d/audit/t1.jsonl" 2>/dev/null && ok "1c audit line" || no "1c no audit line"

# 2. idempotency: second run = no-op
before=$(field "$d" .updated_at t1); run "$d"
[ "$(field "$d" .title t1 | grep -c 'PRE-DISPATCH-READY')" = 0 ] && ok "2 idempotent (no re-match)" || no "2 re-matched"
[ "$(wc -l < "$d/audit/t1.jsonl" | tr -d ' ')" = 1 ] && ok "2b single audit entry" || no "2b audit entries=$(wc -l < "$d/audit/t1.jsonl" | tr -d ' ')"

# 3. markerless -> untouched
d=$(mkstore); mktask "$d" t3 "[PRE-DISPATCH-READY] no role" pending systems-analyst
run "$d"
[ "$(field "$d" .assigned_to t3)" = systems-analyst ] && ok "3 markerless skipped" || no "3 changed to $(field "$d" .assigned_to t3)"

# 4. unknown role -> skip, no write
d=$(mkstore); mktask "$d" t4 "[PRE-DISPATCH-READY:fnord] x" pending systems-analyst
run "$d"
[ "$(field "$d" .assigned_to t4)" = systems-analyst ] && ok "4 unknown-role skipped" || no "4 changed"
grep -q 'bad-role:fnord' "$d/.out" && ok "4b logged bad-role" || no "4b no bad-role log"

# 5. saturation: FE cap=1, 2 existing FE pending -> HOLD, marker stays
d=$(mkstore); mktask "$d" fe1 "x" pending frontend-dev; mktask "$d" fe2 "y" pending frontend-dev
mktask "$d" t5 "[PRE-DISPATCH-READY:frontend-dev] z" pending systems-analyst
DISPATCH_TASK_DIR="$d" DISPATCH_NO_BUS=1 DISPATCH_CAP_FE=1 bash "$SCRIPT" >"$d/.out" 2>&1
[ "$(field "$d" .assigned_to t5)" = systems-analyst ] && ok "5 held (not dispatched)" || no "5 dispatched despite cap"
case "$(field "$d" .title t5)" in "[PRE-DISPATCH-READY:frontend-dev]"*) ok "5b marker preserved";; *) no "5b marker lost";; esac
grep -q 'HOLD' "$d/.out" && ok "5c logged HOLD" || no "5c no HOLD log"

# 6. in_progress with valid marker -> skip
d=$(mkstore); mktask "$d" t6 "[PRE-DISPATCH-READY:backend-architect] x" in_progress systems-analyst
run "$d"
[ "$(field "$d" .assigned_to t6)" = systems-analyst ] && ok "6 in_progress skipped" || no "6 changed"

# 7. marker + conflicting Assignee: prose -> skip (avoid flip-flop with assignee-reconcile)
d=$(mkstore); mktask "$d" t7 "[PRE-DISPATCH-READY:frontend-dev] x" pending systems-analyst "Assignee: backend-architect"
run "$d"
[ "$(field "$d" .assigned_to t7)" = systems-analyst ] && ok "7 prose-conflict skipped" || no "7 changed despite conflict"
grep -q 'prose-conflict' "$d/.out" && ok "7b logged prose-conflict" || no "7b no conflict log"

# 7b. marker + AGREEING prose -> dispatched
d=$(mkstore); mktask "$d" t8 "[PRE-DISPATCH-READY:frontend-dev] x" pending systems-analyst "Assignee: frontend-dev"
run "$d"
[ "$(field "$d" .assigned_to t8)" = frontend-dev ] && ok "8 agreeing prose dispatched" || no "8 not dispatched"

# 8. stale claim owned by other agent -> skip
d=$(mkstore); mktask "$d" t9 "[PRE-DISPATCH-READY:frontend-dev] x" pending systems-analyst
printf 'backend-architect\t2026-06-01T00:00:00Z' > "$d/.claims/t9.claim"
run "$d"
[ "$(field "$d" .assigned_to t9)" = systems-analyst ] && ok "9 stale-claim skipped" || no "9 changed despite stale claim"
grep -q 'stale-claim:backend-architect' "$d/.out" && ok "9b logged stale-claim" || no "9b no stale-claim log"

# 9. dry-run -> no writes
d=$(mkstore); mktask "$d" t10 "[PRE-DISPATCH-READY:frontend-dev] x" pending systems-analyst
DISPATCH_TASK_DIR="$d" DISPATCH_NO_BUS=1 DISPATCH_DRY_RUN=1 bash "$SCRIPT" >"$d/.out" 2>&1
[ "$(field "$d" .assigned_to t10)" = systems-analyst ] && ok "10 dry-run no write" || no "10 wrote in dry-run"
[ ! -f "$d/audit/t10.jsonl" ] && ok "10b dry-run no audit" || no "10b dry-run wrote audit"

echo ""; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
