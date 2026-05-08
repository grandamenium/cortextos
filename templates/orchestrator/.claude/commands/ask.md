---
description: Park an active /goal and ask one binary or short-answer clarification question through Telegram.
allowed-tools: Bash
argument-hint: <binary or short question>
---

# /ask — park /goal for human clarification

Use this only inside an active `/goal` when the next action depends on a human-only decision.

Run:

```bash
.claude/scripts/goal-ask.sh "$ARGUMENTS"
```

The script writes `.claude/.goal-question.json`, sends the question through `cortextos bus telegram-send`, and marks `.claude/.goal-state.json` as `parked`. When the user answers, incorporate the answer, run:

```bash
.claude/scripts/goal-budget.sh unpark
```

Then resume with `/goal --resume`.
