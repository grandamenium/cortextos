# Claude Code Dynamic Workflows as Agentic Loops

Date: 2026-06-29

Scope: synthesize how Claude Code Dynamic Workflows can be used to build complex, auditable, observable, repeatable, and optimizable agentic loops. This document builds on the local research pass in this folder, especially the official feature surface, implementation patterns, use cases, and operational risks.

## Executive Thesis

Claude Code Dynamic Workflows are best understood as a loop primitive, not just a parallel-subagent feature.

The important shift is that orchestration moves from conversation into code. A JavaScript workflow script can hold state, branch, retry, fan out, fan in, run verifier phases, and return structured artifacts. That makes it possible to design agentic work as an explicit cycle:

```text
intake -> plan -> shard -> act -> observe -> verify -> decide -> artifact -> learn -> rerun
```

The value is not simply "many agents." The value is that the loop can be inspected, saved, rerun, measured, and improved. A good workflow is a reusable operating procedure with evidence and telemetry. A weak workflow is a large prompt that happens to spawn more workers.

Optional persistent operating layer angle for users running that operating layer:

```text
Claude Code Dynamic Workflow = high-throughput loop execution
persistent operating layer = durable operating layer around the loop
```

Claude Code can run the loop. persistent operating layer can make the loop visible, governed, scheduled, logged, memory-backed, approval-aware, and recoverable across restarts when the user needs that operating layer.

## Design Principles

### 1. The loop belongs in code

If the process has repeated phases, branching, retries, scoring, or fan-out/fan-in, the workflow script should own that control flow. The main chat should not be the only place where the process is remembered.

Good workflow logic:

- Validates inputs before dispatch.
- Creates explicit phases.
- Shards work deterministically.
- Stores intermediate results in variables.
- Routes failures through labeled paths.
- Runs verification before final output.
- Produces machine-readable artifacts.

Poor workflow logic:

- Uses one giant worker prompt.
- Lets each agent invent its own output shape.
- Reports only prose.
- Treats partial completion as success.
- Relies on the main conversation to remember what happened.

### 2. The loop must expose state

An agentic loop should always answer:

- What input started the loop?
- What phase is active?
- Which agents ran?
- What did each agent receive?
- What did each agent return?
- What evidence supports the result?
- What failed, retried, or was skipped?
- What decision did the workflow make next?
- What artifacts were written?
- What should change before the next run?

Dynamic Workflows already expose phase, agent, model-usage, elapsed-time, prompt, tool-call, and result views through `/workflows`. That is useful runtime observability, but production loops need durable artifacts too. The workflow should write or return a run ledger that can survive beyond the session UI.

### 3. Artifacts are the audit trail

Auditable loops cannot end with a polished final answer only. They need artifact layers:

- Input contract.
- Plan and phase manifest.
- Agent call ledger.
- Evidence ledger.
- Normalized intermediate records.
- Verification report.
- Final output.
- Metrics report.
- Optimization notes.

The final answer should be a summary of the artifacts, not a replacement for them.

### 4. Verification is a phase, not a vibe

Workflows make verification stronger because verifier agents can be separate from producer agents. This only works if verification is designed into the script.

Verification should be explicit:

- Schema validation.
- Source and citation checks.
- Counterevidence search.
- Test command execution.
- Sampling of negative cases.
- Reviewer disagreement capture.
- Killed-claim or rejected-candidate list.
- Final pass, partial, failed, or blocked status.

The verifier should not merely restate the reducer's output. It should have a separate prompt, separate evidence access where possible, and authority to downgrade the result.

### 5. Repeatability requires parameterization

A saved workflow becomes valuable when it can run again with new inputs. That means the workflow needs structured `args`, not vague natural-language setup.

Minimum useful args:

```json
{
  "input": "string or object",
  "scope": ["paths, urls, topics, ids, or records"],
  "output_dir": "path",
  "dry_run": true,
  "max_agents": 8,
  "max_items": 25,
  "verification_level": "light | standard | strict"
}
```

