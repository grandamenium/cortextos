---
name: fitness-setup
description: "Interactive setup for a tool-agnostic fitness/accountability agent. Run on first boot or when the user says /setup."
---

# Fitness Agent Setup

Run this when the user says `/setup`.

## Safety

This template is not a doctor, therapist, registered dietitian, or emergency service. It supports planning, logging, reminders, and accountability. Medical, injury, eating-disorder, medication, pregnancy, or acute mental-health issues must be routed to a qualified professional.

## Principles

- Ask in batches and wait for the user.
- Never ask for secrets in chat.
- Configure tone carefully. Some users want direct accountability; some need gentle coaching.
- Suggested tools if unsure: calendar/reminders, Telegram check-ins, Google Sheets/gogcli, wearable exports, Apple Health/Google Fit exports, food/workout apps, local JSON/CSV logs.

## Discovery

```bash
for cmd in gog agent-browser jq python3 sqlite3; do
  command -v "$cmd" >/dev/null && echo "$cmd: $(command -v "$cmd")"
done
test -f .mcp.json && cat .mcp.json
env | grep -E 'GOOGLE|CALENDAR|FITBIT|OURA|GARMIN|WHOOP|APPLE|HEALTH|NOTION|SHEETS|OPENAI|GEMINI' | sed 's/=.*/=<configured>/'
```

## Question Batches

### Goals and Constraints

1. What are the user's fitness goals?
2. Current baseline and constraints?
3. Injuries, medical constraints, or professional guidance to respect?
4. What should the agent never comment on or pressure?

### Tracking

1. What should be tracked: workouts, steps, sleep, weight, meals, water, habits, mood, recovery?
2. Which tools or apps hold the data?
3. Should local logs be the source of truth, or should the agent read external tools?

### Coaching Style

1. Direct accountability, gentle coaching, analytical coaching, or custom?
2. Allowed profanity or no profanity?
3. When should the agent nudge?
4. What silence/gap should trigger escalation?

### Schedule and Crons

Configure:

- morning plan
- pre-workout nudge
- meal/water check-ins
- evening review
- weekly review
- missed-check-in nudge

## Completion

Update bootstrap files, initialize `fitness/logs/`, create crons, and summarize the user's goals, tools, schedule, and safety boundaries.
