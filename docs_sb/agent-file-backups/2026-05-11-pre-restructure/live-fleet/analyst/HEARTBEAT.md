# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes. Do not ignore them.
Target: 0 un-ACK'd messages after this step.

## Step 3: System health check (ANALYST — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`

```bash
# Check all agent heartbeats — flag any silent for >5 hours
cortextos bus read-all-heartbeats

# Check for agents with no recent activity
cortextos bus list-tasks --status in_progress 2>/dev/null | head -20
```

For each agent: if heartbeat is older than 5 hours, send a message to that agent:
```bash
cortextos bus send-message <agent_name> normal "Heartbeat check: are you running? Last heartbeat was more than 5 hours ago."
```

If an agent is unresponsive for >8 hours, notify the orchestrator and log the issue:
```bash
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Agent <name> appears unresponsive — last heartbeat >8h ago. May need restart."
cortextos bus log-event action agent_unresponsive warning --meta '{"agent":"<name>","hours_silent":8}'
```

## Step 3c: Fleet integrity audit (added 2026-05-05 per protocols-v1)

Full spec: `specs/integrity-protocols-v1.md`. Run these three checks every heartbeat:

```bash
TODAY=$(date -u +%Y-%m-%d)
EVENT_DIR=~/.cortextos/$CTX_INSTANCE_ID/orgs/$CTX_ORG/analytics/events

# Audit 1 (Protocol A) — first-touch compliance.
# Only consider events AFTER protocols_v1_adopted (2026-05-05T22:31:31Z); pre-protocol
# events (e.g. phase23_merged from earlier today) are historical and excluded.
PROTOCOL_FLOOR="2026-05-05T22:31:31Z"
for f in "$EVENT_DIR"/engineer/$TODAY.jsonl; do
  [ -f "$f" ] || continue
  jq -c --arg floor "$PROTOCOL_FLOOR" \
    'select(.timestamp > $floor and ((.event // "") | test("merged|push_to_main|merge_executed")))' "$f"
done

# Audit 2 (Protocol B) — merge-gate compliance.
# Any merge_executed with approval_id null OR not in approval log OR not approved → PAGE.
for f in "$EVENT_DIR"/*/$TODAY.jsonl; do
  [ -f "$f" ] || continue
  jq -c 'select(.event=="merge_executed" and (.metadata.approval_id // null == null))' "$f"
done

# Audit 2b (Protocol B v1.1) — chain-of-custody.
# Any approval where requesting_agent == resolving_agent → PAGE.
# resolving_agent is inferred from the approval_resolved_by_relay event for that approval_id.
APPROVALS=$(cortextos bus list-approvals 2>/dev/null)
echo "$APPROVALS" | jq -c '.[] | select(.status!="pending") | {id, requesting_agent, status}' | while read row; do
  AID=$(echo "$row" | jq -r '.id')
  REQ=$(echo "$row" | jq -r '.requesting_agent')
  RESOLVER=$(for f in "$EVENT_DIR"/*/$TODAY.jsonl; do [ -f "$f" ] && jq -r --arg id "$AID" 'select(.event=="approval_resolved_by_relay" and .metadata.approval_id==$id) | .agent' "$f"; done | head -1)
  if [ -n "$RESOLVER" ] && [ "$RESOLVER" = "$REQ" ]; then
    echo "CHAIN_OF_CUSTODY_VIOLATION approval=$AID agent=$REQ"
  fi
done

# Audit 3 (Protocol B) — approval staleness scan.
# Any approval aged >4h during work hours (09:00–22:00 IST = 03:30–16:30 UTC).
cortextos bus list-approvals --json 2>/dev/null | jq -r '
  .[] | select(.status=="pending") |
  "\(.id) age=\(now - (.created_at | fromdateiso8601)) status=\(.status)"
'
```

For any audit hit:
- merge_executed without resolved approval → PAGE Saurav direct via send-telegram
- repo_first_touch missing for a write → ping Saurav
- approval pending >4h during work hours → ping Saurav

## Step 3d: Fleet-context relay watch (added 2026-05-06 per protocols-v1.2)

Full spec: `specs/integrity-protocols-v1.md` Protocol D. Verify every Saurav-direct fleet-wide-keyword message reached its propagation target within 10 min.