The operator should be able to rerun the same loop with a narrower scope, stricter verifier, different output directory, or lower budget without rewriting the workflow.

### 6. Optimization requires stable measurements

You cannot optimize a loop that only produces prose. Every repeatable workflow should emit metrics that can be compared across runs.

The metrics do not need to be elaborate at first. They need to be stable:

- Time to complete.
- Total agents.
- Token usage.
- Tool-call count.
- Failure count.
- Retry count.
- Schema-valid output count.
- Verified finding count.
- Rejected finding count.
- Cost per accepted result.
- Human review changes.

Once those are stable, the loop can improve through controlled experiments.

### 7. Human checkpoints should be loop boundaries

Claude Code Dynamic Workflows do not support arbitrary mid-run user input beyond permission prompts. Any loop that requires human approval should be split:

```text
workflow A: gather, score, recommend
human approval
workflow B: execute approved action
workflow C: verify, package, log
```

This is especially important for external communications, deployment, publishing, financial actions, data deletion, and customer-facing changes.

### 8. Use the surrounding OS for durability

Claude Code Workflow resume is session-scoped. If Claude Code exits during a run, the next session starts the workflow fresh. That is fine for bounded jobs, but not enough for operating-system-grade loops.

If the user is running persistent operating layer, a production loop can be wrapped by:

- A dashboard-visible task.
- A run directory.
- Event logs.
- Heartbeat updates.
- Approval or human-task records when needed.
- Memory or KB ingestion after verification.
- A completion result with artifact paths.

The workflow is the engine. The operating layer is the accountability system.

## Loop Anatomy

### 1. Trigger

Defines why the loop starts.

Examples:

- User command.
- Saved workflow slash command.
- persistent operating layer cron.
- GitHub event.
- Research request.
- Daily monitor threshold.
- Human-approved continuation.

Artifact:

- `trigger.json` with source, timestamp, operator, args, repo path, branch, and related task id.

### 2. Intake and Preflight

Validates that the loop is allowed and has enough information to run.

Checks:

- Args schema valid.
- Scope not empty.
- Output path writable.
- Git state acceptable.
- Required tools available.
- Permissions fit the action.
- Budget limits present.
- Human approval not needed mid-run.

Artifact:

- `preflight.json` with pass, warn, fail, and blocked reasons.

### 3. Plan

Turns the input into phases, shards, roles, and expected outputs.

The plan should specify:

- Phase names.
- Shard boundaries.
- Worker roles.
- Aggregator role.
- Verifier role.
- Stop conditions.
- Fallback behavior.
- Output contract.

Artifact:

- `plan.json` or the workflow script metadata itself.

### 4. Dispatch

Runs independent workers over shards.

Dispatch needs:

- Deterministic shard ids.
- Prompt templates.
- Tool permissions.
- Expected schema.
- Timeout and retry policy.
- Agent budget.

Artifact:

- `agent-ledger.jsonl`, one line per worker call.

### 5. Observe

Collects worker outputs without losing failure detail.

Each worker result should include:

- Status.
- Shard id.
- Summary.
- Structured records.
- Evidence.
- Errors.
- Tool-call summary.
- Confidence.
- Recommended next action.

Artifact:

- `raw-results/` plus `normalized-results.json`.

### 6. Verify

Challenges outputs before synthesis.

Verification modes:

- Schema validation.
- Sample replay.
- Independent source check.
- Test run.
- Counterexample search.
- Adversarial review.
- Consistency check across agents.

Artifact:

- `verification.json` with pass, partial, fail, blocked, and killed claims.

### 7. Decide

Chooses whether to continue, retry, narrow scope, escalate, or stop.

Decision rules should be explicit:

- If required tool is missing, stop as blocked.
- If too many shards fail, mark partial and do not publish.
- If verifier rejects a claim, remove or downgrade it.
- If budget is near cap, stop before another fan-out.
- If human approval is required, output approval packet and stop.

Artifact:

- `decisions.jsonl`, one line per branch decision.

