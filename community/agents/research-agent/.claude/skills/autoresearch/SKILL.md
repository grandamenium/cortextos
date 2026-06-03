---
name: autoresearch
description: "The analyst has assigned you a research cycle, or you have identified a metric you want to improve through systematic experimentation. You will form a hypothesis, make a targeted change, measure the outcome against a baseline, and decide whether to keep or discard the change. You repeat this loop until the metric improves or you exhaust viable hypotheses. This is not ad-hoc research — it is structured scientific iteration with a defined metric, a hypothesis, and a measurable result."
triggers: ["experiment", "autoresearch", "hypothesis", "research cycle", "optimize", "improve metric", "run experiment", "test hypothesis", "measure improvement", "scientific loop", "iteration cycle", "theta wave research", "baseline measurement", "keep or discard", "research assignment"]
---

# Autoresearch

You are a scientist. Autoresearch is how you systematically improve specific aspects of your work by running experiments, measuring results, and learning from outcomes.

## What It Is

You have research cycles assigned to you (check `experiments/config.json`). Each cycle has:
- A **metric** you are optimizing (the dependent variable)
- A **surface** you are experimenting on (the independent variable - what you change)
- A **direction** (higher or lower = better)
- A **measurement window** (how long to wait before measuring)
- A **measurement method** (how to get the metric value)

You cannot autonomously modify your own cycle configuration. If the user asks you to modify a cycle, you can. Otherwise, the analyst (via theta wave) is the one who creates, modifies, or removes cycles. You CAN and SHOULD run experiments within your assigned cycles.

## The Experiment Loop

When your experiment cron fires, execute these steps:

### Step 1: Gather Context
```bash
cortextos bus gather-context --agent $CTX_AGENT_NAME --format markdown
```
Read the output carefully. Pay attention to:
- What experiments have been tried before
- What was kept (these patterns work - build on them)
- What was discarded (these approaches failed - avoid repeating)
- Your current keep rate and trajectory

### Step 2: Evaluate Previous Experiment
If there is an active experiment (check `experiments/active.json`):
- Compare ALL relevant aspects: the surface changes you made, the context around those changes, and the output metric
- Measure the metric using the configured measurement method
- Run evaluate-experiment:
```bash
cortextos bus evaluate-experiment <experiment_id> <measured_value> --justification "Why this result makes sense"
```
For qualitative metrics, use `--score <1-10>` with a written justification.

### Step 3: Hypothesize
Based on accumulated learnings:
- Review what worked (keeps) and what failed (discards)
- Identify patterns - what themes appear in successful experiments?
- Consider untested approaches
- Form a specific, testable hypothesis
- Your hypothesis must be evidence-backed (cite past results or research)

**Exploit vs Explore:** If something has been kept 3+ times in a row, exploit that pattern further. If you have been discarding 3+ times, try something more radically different.

### Step 4: Create Experiment
```bash
cortextos bus create-experiment "<metric_name>" "<your hypothesis>" --surface <path> --direction <higher|lower> --window <duration>
```
If `approval_required` is true in `experiments/config.json`, you must manually create an approval before proceeding:
```bash
APPR_ID=$(cortextos bus create-approval "Run experiment: <hypothesis>" experiments "Cycle: <cycle_name>, Metric: <metric_name>, Surface: <surface>")
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Approval needed to run experiment for <metric_name> — check dashboard"
# Block until approved, then continue to Step 5
```

### Step 5: Make Changes and Run
Apply your hypothesized changes to the surface file. Then:
```bash
cortextos bus run-experiment <experiment_id> "Description of what you changed"
```
This creates a git commit with your changes (the experiment commit) so they can be cleanly reverted if the experiment fails.

### Step 6: Wait
The cycle ends. Your next cron trigger picks up at Step 1, where you will evaluate this experiment.

## Measurement Methods

### Quantitative (scripted)
A script returns a number. Example: API scrape for engagement rate.
```bash
bash connectors/measure-instagram.sh
# Output: metric_value: 3.2
```

### Quantitative (computed)
You calculate from existing data. Example: task completion rate.
```bash
COMPLETED=$(cortextos bus list-tasks --agent $CTX_AGENT_NAME --status completed | jq length)
TOTAL=$(cortextos bus list-tasks --agent $CTX_AGENT_NAME | jq length)
RATE=$(echo "scale=2; $COMPLETED / $TOTAL * 100" | bc)
```

### Qualitative (subjective)
You evaluate output quality on a 1-10 scale. You MUST write a justification.
```bash
cortextos bus evaluate-experiment <id> 0 --score 7 --justification "Output is more concise and actionable than baseline, but loses some nuance"
```

### Qualitative (comparative)
You compare baseline vs experiment output side by side and score 1-10.

## Setting Up a Cycle

If the user asks you to set up autoresearch, collect these 8 things:
1. **Metric** — what to optimize (e.g., "engagement_rate", "task_completion_rate", "briefing_quality")
2. **Metric type** — quantitative (a number you can script/compute) or qualitative (a 1-10 score you evaluate)
3. **Surface** — the file to experiment on (e.g., `experiments/surfaces/engagement/current.md` for a prompt, or `SOUL.md` for behavior)
4. **Direction** — higher or lower is better
5. **Measurement** — how to get the metric value (a script, computed from tasks, or self-evaluation)
6. **Window** — how long to wait before measuring the result (e.g., `24h`, `48h`)
7. **Loop interval** — how often to run the experiment loop (the cron frequency — often same as window)
8. **Approval** — should you need approval before running each experiment?

Then create the cycle and surface directory:
```bash
# Create surface directory and baseline file
mkdir -p "experiments/surfaces/<metric>"
cat > "experiments/surfaces/<metric>/current.md" << 'EOF'
# <metric> — Baseline

[Describe the current approach being tested]
EOF

# Register the cycle
cortextos bus manage-cycle create $CTX_AGENT_NAME \
  --cycle "<metric_name>" \
  --metric "<metric_name>" \
  --metric-type "<quantitative|qualitative>" \
  --surface "experiments/surfaces/<metric>/current.md" \
  --direction "<higher|lower>" \
  --window "<e.g. 24h>" \
  --measurement "<how to measure>" \
  --loop-interval "<e.g. 48h>"

# Update approval setting in config if needed (default is true)
# Only set to false if user explicitly says no approval needed
```

Then register the persistent cron via the bus (daemon-managed, survives restarts):
```bash
cortextos bus add-cron $CTX_AGENT_NAME experiment-<metric> <loop_interval> "Read .claude/skills/autoresearch/SKILL.md and execute the experiment loop."
```

To modify a cycle when the user asks:
```bash
cortextos bus manage-cycle modify $CTX_AGENT_NAME --cycle "<name>" \
  --window "<new>" \
  --loop-interval "<new>" \
  --enabled <true|false>
```
Use `--enabled false` to pause a cycle without deleting it.

## Important Rules

1. Never autonomously modify your own cycle config. If the user asks you to, you can.
2. You MUST log learnings for EVERY experiment, including failures. Negative learnings are equally valuable.
3. You MUST respect the measurement window - do not evaluate early.
4. If approval_required is true, WAIT for approval before running.
5. Never repeat a hypothesis that was already discarded. Find a new angle.
6. Keep experiments focused - change one thing at a time when possible.
