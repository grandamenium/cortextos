# Anthropic Dynamic Workflow Patterns

Date: 2026-06-29
Source: Anthropic Claude blog, "A harness for every task: dynamic workflows in Claude Code", published 2026-06-02.
URL: https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code

## Bottom line

Anthropic's key claim is that Claude Code can write a task-specific harness on demand. The workflow is not just parallel delegation. It is a JavaScript control program that Claude writes for the current task, then the workflow runtime executes while spawning and coordinating subagents.

The practical architecture lesson is simple: when a task becomes long-running, adversarial, broad, or highly structured, move the plan out of the main conversation and into a script-owned loop. Keep the conversation for operator intent and final reporting. Let the workflow own phases, branching, fan-out, synthesis barriers, verifier roles, state, and stop conditions.

## Why the article matters for this skill

This skill already frames workflows as agentic loops: trigger, goal, state, planner, worker, verifier, stop rule, artifact ledger, and optimizer. Anthropic's article gives that frame an official Claude Code vocabulary:

- workflows dynamically create custom harnesses for complex work
- intermediate results live outside the main chat context
- subagents get separate context windows and focused objectives
- best uses are high-value tasks where token cost is justified
- pattern choice should be explicit in the prompt

The official pattern names are useful because they give users a concise language for asking Claude to build a better harness.

## Failure modes workflows are meant to reduce

Anthropic highlights three failure modes that get worse in one long context window:

- Agentic laziness: the agent stops early after partial completion.
- Self-preferential bias: the agent prefers its own answer when judging or verifying it.
- Goal drift: constraints and edge cases fade across long runs and compaction.

Workflow design response:

- Use separate agents for maker and checker work.
- Store the original objective, rubric, and disallowed behavior in the workflow state.
- Put pass/fail criteria into verifier prompts and schemas.
- Make the reducer preserve uncertainty instead of smoothing it away.
- Add a stop rule that proves completion, not just effort.

## The six canonical patterns

### 1. Classify-and-act

Use a classifier agent to determine the input class, work type, severity, owner, or output category, then route to different behavior based on that classification.

Use when:

- a backlog contains mixed item types
- each class needs a different worker prompt or tool policy
- model routing matters by complexity
- the final output needs categorization

Workflow shape:

```text
inputs -> classifier -> route table -> specialized worker -> class-aware verifier -> summary
```

Spec notes:

- Require classifier confidence and rationale.
- Add an `unknown` or `needs_human` class.
- Do not let low-confidence classifications trigger high-impact actions.
- Store class counts so future runs can detect distribution shifts.

### 2. Fan-out-and-synthesize

Split a large task into independent units, run one or more agents per unit, then wait at a synthesis barrier before producing the final result.

Use when:

- the work has many files, sources, tickets, feeds, resumes, modules, or incidents
- each shard benefits from its own clean context window
- the final answer needs broad coverage
- parallelism is valuable but final consistency matters

Workflow shape:

```text
input list -> shard planner -> parallel workers -> synthesis barrier -> reducer -> verifier
```

Spec notes:

- Define the sharding rule before dispatch.
- Require structured worker outputs.
- Deduplicate in the reducer.
- Make the reducer cite which worker outputs support each conclusion.
- Track missing shards and failed workers as first-class status.

### 3. Adversarial verification

For each producer or claim, spawn a separate verifier that tries to disprove, falsify, or stress-test the output against a rubric.

Use when:

- the output will be public, high stakes, or operationally risky
- the model might over-trust its own result
- source quality matters
- edge cases or regressions are likely

Workflow shape:

```text
maker result -> verifier prompt and rubric -> pass/fail/evidence -> revision or escalation
```

Spec notes:

- Give verifiers authority to fail the run.
- Require evidence, not vibes.
- Use source-quality checks for research.
- Use tests, repro steps, or diff inspection for code.
- Keep maker and verifier context separate where possible.

### 4. Generate-and-filter

Generate many candidates, dedupe them, score or verify them, then keep only the strongest survivors.

Use when:

- ideation quantity helps
- the first answer is unlikely to be the best
- candidates can be scored by a rubric
- false positives are expensive

Workflow shape:

```text
brief -> candidate generators -> normalization -> dedupe -> rubric filter -> survivor set
```

Spec notes:

- Separate novelty, feasibility, evidence, and audience fit scores.
- Keep rejected candidates with rejection reasons for audit.
- Use a threshold plus a max count.
- Add a verifier pass on the final survivors.

### 5. Tournament

Have agents compete on the same task using different approaches, then judge the outputs by pairwise comparison, bracket rounds, or rubric scoring.

Use when:

- the task is qualitative or taste-sensitive
- multiple plausible approaches exist
- comparative judgment is more reliable than absolute scoring
- ranking matters more than full coverage

Workflow shape:

```text
same task -> N competitors -> pairwise judges -> bracket or ranked list -> final arbiter
```

Spec notes:

- Vary prompts, models, or constraints across competitors.
- Blind judges to author identity where possible.
- Preserve judge reasoning and losing alternatives.
- Use tournament sparingly because it can multiply cost quickly.

