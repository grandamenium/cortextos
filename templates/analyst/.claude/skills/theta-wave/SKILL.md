---
name: theta-wave
description: "System-level deep improvement cycle. You scan the entire system, evaluate all experiments, do external research, have a real conversation with the orchestrator, and manage agent research cycles. Theta wave is itself an autoresearch cycle with a compound qualitative metric."
triggers: ["theta wave", "system scan", "deep analysis", "meta research", "improve system"]
---

# Theta Wave

Theta wave is the system's sleep cycle - a deep analysis and improvement process that you (the analyst) own. It is itself an autoresearch cycle: you hypothesize about system-level improvements, experiment by changing agent cycles or configurations, measure the compound effect, and iterate.

## Your Compound Metric

Your metric is **system_effectiveness** - a qualitative compound score from 1-10 that you assign each cycle. It reflects:
- Progress toward the north star (from org goals)
- System health trends (errors, crashes, staleness)
- Agent experiment outcomes (keep rates, improvement trajectories)
- Overall system usefulness and efficiency

You MUST write a paragraph justifying your score each cycle. Historical scores show the system's trajectory.

## The Theta Wave Cycle

When your theta-wave cron fires:

### Phase 1: Initiate
**First action**: Message the orchestrator that theta wave is starting.
```bash
cortextos bus send-message <orchestrator> high "Theta wave initiated. Running deep system scan. Stand by for findings."
```

### Phase 2: Deep System Scan
Scan EVERYTHING:
- All agent heartbeats: `cortextos bus read-all-heartbeats`
- All agent tasks: `cortextos bus list-tasks`
- All experiment results: `cortextos bus list-experiments --json`
- Per-agent experiment context: `cortextos bus gather-context --agent <name> --format json` (for each agent)
- Org goals and north star: read GOALS.md
- Agent memories: read each agent's MEMORY.md and recent daily memory
- Analytics reports if available
- Event logs for patterns

### Phase 3: Evaluate Previous Theta Wave Experiment
If you have an active theta wave experiment:
- Score the system 1-10 on the compound metric
- Write detailed justification
- Compare to previous score
- Decide keep or discard for any system-level changes you made
- Log via evaluate-experiment.sh

### Phase 4: Evaluate Agent Research Cycles
For each agent with active experiments:
- Review their latest results (gather-context.sh output)
- Calculate keep rate and improvement trajectory
- Identify:
  - **Stale cycles**: no experiments in 3+ days
  - **Converged cycles**: last 5 experiments all discarded (plateau reached)
  - **Successful patterns**: 3+ consecutive keeps
  - **Underperforming agents**: low keep rate, no improvement

### Phase 5: External Research
Based on the north star and current bottleneck:
- Search for tools, methodologies, best practices relevant to the system's goals
- Research improvements to agent workflows or system architecture
- Look for new measurement methods or surfaces to experiment on
- Gather evidence for your hypotheses

### Phase 6: Conversation with Orchestrator
This is a REAL conversation. Not templated. Not scripted.

Send your findings to the orchestrator via send-message.sh. Share:
- System scan highlights (what is working, what is concerning)
- Agent experiment evaluations (who is improving, who is stuck)
- Research findings (new ideas, tools, approaches)
- Your hypotheses for improvement

Then LISTEN to the orchestrator's response. They will:
- Challenge your assumptions
- Raise priority concerns
- Ask for evidence
- Push back on proposals
- Bring goal alignment perspective

Guidelines for the conversation:
- Push each other. Do not agree just to agree.
- Ask "why?" and "how do you know?" when claims are made
- Pause to do more research if needed (it is okay to say "let me check that")
- Propose specific, actionable changes - not vague suggestions
- Reference actual data (experiment results, metrics, events)
- Continue until you both agree on recommended actions
- If you disagree, document the disagreement and present both views to the user

### Phase 7: Hypothesis and Action
Based on the conversation, decide what to change:

**Create new cycles for agents:**
```bash
cortextos bus manage-cycle create <agent> \
  --cycle <cycle_name> \
  --metric <metric_name> \
  --metric-type <quantitative|qualitative> \
  --surface <path_to_surface_file> \
  --direction <higher|lower> \
  --window <measurement_window> \
  --measurement "<how_to_measure>" \
  --loop-interval <cron_frequency>
```
Then send the agent a message to set up the corresponding cron:
```bash
cortextos bus send-message <agent> normal "New autoresearch cycle created: <cycle_name> optimizing <metric_name>. Register the cron: cortextos bus add-cron \$CTX_AGENT_NAME experiment-<metric> <loop_interval> \"Read .claude/skills/autoresearch/SKILL.md and execute the experiment loop.\""
```

**Modify existing cycles:**
```bash
cortextos bus manage-cycle modify <agent> --cycle <name> \
  --window <new_window> \
  --loop-interval <new_loop_interval> \
  --surface <new_surface> \
  --measurement "<new_method>" \
  --metric-type <quantitative|qualitative> \
  --enabled <true|false>
```
Use `--enabled false` to pause a stale or converged cycle instead of removing it entirely — pausing preserves the cycle history.

**Remove converged or irrelevant cycles:**
```bash
cortextos bus manage-cycle remove <agent> --cycle <name>
```

If `auto_create_agent_cycles` or `auto_modify_agent_cycles` is false, create approvals instead of executing directly.

### Phase 8: Score, Log, and Report
- Assign your compound 1-10 score for this cycle
- Write justification paragraph
- Create your own experiment entry and evaluate it
- Send comprehensive report to user via Telegram:
  - What the system scan found
  - Agent experiment summaries
  - Research findings
  - Actions taken or proposed
  - Your system effectiveness score and justification

## Your Unique Powers
- You can CREATE research cycles for any agent
- You can MODIFY surfaces, metrics, windows, or methodology of any agent's cycle
- You can REMOVE cycles that have converged or are no longer useful
- You can MODIFY your own theta wave parameters
- You can PROPOSE structural changes to the system
- All changes are logged and user is notified (or approval-gated based on config)

## Important Rules
1. Always message the orchestrator first when theta wave starts
2. The conversation must be real and substantive - push each other
3. Score justifications must reference specific data
4. Log EVERYTHING to learnings.md - both what worked and what failed
5. Never repeat a system-level change that was already discarded
6. External research must be relevant to current goals, not generic
