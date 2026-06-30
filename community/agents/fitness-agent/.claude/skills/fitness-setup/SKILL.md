---
name: fitness-setup
description: "Interactive setup for a tool-agnostic fitness/accountability agent. Run on first boot or when the user says /setup."
triggers: ["/setup", "fitness setup", "configure fitness", "set up fitness agent", "run setup"]
---

# Fitness Agent Setup

Run this on first boot or when the user says `/setup`.

## Safety First

This template is not a doctor, therapist, registered dietitian, or emergency service. It supports planning, logging, reminders, and accountability. Medical, injury, eating-disorder, medication, pregnancy, or acute mental-health issues must be routed to a qualified professional.

Hard boundaries:

- no medical diagnosis or treatment
- no unsafe calorie, water, medication, supplement, or training restriction
- no body-shaming, moralizing, or body policing
- no eating-disorder coaching or compensatory exercise
- no harsh, profanity-heavy, or high-pressure tone unless explicitly opted in
- stop and route to professional help for acute injury, chest pain, fainting, severe shortness of breath, suicidal ideation, or dangerous restriction

## Setup Principles

- Ask in small batches and wait for the user when answers are required.
- Never ask for secrets in chat.
- Configure tone explicitly. Some users want direct accountability; some need gentle coaching.
- Use local files first. External tools are optional and approval/human-task gated.
- Track facts and patterns, not worth, morality, or appearance.

## Discovery

Run lightweight discovery and summarize what is available:

```bash
for cmd in jq python3 sqlite3 gog agent-browser; do
  command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"
done
test -f .mcp.json && cat .mcp.json
env | grep -E 'GOOGLE|CALENDAR|FITBIT|OURA|GARMIN|WHOOP|APPLE|HEALTH|NOTION|SHEETS|OPENAI|GEMINI' | sed 's/=.*/=<configured>/'
```

## Question Batches

Ask these in batches. Stop after each batch if you need the user's answer before continuing.

### Goals and Constraints

1. What outcomes do you want this agent to support?
2. What is your current baseline: training days, movement, sleep, recovery, and available time?
3. What injuries, medical constraints, professional guidance, equipment limits, or accessibility needs should I respect?
4. What topics should I never comment on or pressure, including weight, food, appearance, intensity, or streaks?

### Tracking

1. What should be tracked: workouts, steps, sleep, weight, meals, water, habits, mood, recovery, pain, energy?
2. Which tools or apps hold the data?
3. Should local files be the source of truth, or should the agent read external tools when configured?
4. What metrics are off-limits?

### Coaching Style

1. Preferred style: gentle, direct, analytical, celebratory, minimalist, or custom?
2. Are profanity, competitive framing, or blunt accountability allowed?
3. How often should nudges happen?
4. What silence or missed-check-in pattern should trigger a follow-up?

### Schedule and Reviews

Configure:

- morning plan time
- evening check-in/review time
- weekly review day/time
- quiet hours
- optional workout, meal, water, medication, or recovery reminders

## Initialize Files

Create the runtime workspace:

```bash
mkdir -p fitness/profile fitness/plans fitness/checkins fitness/logs fitness/reviews fitness/schemas fitness/examples memory tmp
```

Write or update `fitness/profile.json` using `fitness/schemas/profile.schema.json`. Use this shape:

```json
{
  "setup_status": "complete",
  "user": {
    "display_name": "",
    "timezone": "",
    "privacy": "local_files_default"
  },
  "goals": [
    {
      "id": "primary",
      "description": "",
      "why_it_matters": "",
      "time_horizon": "12_weeks",
      "success_markers": []
    }
  ],
  "baseline": {
    "training_days_per_week": null,
    "movement": "",
    "sleep": "",
    "recovery": "",
    "available_equipment": [],
    "available_time": ""
  },
  "constraints": {
    "injuries_or_medical": [],
    "professional_guidance": [],
    "accessibility_needs": [],
    "off_limits_topics": []
  },
  "tracking": {
    "source_of_truth": "local_files",
    "metrics": ["workouts", "habits", "recovery"],
    "external_tools": []
  },
  "coaching": {
    "tone": "gentle",
    "direct_accountability_opt_in": false,
    "profanity_opt_in": false,
    "intensity_escalation_opt_in": false
  },
  "schedule": {
    "morning_plan": "07:00",
    "evening_review": "20:00",
    "weekly_review": "Sunday 09:00",
    "quiet_hours": ""
  },
  "safety": {
    "no_medical_diagnosis": true,
    "no_unsafe_restriction": true,
    "no_body_shaming": true,
    "route_to_professional_when_needed": true
  }
}
```

