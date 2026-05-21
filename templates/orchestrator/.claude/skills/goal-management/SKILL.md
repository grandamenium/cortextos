---
name: goal-management
description: "Daily goal lifecycle management. Use for: morning briefing goal cascade, setting daily focus, refreshing agent goals, reviewing goal progress. Triggered daily as part of morning review."
triggers: ["goals", "daily focus", "priorities", "what should we work on", "goal cascade", "set goals", "update goals", "goal management", "north star"]
---

# Goal Management

The orchestrator owns the daily goal lifecycle. Goals flow from the user's daily focus down to agent-specific objectives and tasks.

## Hierarchy

```
North Star (org-level, rarely changes — set by user)
  → Daily Focus (what the user wants done TODAY — set each morning)
    → Agent goals.json (orchestrator writes role-specific goals for each agent)
      → GOALS.md (auto-generated from goals.json — agents read this on boot)
        → Tasks (agents create from their goals)
```

## Morning Goal Cascade

Run this every morning as part of briefing:

### 1. Read current org goals

```bash
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

### 2. Consult the user

Ask via Telegram:
> "Good morning. Our north star is: [north_star from goals.json]. What's the focus for today?"

Wait for their response. They may give specific directives or say "continue yesterday's work."

### 3. Update org goals.json with today's focus

```bash
jq --arg focus "the user's stated focus" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.daily_focus = $focus | .daily_focus_set_at = $ts' \
    $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json > /tmp/goals.tmp \
  && mv /tmp/goals.tmp $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

### 4. Set each agent's goals

For each active agent, based on their role and today's daily focus:

1. Determine 2-5 role-appropriate goals
2. Write their `goals.json`:
   ```bash
   cat > $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<agent>/goals.json << 'EOF'
   {
     "focus": "role-specific focus derived from daily_focus",
     "goals": [
       "goal 1",
       "goal 2",
       "goal 3"
     ],
     "bottleneck": "",
     "updated_at": "ISO_TIMESTAMP",
     "updated_by": "$CTX_AGENT_NAME"
   }
   EOF
   ```
3. Regenerate GOALS.md from goals.json:
   ```bash
   cortextos goals generate-md --agent <agent> --org $CTX_ORG
   ```
4. Message the agent:
   ```bash
   cortextos bus send-message <agent> normal "New goals for today. Check GOALS.md and create tasks."
   ```

**If an agent's goals.json already has `daily_focus_set_at` matching today: skip — don't overwrite.**

### 5. Set your own goals

Write your orchestrator-level goals.json for today:
```bash
cat > $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/goals.json << 'EOF'
{
  "focus": "orchestrate today's work, cascade goals, monitor fleet",
  "goals": ["cascade goals to all agents", "send morning briefing", "monitor progress", "route approvals"],
  "bottleneck": "",
  "updated_at": "ISO_TIMESTAMP",
  "updated_by": "$CTX_AGENT_NAME"
}
EOF
cortextos goals generate-md --agent $CTX_AGENT_NAME --org $CTX_ORG
```

### 6. Confirm task plans

After each agent creates tasks from their new goals, review for:
- Overlap (two agents doing the same thing)
- Missing coverage (daily focus items nobody picked up)
- Misaligned tasks (work unrelated to today's focus)

## New Agent Bootstrap

When a new agent comes online with an empty `goals.json`, they will message you requesting goals.

Handle by:
1. Checking their role from `IDENTITY.md`
2. Writing their `goals.json` with appropriate starter goals
3. Running `cortextos goals generate-md --agent <name> --org $CTX_ORG`
4. Replying with confirmation

## Evening Goal Update

At end of day:
1. Check each agent's task completion against their goals
2. Note what was achieved vs planned
3. Update each agent's `goals.json` bottleneck field if new blockers emerged:
   ```bash
   jq --arg b "what's blocking them" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '.bottleneck = $b | .updated_at = $ts | .updated_by = "'$CTX_AGENT_NAME'"' \
       $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<agent>/goals.json > /tmp/agent-goals.tmp \
     && mv /tmp/agent-goals.tmp $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<agent>/goals.json
   cortextos goals generate-md --agent <agent> --org $CTX_ORG
   ```
4. Carry forward unfinished goals to tomorrow's morning discussion

## North Star

The north star lives in `orgs/<org>/goals.json`. It is set by the user, rarely changes. The orchestrator references it when setting daily focus to ensure alignment.

If the daily focus drifts from the north star, flag it:
> "Today's focus on [X] is different from our north star of [Y]. Is this intentional?"


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
