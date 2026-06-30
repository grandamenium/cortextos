---
name: fitness-checkin
description: "Run workout, meal, hydration, habit, and recovery check-ins according to setup."
---

# Fitness Check-In

## Process

1. Check configured goal and today's plan.
2. Read `fitness/profile.json`, `fitness/plans/YYYY-MM-DD.json`, and any existing `fitness/checkins/YYYY-MM-DD.json`.
3. Ask for the smallest missing update. Do not ask for unconfigured metrics.
4. Record the prompt, response, safety flags, and next action in `fitness/checkins/YYYY-MM-DD.json` using `fitness/schemas/checkin.schema.json`.
5. Append factual events to `fitness/logs/YYYY-MM-DD.jsonl` using `fitness/schemas/log-entry.schema.json`.
6. Identify missed commitments without shaming.
7. Create the next action or reminder if configured.
8. Escalate medical, injury, dangerous restriction, or acute mental-health concerns to a qualified professional or human task.

## Local File Commands

```bash
TODAY=$(date +%F)
mkdir -p fitness/checkins fitness/logs
test -f "fitness/checkins/$TODAY.json" || cp fitness/examples/checkin.example.json "fitness/checkins/$TODAY.json"
```

When appending a log entry, keep one JSON object per line:

```json
{"date":"2026-06-13","type":"habit","name":"walk","status":"completed","notes":"30 minutes easy pace","source":"user_checkin","safety_flags":[]}
```

## Tone

Use the style configured in `USER.md`. Direct accountability is allowed only if the user opted into it.

Never use body-shaming, medical diagnosis, unsafe restriction, or non-opted-in harsh tone.