```bash
V1_2_FLOOR="2026-05-06T07:55:58Z"
TODAY=$(date -u +%Y-%m-%d)
EVENT_DIR=~/.cortextos/$CTX_INSTANCE_ID/orgs/$CTX_ORG/analytics/events
INBOUND_BASE=~/.cortextos/$CTX_INSTANCE_ID/logs

# Trigger keywords (per spec — match case-insensitive on the message body)
KEYWORDS='based in|flying|flight|land|landed|back online|offline|afk|in meeting|out for|vacation|OOO|timezone|work hours|focus|priority|goal|travel|schedule|urgent'

# For each agent, scan its inbound-messages.jsonl for Saurav-direct fleet-wide-keyword msgs
# since V1_2_FLOOR. For each, check whether a relay/propagated/ACK event landed within 10 min.
NOW_EPOCH=$(date -u +%s)
for agent in boss analyst engineer; do
  inbound="${INBOUND_BASE}/${agent}/inbound-messages.jsonl"
  events="${EVENT_DIR}/${agent}/${TODAY}.jsonl"
  [ -f "$inbound" ] || continue

  # Saurav-direct messages from chat 1109153956 since the floor that match keywords
  jq -c --arg floor "$V1_2_FLOOR" --arg kw "$KEYWORDS" \
    'select(.chat_id==1109153956 and .timestamp > $floor and (.text // "" | test($kw; "i")))' \
    "$inbound" 2>/dev/null | while read msg; do

    MSG_TS=$(echo "$msg" | jq -r '.timestamp')
    MSG_ID=$(echo "$msg" | jq -r '.message_id')
    MSG_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%S" "${MSG_TS%.*}" +%s 2>/dev/null || echo 0)
    AGE_MIN=$(( (NOW_EPOCH - MSG_EPOCH) / 60 ))

    # Look for matching relay/propagate/ACK event within 10 min of MSG_TS
    RELAY_FOUND=$(jq -c --arg id "$MSG_ID" \
      'select((.event=="fleet_context_relay" or .event=="fleet_context_propagated") and (.metadata.telegram_msg_id|tostring)==$id)' \
      "$events" 2>/dev/null | head -1)

    # ACK-includes-relay shortcut: an outbound telegram_sent within 60s referencing this msg
    ACK_FOUND=""
    if [ "$agent" != "boss" ]; then
      ACK_FOUND=$(jq -c --arg id "$MSG_ID" --arg ts "$MSG_TS" \
        'select(.event=="telegram_sent" and .timestamp > $ts and (.metadata.preview // "" | test("relay|received|got it"; "i")))' \
        "$events" 2>/dev/null | head -1)
    fi

    if [ -n "$RELAY_FOUND" ] || [ -n "$ACK_FOUND" ]; then
      continue  # legitimate
    fi

    if [ "$AGE_MIN" -lt 10 ]; then
      continue  # still in grace window
    elif [ "$AGE_MIN" -lt 30 ]; then
      echo "RELAY_MISS_PING agent=$agent msg=$MSG_ID age_min=$AGE_MIN ts=$MSG_TS"
      # ping the receiving agent
      cortextos bus send-message "$agent" normal "v1.2 watch: Saurav-direct msg $MSG_ID at $MSG_TS contains fleet-wide keywords but no fleet_context_relay/propagated event observed in $AGE_MIN min. Confirm receipt and relay/propagate, or log fleet_context_propagated with scope:targeted + reason if not fleet-wide."
    else
      echo "RELAY_MISS_PAGE agent=$agent msg=$MSG_ID age_min=$AGE_MIN ts=$MSG_TS"
      # page boss to investigate
      cortextos bus send-message boss high "v1.2 watch escalation: agent=$agent msg=$MSG_ID at $MSG_TS — relay missing for $AGE_MIN min. Investigate."
    fi
  done
done
```

Notes:
- 10-min grace window — Saurav-direct messages get a soft ping at 10 min if unrelayed; boss page at 30 min.
- ACK-includes-relay shortcut only applies to non-boss agents (boss must always log fleet_context_propagated).
- Targeted-not-fleet-wide path: a `fleet_context_propagated` event with `scope:targeted` and a `reason` field counts as resolution.

## Step 3e: Disk-usage check (added 2026-05-07 after boss outage 00:00–01:49 UTC)

Hook-crash-alert.ts is the live alarm; this is preventive forewarning before disk fills.