Create starter artifacts:

```bash
TODAY=$(date +%F)
WEEK=$(date +%G-W%V)
cp fitness/examples/daily-plan.example.json "fitness/plans/$TODAY.json"
cp fitness/examples/checkin.example.json "fitness/checkins/$TODAY.json"
cp fitness/examples/weekly-review.example.md "fitness/reviews/$WEEK.md"
touch "fitness/logs/$TODAY.jsonl"
```

Update goals and memory:

```bash
cat > goals.json <<'JSON'
{
  "focus": "Sustainable fitness planning and accountability",
  "goals": [
    "Maintain a user-approved profile and safety boundaries",
    "Create daily plans from the user's goals and constraints",
    "Run check-ins and keep factual logs",
    "Review weekly patterns and adjust next-week guidance"
  ],
  "bottleneck": "Waiting for first real user check-ins"
}
JSON

cat > GOALS.md <<'EOF'
# Goals

1. Maintain a sustainable, safe, user-approved fitness operating system.
2. Create realistic daily plans from the user's goals, constraints, and recovery.
3. Track configured workouts, habits, recovery, sleep, hydration, nutrition, or mood without shame.
4. Run check-ins and weekly reviews.
5. Adjust plans from observed adherence, recovery, blockers, and user feedback.
EOF

TODAY_UTC=$(date -u +%Y-%m-%d)
mkdir -p memory
cat >> "memory/$TODAY_UTC.md" <<EOF

## Setup - $(date -u +%H:%M:%S UTC)
- Status: setup complete
- Current state: fitness profile, starter daily plan, starter check-in, log file, weekly review template, goals, crons, and safety boundaries initialized.
- Safety: no diagnosis, unsafe restriction, body shaming, or non-opted-in harsh tone.
- Next: run morning plan, evening check-in, and weekly review according to crons.
EOF
```

Create and complete a setup task, then log events:

```bash
TASK_ID=$(cortextos bus create-task "Complete fitness-agent setup" --desc "Initialize profile, plans, check-ins, logs, reviews, goals, memory, crons, safety boundaries, heartbeat, and onboarding flag.")
cortextos bus update-task "$TASK_ID" in_progress
cortextos bus update-heartbeat "WORKING ON: fitness-agent setup"
cortextos bus log-event action setup_started info --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"template\":\"fitness-agent\"}"
```

Confirm persistent crons exist. If missing, add them with the same names and schedules from `config.json` using `cortextos bus add-cron`.

```bash
cortextos bus list-crons "$CTX_AGENT_NAME"
```

Mark setup complete:

```bash
mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
cortextos bus update-heartbeat "online: fitness-agent setup complete"
cortextos bus complete-task "$TASK_ID" --result "Fitness-agent setup initialized profile, plans, check-ins, logs, reviews, goals, memory, crons, safety boundaries, heartbeat, and onboarding flag."
cortextos bus log-event task task_completed info --meta "{\"task_id\":\"$TASK_ID\",\"agent\":\"$CTX_AGENT_NAME\",\"template\":\"fitness-agent\"}"
cortextos bus log-event action setup_completed info --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"template\":\"fitness-agent\"}"
```

## Completion Message

Send a concise summary:

- configured goals and source of truth
- safety boundaries and off-limits topics
- opted-in coaching tone
- scheduled crons
- next check-in or plan time

Do not claim external integrations are connected unless verified.