### 6. Loop until done

Repeat passes until a stop condition is satisfied instead of assuming a fixed number of rounds is enough.

Use when:

- the amount of work is unknown
- failures may reveal more work
- logs or tests must be driven to real zero
- research continues until no new material appears
- migration quality depends on repeated discovery and repair

Workflow shape:

```text
state -> pass planner -> workers -> verification -> progress check -> continue or stop
```

Spec notes:

- Define `done`, `no_progress`, `max_iterations`, `budget_exceeded`, and `human_handoff`.
- Track new findings per iteration.
- Stop on repeated no-progress, not just success.
- Save per-iteration artifacts so the loop can be audited.

## Use-case translations from the article

Migrations and refactors:

- Primary pattern: fan-out-and-synthesize.
- Add adversarial verification for each shard.
- Use worktrees when workers edit concurrently.
- Stop when tests and verifier checks pass or a blocker is explicit.

Deep research:

- Primary pattern: fan-out-and-synthesize.
- Add adversarial verification for claims and sources.
- Use generate-and-filter for candidate angles or findings.
- Preserve citations and source quality labels.

Deep verification:

- Primary pattern: adversarial verification.
- Use classify-and-act to split claim types.
- Use one checker per claim or risk class.
- Require source, test, or file evidence for each verdict.

Sorting and ranking:

- Primary pattern: tournament.
- Use pairwise comparisons or bucket ranking instead of one giant absolute ranking.
- Keep bracket records so ranking can be explained.

Memory and rule adherence:

- Primary pattern: classify-and-act or adversarial verification.
- Mine corrections, cluster them, test whether candidate rules would have prevented real failures, then promote survivors into instructions.
- Use a skeptic agent to avoid overfitting rules.

Root-cause investigation:

- Primary pattern: tournament or fan-out-and-synthesize.
- Generate independent hypotheses from disjoint evidence.
- Assign refuters to each hypothesis.
- Stop when one theory survives evidence or when unresolved uncertainty is explicit.

Triaging at scale:

- Primary pattern: classify-and-act.
- Add quarantine for untrusted public content.
- Pair with a recurring trigger only when idempotency, state, and approval boundaries are clear.

Exploration and taste:

- Primary pattern: generate-and-filter or tournament.
- Give reviewers an explicit rubric.
- Stop when a review agent confirms criteria are met or when the top set is stable.

Evals:

- Primary pattern: tournament or adversarial verification.
- Run competitors or variants on the same eval set.
- Compare outputs and promote only changes that improve measured results.

Model and intelligence routing:

- Primary pattern: classify-and-act.
- Classify complexity and tool breadth before choosing model or effort level.
- Store routing decisions so later runs can improve the classifier.

## Prompt nudges

Use pattern names in the user prompt when you want Claude to produce a sharper workflow harness:

```text
Use a fan-out-and-synthesize workflow. Shard by package, require each worker to return findings as JSON, then synthesize with citations and unresolved gaps.
```

```text
Use adversarial verification. One agent should produce the migration plan, separate agents should try to break it against tests, edge cases, and API contracts.
```

```text
Use loop until done. Keep spawning repair and verifier passes until the log has no matching errors, max_iterations is reached, or no progress is made for two consecutive passes.
```

```text
Use a tournament. Spawn five naming agents with different constraints, then run pairwise judging and return the top three with reasons.
```

## Cost and fit guidance

Dynamic workflows can use substantially more tokens than a single conversation. The article's practical rule is to use them for complex, high-value tasks, not routine work.

Use a workflow when:

- orchestration complexity is the main problem
- the work is broad, adversarial, structured, or repeatable
- the result needs cross-checking or an audit trail
- state and intermediate results would otherwise overload the chat

Avoid a workflow when:

- one bounded subagent is enough
- a skill or checklist would solve the problem
- the task needs continuous human input in the middle
- the budget cannot support parallel agents
- the process has no clear stop condition

## Operating-layer implications

Claude Code workflows run the bounded loop. An optional operating layer can supervise the loop from outside Claude Code when the job must be scheduled, visible, persistent, or routed across a fleet.

Use the operating layer only for needs such as:

- recurring schedules
- dashboard-visible task state
- agent-to-agent routing
- approvals and human blockers
- durable memory and restart recovery
- cross-run metrics

Do not make the operating layer a default requirement. For most Claude Code users, a saved dynamic workflow plus artifacts is enough.

## Checklist for integrating this article into a workflow spec

Before launching a workflow, answer:

1. Which of the six patterns is primary?
2. What evidence proves this task needs a workflow instead of a skill or one subagent?
3. What input schema enters through `args`?
4. What state is tracked across phases?
5. Which agents are makers, checkers, judges, classifiers, or reducers?
6. What stop condition ends the run?
7. What artifacts prove coverage, verification, and uncertainty?
8. What budget cap or small-slice mode prevents runaway cost?
9. What human approval boundary is outside the workflow?
10. What metric improves on the next run?
