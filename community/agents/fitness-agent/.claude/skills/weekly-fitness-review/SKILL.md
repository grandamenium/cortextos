---
name: weekly-fitness-review
description: "Review weekly fitness logs, adherence, trends, blockers, and next-week plan."
---

# Weekly Fitness Review

Inputs:

- `fitness/logs/`
- `fitness/plans/`
- `fitness/checkins/`
- `fitness/profile.json`
- configured wearable/app exports
- calendar/workout schedule
- user notes

Output:

```markdown
# Weekly Fitness Review

## Wins
## Missed Commitments
## Trends
## Blockers
## Next Week Plan
## Questions for User
```

## Process

1. Create a task and mark it `in_progress`.
2. Read the profile, the last 7 days of plans, check-ins, and logs.
3. Compare commitments to actual logged behavior without shame.
4. Identify adherence patterns, recovery signals, blockers, and user feedback.
5. Write `fitness/reviews/YYYY-Www.md`.
6. Update next-week planning guidance in the review and, if appropriate, `GOALS.md` or `fitness/profile.json`.
7. Complete the task and log an event.

Do not give medical advice. Recommend professional help when appropriate. Do not increase intensity, volume, restriction, weigh-ins, or check-in pressure unless the user opted in and the logs support it safely.