### 8. Artifact and Report

Writes durable outputs and returns an operator summary.

The final summary should include:

- Result status.
- What changed or was found.
- Confidence.
- Artifact paths.
- Verification result.
- Known gaps.
- Next recommended action.

Artifacts:

- `brief.md`
- `brief.json`
- `evidence-ledger.jsonl`
- `metrics.json`
- `run-summary.md`

### 9. Learn

Captures what should change before the next run.

This is the optimization loop. It should record:

- Which prompts underperformed.
- Which sources produced low-yield records.
- Which verifier caught issues.
- Which failures repeated.
- Which budget limits were too loose or too tight.
- Which schema fields were ambiguous.
- Which human edits should become rules.

Artifact:

- `optimization-notes.md` or `run-retrospective.md`.

## Artifact Contract

A production-grade agentic loop should emit this minimum artifact set:

```text
run/
  trigger.json
  preflight.json
  plan.json
  agent-ledger.jsonl
  raw-results/
  normalized-results.json
  evidence-ledger.jsonl
  verification.json
  decisions.jsonl
  metrics.json
  run-summary.md
  optimization-notes.md
```

For coding loops, add:

```text
  diff-summary.md
  test-results.json
  touched-files.txt
  rollback-notes.md
```

For research loops, add:

```text
  sources.jsonl
  claims.jsonl
  killed-claims.md
  citation-audit.json
```

For content loops, add:

```text
  candidate-scores.json
  angle-rationale.md
  brand-review.md
  publish-package/
```

For operations loops, add:

```text
  task_state.json
  approval-packet.md
  escalation-log.jsonl
  recovery-checkpoint.md
```

## Metrics Model

### Runtime Metrics

These measure whether the loop ran efficiently:

- `duration_ms`
- `phase_count`
- `agent_count`
- `max_concurrency`
- `total_model_usage`
- `total_tool_calls`
- `retry_count`
- `timeout_count`
- `permission_prompt_count`
- `failed_agent_count`
- `partial_agent_count`

### Quality Metrics

These measure whether the loop produced reliable work:

- `schema_valid_count`
- `schema_invalid_count`
- `verified_claim_count`
- `rejected_claim_count`
- `single_source_claim_count`
- `counterevidence_count`
- `test_pass_count`
- `test_fail_count`
- `reviewer_disagreement_count`
- `human_edit_count`

### Yield Metrics

These measure whether the loop is worth running:

- `accepted_output_count`
- `rejected_output_count`
- `useful_signal_rate`
- `false_positive_rate`
- `cost_per_accepted_output`
- `time_per_accepted_output`
- `source_yield_by_type`
- `agent_yield_by_role`

### Operational Metrics

These measure whether the loop fits an operating system:

- `task_id`
- `owner_agent`
- `approval_required`
- `approval_id`
- `blocked_reason`
- `artifact_count`
- `artifact_paths`
- `dashboard_status`
- `memory_ingested`
- `kb_ingested`
- `recovery_checkpoint_written`

## Optimization Cycle

Agentic loops should improve like production systems, not like one-off prompts.

### 1. Baseline

Run the smallest useful version of the workflow and capture metrics.

Example:

```text
scope: 10 files
agents: 4
verification: standard
result: 6 findings, 2 rejected, 1 false positive after human review
```

### 2. Diagnose

Find the limiting factor.

Common bottlenecks:

- Bad sharding.
- Worker prompt too broad.
- Output schema too vague.
- Verifier too weak.
- Sources too noisy.
- Agent budget too high or too low.
- Aggregator over-trusts low-confidence results.
- Human review keeps making the same edits.

### 3. Change One Variable

Treat each revision as an experiment. Change one major thing at a time:

- Shard by package instead of file count.
- Add a required evidence field.
- Add a skeptic phase.
- Lower max agents.
- Route low-risk extraction to a smaller model.
- Add source allowlist.
- Add killed-claims section.

### 4. Re-run a Comparable Slice