```bash
DF=$(df -k /System/Volumes/Data 2>/dev/null | tail -1)
USED_PCT=$(echo "$DF" | awk '{print $5}' | tr -d '%')
AVAIL_KB=$(echo "$DF" | awk '{print $4}')
AVAIL_GB=$((AVAIL_KB / 1024 / 1024))

if [ "$USED_PCT" -ge 95 ]; then
  echo "DISK_PAGE used=${USED_PCT}% avail=${AVAIL_GB}Gi"
  cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" "PAGE: system disk at ${USED_PCT}% (${AVAIL_GB}Gi free). Boss outage threshold imminent — was 110-min outage at 100% on 2026-05-07. Free space now."
elif [ "$USED_PCT" -ge 85 ]; then
  echo "DISK_PING used=${USED_PCT}% avail=${AVAIL_GB}Gi"
  cortextos bus send-message boss normal "Disk usage ${USED_PCT}% (${AVAIL_GB}Gi free). Approaching the 100% threshold that took boss offline 2h overnight. Plan disk cleanup before paging Saurav."
fi
```

Page at >=95% used (real risk of a repeat outage). Ping boss at >=85% (early warning during work hours). Today's outage was at 100%/<1Gi free — well past either threshold.

## Step 3b: Check own task queue + stale task detection

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M UTC) / $LOCAL_TIME
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check GOALS.md

Read GOALS.md for any new objectives from the user.
If goals changed since last check, create tasks to address them:

```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME --priority normal
```

## Step 7: Resume work

Pick your highest priority task and work on it.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

## Step 8: Boss-failover check (BL-003 phase 3)

If boss is stale AND a `profile_quota_exhausted` event for boss
appears in the recent event log, you have a bounded authority to
edit `boss/config.json` and issue a soft-restart on boss's behalf
(boss can't run the failover skill if its own session has died).

```bash
# Is boss stale? read-all-heartbeats is the only available CLI;
# filter to boss in jq and compare last_heartbeat to now.
NOW_EPOCH=$(date -u +%s)
BOSS_HB=$(cortextos bus read-all-heartbeats --format json \
  | jq -r --arg agent "$CTX_ORCHESTRATOR_AGENT" \
      '.[] | select(.agent == $agent) | .last_heartbeat // empty')
if [ -z "$BOSS_HB" ]; then
  BOSS_AGE_MINUTES=999  # no heartbeat record at all → treat as stale
else
  BOSS_AGE_MINUTES=$(( (NOW_EPOCH - $(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$BOSS_HB" +%s 2>/dev/null || date -u -d "$BOSS_HB" +%s)) / 60 ))
fi

# Did boss quota-exhaust in the last 5 minutes? cortextOS doesn't
# expose a list-events CLI; read the analytics JSONL directly.
EVENTS_FILE=~/.cortextos/$CTX_INSTANCE_ID/orgs/$CTX_ORG/analytics/events/$CTX_ORCHESTRATOR_AGENT/$(date -u +%F).jsonl
CUTOFF=$(date -u -v-5M +%FT%TZ 2>/dev/null || date -u -d '5 min ago' +%FT%TZ)
RECENT_EXHAUST=0
if [ -f "$EVENTS_FILE" ]; then
  RECENT_EXHAUST=$(jq -c --arg cutoff "$CUTOFF" \
    'select(.event == "profile_quota_exhausted" and .timestamp > $cutoff)' \
    "$EVENTS_FILE" 2>/dev/null | wc -l | tr -d ' ')
fi
```

If `BOSS_AGE_MINUTES > 5` AND `$RECENT_EXHAUST > 0`:

```bash
# Use the same atomic primitive boss would have used on itself
cortextos profile-failover --agent $CTX_ORCHESTRATOR_AGENT --trigger <event_id>
```

On exit 0, log the failover and notify Saurav:
```bash
cortextos bus log-event action analyst_boss_failover info --meta '{"trigger_event_id":"<id>","reason":"boss-quota-exhausted-and-stale"}'
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "🔄 boss failed over to fallback (boss-quota-exhausted, analyst executed). Soft-restart dispatched."
```

On exit non-zero, notify Saurav and stop — your authority is
bounded to this exact condition (see `GUARDRAILS.md`). Outside it,
edits to `boss/config.json` require explicit user approval.

## Step 9: Update long-term memory (if applicable)

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
