---
name: weekly-review
description: "Weekly comprehensive synthesis. Run Sunday evening or when user requests. Reviews week's accomplishments across all agents, evaluates performance, plans next week."
triggers: ["weekly review", "weekly check-in", "end of week", "week summary", "run weekly review", "weekly briefing"]
---

# Weekly Review

> Comprehensive weekly check-in covering all agents' output, goals progress, orchestrator self-evaluation, and next-week planning.

**When:** Sunday evening (configured in cron) or when user requests.
**Duration:** ~15-30 minutes including user interaction.
**Output:** Memory log, actionable insights, next week plan.

---

## Phase 1: Data Aggregation

```bash
# All agent heartbeats
cortextos bus read-all-heartbeats

# All tasks this week
cortextos bus list-tasks
cortextos bus list-tasks --status completed

# This week's memory files (last 7 days)
for i in 0 1 2 3 4 5 6; do
  DATE=$(date -v-${i}d +%Y-%m-%d 2>/dev/null || date -d "$i days ago" +%Y-%m-%d)
  echo "=== $DATE ==="
  cat memory/${DATE}.md 2>/dev/null || echo "(no entry)"
done

# Goals and priorities
cat GOALS.md
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json

# Inbox
cortextos bus check-inbox
```

---

## Phase 2: Present Review to User

Format into a comprehensive review and send as chunked Telegram messages:

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<message chunk>"
```

### Review Template

```markdown
# Weekly Review - Week of [DATE]

---

## AGENT PERFORMANCE

| Agent | Status | Tasks Completed | Key Wins | Issues |
|-------|--------|----------------|----------|--------|
| [agent] | [heartbeat age] | X | [wins] | [gaps] |

Fleet Health:
- Agents online: X/N
- Agents stale (>5h): [list]
- Coordination events this week: X

---

## PRODUCTIVITY

Tasks this week (all agents combined):
- Completed: X
- In progress: Y
- Blocked: Z

Overnight work:
- Tasks dispatched: X
- Tasks completed: X

---

## GOALS PROGRESS

| Goal | Progress | Status |
|------|----------|--------|
| [north star goal] | [qualitative progress] | [on track / behind / blocked] |

---

## ORCHESTRATOR SELF-EVALUATION

| Dimension | Score (1-10) | Notes |
|-----------|-------------|-------|
| Usefulness | X | [why] |
| Proactivity | X | [why] |
| Coordination | X | [why] |
| Communication | X | [why] |
| Learning | X | [why] |
| **Total** | X/50 | |

What went well: [bullets]
What to improve: [bullets]
Key learnings: [bullets]

---

## SYSTEM IMPROVEMENT PROPOSALS

Based on this week's patterns:

[P1] [Category]: [Name]
- Problem observed: [specific pattern]
- Proposed solution: [concrete action]
- Assign to: [agent]
- Expected impact: [what changes]

[P2] ...

Agent gaps (capabilities needed):
- Missing: [capability]
- Proposed: [new skill or new agent]

---

## NEXT WEEK

Top priorities:
1. [priority]
2. [priority]
3. [priority]

Agent focus next week:
- [agent]: [priority work]

System improvements queued:
- [improvement 1]
- [improvement 2]
```

---

## Phase 3: Interactive Discussion

After sending the review, ask the user:
1. What went well this week in your view?
2. What was challenging or frustrating?
3. Any changes to priorities for next week?
4. Any new agents or capabilities needed?

---

## Phase 4: Update State

```bash
# Log event
cortextos bus log-event action briefing_sent info --meta '{"type":"weekly_review"}'

# Update heartbeat
cortextos bus update-heartbeat "weekly review complete - next week planned"

# Write to memory
TODAY=$(date -u +%Y-%m-%d)
cat >> "memory/$TODAY.md" << MEMEOF

## Weekly Review - $(date -u +%H:%M:%S)

### Summary
- Total tasks completed this week: X (all agents)
- Agents active: X/N
- Self-eval total: X/50
- Top priorities next week: [list]

### Key Insights
- [insight 1]
- [insight 2]

### System Improvements Queued
- [improvement 1]
MEMEOF

# Update MEMORY.md with persistent learnings
# Add any new patterns, preferences, or system behaviors discovered this week
```

---

## Custom Metrics

<!-- Added during onboarding — user-specific tracking preferences -->
<!-- Format: add bullet points below, each with the metric name and how to measure it -->

<!-- Example:
- **Platform MRR**: screenshot from your SaaS platform settings, extract MRR number
- **GitHub PRs merged this week**: gh pr list --state merged --json mergedAt | count those in last 7 days
- **Content pieces published**: count from alex agent completed tasks tagged content
-->

---

## Manual Trigger

```
"Run weekly review" → read .claude/skills/weekly-review/SKILL.md and execute
```

---

*This is the single source of truth for weekly review.*


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