Use the same or comparable input scope. Compare:

- Time.
- Token use.
- Accepted outputs.
- False positives.
- Human edits.
- Verification failures.

### 5. Promote or Revert

If the change improves the target metric without unacceptable side effects, promote it into the saved workflow or skill. If not, revert or keep it as an experimental variant.

### 6. Record the Learning

Optimization is only real if the next run can inherit it.

Record:

- What changed.
- Why it changed.
- Metric before.
- Metric after.
- Decision.
- Follow-up hypothesis.

Artifact:

```json
{
  "change": "added independent verifier phase",
  "target_metric": "false_positive_rate",
  "before": 0.22,
  "after": 0.08,
  "decision": "promote",
  "next_hypothesis": "require counterevidence search for high-risk claims"
}
```

## Example Loop Blueprints

### Research Intelligence Loop

Goal: turn broad source material into a verified brief.

```text
trigger -> search plan -> source-class agents -> claim extraction -> verifier agents -> reducer -> cited brief -> metrics -> source-yield update
```

Key artifacts:

- `sources.jsonl`
- `claims.jsonl`
- `verification.json`
- `killed-claims.md`
- `brief.md`

Key metrics:

- Verified claims.
- Rejected claims.
- Single-source claims.
- Source yield.
- Citation defects.

### Codebase Audit Loop

Goal: inspect a large codebase for a class of issue.

```text
trigger -> preflight -> file shards -> analyzer agents -> repro agents -> fixer recommendation -> test verifier -> audit report
```

Key artifacts:

- `touched-files.txt`
- `findings.jsonl`
- `repro-steps.md`
- `test-results.json`
- `audit-report.md`

Key metrics:

- Files scanned.
- Findings accepted.
- Findings rejected.
- Tests passed.
- Time per accepted finding.

### Content Pipeline Loop

Goal: convert raw signals into ranked content opportunities.

```text
trigger -> source ingest -> extractor agents -> angle scorer -> proof verifier -> editorial reducer -> approval packet -> publish package after approval
```

Key artifacts:

- `candidate-scores.json`
- `evidence-ledger.jsonl`
- `angle-rationale.md`
- `approval-packet.md`

Key metrics:

- Useful signal rate.
- Source yield.
- Rejected candidates.
- Human pick rate.
- Publish conversion after human approval.

### Agent Operations Loop

Goal: monitor and improve a recurring agent pipeline.

```text
cron -> task -> health check -> log scan -> failure classifier -> fix proposal -> approval or implementation -> verification -> memory update
```

Key artifacts:

- `health-snapshot.json`
- `failure-clusters.json`
- `fix-plan.md`
- `verification.json`
- `memory-note.md`

Key metrics:

- Failure recurrence.
- Mean time to detection.
- Mean time to recovery.
- Stale task count.
- Missed heartbeat count.

## Optional persistent operating layer Path

Claude Code Dynamic Workflows can be used without persistent operating layer. The default skill path should teach workflow engineering: loop design, state, verification, artifacts, stop conditions, and optimization.

For users who are running persistent operating layer, workflows can become a bounded execution unit inside the wider operating layer.

Optional persistent operating layer wrapper pattern:

```text
persistent operating layer cron or user request
-> create task
-> run skill to select or design workflow
-> launch dynamic workflow or persistent operating layer workflow
-> collect artifacts
-> run verifier
-> log events
-> complete or block task
-> ingest durable result after verification
-> update optimization notes
```

Optional product implications for persistent operating layer users:

- Add a `workflow-run` task pattern with workflow name, args, status, artifact path, verification result, and metrics.
- Require `metrics.json` and `verification.json` for production workflow outputs.
- Treat a workflow without artifacts as a draft, even if it completed.
- Treat a workflow without metrics as unoptimizable.
- Treat a workflow without verification as untrusted.
- Split external-action workflows at approval boundaries.
- Preserve run retrospectives so repeated loops get better instead of merely rerunning.

## How the Existing Skill Should Change

