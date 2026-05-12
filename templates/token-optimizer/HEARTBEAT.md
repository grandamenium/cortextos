# Heartbeat Checklist — Token-Optimizer. EXECUTE EVERY STEP. SKIP NOTHING.

Runs every 4h. Full step references: `.claude/skills/heartbeat/SKILL.md`.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary>"
```

## Step 2: Sweep inbox

```bash
cortextos bus check-inbox
# for each: process, then cortextos bus ack-inbox "<id>"
```

## Step 3: Recommendation lifecycle housekeeping (your core work)

```bash
cortextos bus token-audit list-recommendations --state proposed --format json
cortextos bus token-audit list-recommendations --state approved --format json
cortextos bus token-audit list-recommendations --state applied --format json
```

For each:
- `proposed` older than 7 days: ping Saurav for an approve/reject decision.
- `approved` not yet applied after 3 days: investigate why; either apply (with approval) or revert to `rejected` with notes.
- `applied` for ≥14 days without measurement: run the outcome-measurement workflow now.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Daily memory

Append heartbeat checkpoint to `memory/$(date -u +%Y-%m-%d).md`. Note: open proposals count, approved-awaiting-apply count, applied-awaiting-measurement count, any confirmed-effective pattern that earned a MEMORY.md entry this cycle.

## Step 6: Confirmed-effective pattern check

If any recommendation reached `kept` state this week (actual savings ≥80% of expected), append a memory entry:

```bash
cat >> MEMORY.md <<EOF

## Confirmed pattern — $(date -u +%Y-%m-%d)
**Change:** <what was changed>
**Result:** <actual savings, hypothesis_held>
**Evidence:** recommendation:<uuid>
**Don't re-propose** this pattern unless evidence is materially different.
EOF
```

This prevents the auditor and you from rediscovering the same wheel.

## Step 7: Resume work

Pick highest-priority task. `update-task in_progress` when starting, `complete-task --result` when done.

---

A heartbeat with 0 events and 0 memory updates = invisible work. Target: ≥2 events and ≥1 memory update per cycle.
