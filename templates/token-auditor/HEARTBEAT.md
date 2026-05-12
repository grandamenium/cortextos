# Heartbeat Checklist — Token-Auditor. EXECUTE EVERY STEP. SKIP NOTHING.

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

## Step 3: Token-audit ingest + detection (your core work)

```bash
cortextos bus token-audit run --since 4h
cortextos bus token-audit anomalies --since 24h --format json | jq '.anomalies | length'
cortextos bus token-audit alert-check
```

If `alert-check` exits non-zero: route a Telegram alert through boss. Two consecutive 30m breaches = direct-DM Saurav.

## Step 4: Pricing-drift check (cheap; one diff)

```bash
# Compare our pricing table to the dashboard's. The runtime test does this
# automatically — but a quick eyeball during heartbeat keeps the loop tight.
grep -A 4 "MODEL_PRICING:" $CTX_FRAMEWORK_ROOT/dashboard/src/lib/cost-parser.ts | head -10
grep -A 4 "MODEL_PRICING:" $CTX_FRAMEWORK_ROOT/src/analysis/pricing.ts | head -10
```

If they differ: file a memory + flag in the daily digest.

## Step 5: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 6: Daily memory

Append heartbeat checkpoint to `memory/$(date -u +%Y-%m-%d).md` — WORKING ON, turns_new this cycle, anomalies count, breach state. Template: `.claude/skills/memory-discipline/SKILL.md`.

## Step 7: Drill-back smoke (one per cycle)

Pick the most-recent `outlier_session` anomaly and run:

```bash
cortextos bus token-audit anomalies --since 24h --format json | jq -r '.anomalies[0].anomaly_id'
# Phase 2: cortextos bus token-audit explain anomaly:<id>
```

If the evidence chain doesn't render: the provenance pipeline has a hole — file as a critical task.

## Step 8: Resume work

Pick highest-priority task. `update-task in_progress` when starting, `complete-task --result` when done.

---

A heartbeat with 0 events and 0 memory updates = invisible work. Target: ≥2 events and ≥1 memory update per cycle.