The `workflows-engineering` skill should make agentic loop design the central operating model. persistent operating layer should appear only as an optional path for users who need scheduled, multi-agent, bus-routed, approval-aware, memory-backed operations.

### Add an "Agentic Loop Design" section near the top

Place it after "Fast Routing" and before "Core Mechanics."

It should define the loop:

```text
intake -> plan -> shard -> act -> observe -> verify -> decide -> artifact -> learn -> rerun
```

It should say that workflows are preferred when the orchestration loop itself must be inspectable, repeatable, measurable, and improvable.

### Revise "Fast Routing"

Current routing says to use a workflow when there are many subtasks, intermediate results, loops, branching, artifacts, or cross-checking.

Add stronger routing criteria:

- Use a workflow when the process will be run repeatedly.
- Use a workflow when the result needs a durable evidence ledger.
- Use a workflow when success can be measured across runs.
- Use a workflow when an optimization cycle is expected.
- Use a workflow when verifier agents should be separate from producer agents.

### Expand the design procedure

The current procedure has 10 good steps. Add these:

1. Define loop state and stop conditions.
2. Define artifact manifest before writing prompts.
3. Define metrics before running the first broad pass.
4. Define verifier authority to reject or downgrade output.
5. Define optimization notes that survive into the next run.

### Upgrade the spec template

Add sections for:

- `Loop Anatomy`
- `Args Schema`
- `State Model`
- `Artifact Manifest`
- `Metrics`
- `Verification Gates`
- `Decision Rules`
- `Human Boundaries`
- `Optimization Log`

The template should make `metrics.json`, `verification.json`, and `evidence-ledger.jsonl` first-class outputs.

### Add artifact contract examples

The skill should include a compact minimum artifact contract:

```text
run/
  trigger.json
  preflight.json
  plan.json
  agent-ledger.jsonl
  normalized-results.json
  evidence-ledger.jsonl
  verification.json
  decisions.jsonl
  metrics.json
  run-summary.md
  optimization-notes.md
```

This should be in the main skill body, not buried only in references, because it is the core auditability checklist.

### Add metrics guidance

The skill should teach the agent to ask for metrics early. Minimum categories:

- Runtime metrics.
- Quality metrics.
- Yield metrics.
- Operational metrics.

This turns workflows from "big automation" into optimizable loops.

### Add loop anti-patterns

Add these to the existing anti-patterns:

- Workflow with no artifact manifest.
- Workflow with final prose but no evidence ledger.
- Workflow with no metrics, making it impossible to optimize.
- Workflow where producer and verifier are the same role.
- Workflow that treats partial completion as success.
- Workflow that hides a human approval boundary inside one long run.
- Workflow that reruns without recording what changed from the previous run.

### Clarify optional persistent operating layer integration

The persistent operating layer section should move from mandatory "wrap workflows with tasks" language to optional "run workflows as task backed loops when an operating layer is needed."

Recommended language:

```text
For persistent operating layer-backed production agent operations, wrap each workflow run in a persistent operating layer task, log event milestones, write artifacts, require verifier output, then complete or block the task with artifact paths. Use crons to trigger recurring loops, approvals to stop external actions, and memory or KB ingestion only after verification.
```

### Add a "Skill to Workflow to Loop" migration rule

The current skill already says to promote a skill to a workflow when the skill becomes an orchestrator. Extend that:

```text
If the workflow will run repeatedly and its performance should improve, design it as a loop. Add artifacts, metrics, verifier phases, and optimization notes before saving it as a reusable command.
```

## Bottom Line

Claude Code Dynamic Workflows make agentic loops concrete because they put orchestration into runnable code. The winning pattern is not more agents. It is explicit loop design:

- Clear trigger.
- Structured args.
- Deterministic shards.
- Separate worker roles.
- Evidence-preserving outputs.
- Independent verification.
- Durable artifacts.
- Stable metrics.
- Retrospective learning.
- Rerunnable workflow code.

That is how workflows become complex, auditable, observable, repeatable, and optimizable.
