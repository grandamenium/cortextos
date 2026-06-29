---
name: workflows-engineering
description: Use this skill when the user asks about workflows-engineering, Claude Code Dynamic Workflows, /workflows, ultracode, workflow design, reusable workflow scripts, agentic loops, loop engineering, maker-checker loops, evaluator-optimizer loops, or when to choose workflows versus skills, subagents, MCP, slash commands, hooks, or routines. This skill helps design complex, auditable, observable, repeatable, optimizable agentic loops using Claude Code Workflows and related primitives. persistent operating layer is an optional integration path, not a default requirement.
---

# Workflows Engineering

Use this skill to reason about Claude Code Dynamic Workflows, agentic loops, and their neighboring primitives.

Dynamic workflows are for repeatable orchestration at scale. Claude writes a JavaScript script for the task, the workflow runtime runs that script in an isolated environment, and the script coordinates many subagents. Use them when a task is too large or too structured for one chat to manage cleanly.

The strongest frame is agentic loops. A workflow is the runnable loop body: it discovers or receives work, plans, delegates, verifies, records state, decides whether to continue, and returns an auditable result. The valuable asset is not "many agents." The valuable asset is a loop that can be inspected, rerun, measured, improved, and safely stopped.

## Agentic Loop Frame

An agentic loop is a control system around agent work:

1. Trigger: what starts the loop.
2. Goal: what outcome the loop is pursuing.
3. State: what the loop knows from previous passes.
4. Planner: how the loop decomposes work.
5. Worker: who executes a bounded unit.
6. Verifier: how the loop checks output.
7. Stop condition: when the loop exits or hands off.
8. Artifact ledger: what proof the loop saves.
9. Optimizer: how the next pass improves.

Claude Code Workflows map naturally onto this shape:

- the workflow script owns trigger handling, phases, branching, and loop control
- subagents own worker and verifier roles
- `args` carries inputs and operating limits
- script variables hold intermediate state during the run
- output files provide durable evidence outside the chat
- saved workflows make the loop repeatable as a slash command
- optional operating layers such as persistent operating layer can schedule, route, log, approve, and persist the loop outside Claude Code

## Fast Routing

Use a workflow when the task has most of these properties:

- Many independent subtasks can run in parallel.
- Intermediate results would flood the main conversation.
- The process should be rerun with new inputs.
- The orchestration needs loops, branching, retries, or staged aggregation.
- The output needs durable artifacts, audit trails, or cross-checking.
- The agentic loop needs explicit state, verifier roles, stop rules, and optimization metrics.

Use a skill when the task is mostly reusable instructions:

- Teach Claude a procedure, style, policy, domain, or checklist.
- Keep a compact triggerable playbook.
- Bundle reference files, templates, scripts, or examples.
- Invoke directly as a slash command or let Claude trigger it when relevant.

Use a subagent when the task needs isolation but not a reusable orchestration script:

- Delegate one bounded research, coding, review, or verification job.
- Keep a main chat clean while a worker explores or edits a scoped area.
- Use specialist instructions, tools, skills, memory, or permission settings.

Use MCP when Claude needs an external capability:

- Read or update third-party systems.
- Query databases, docs, tickets, design files, browser state, or internal tools.
- Avoid copying data manually into chat.

Use hooks when a rule must fire automatically:

- Format after edits.
- Block risky commands.
- Run checks at lifecycle points.
- Enforce deterministic policy that should not depend on model compliance.

Use an operating layer such as persistent operating layer only when the work must be visible and persistent outside Claude Code:

- Dashboard-visible task state.
- Recurring schedules.
- Heartbeat and event logs.
- Agent-to-agent routing.
- Human blockers and approvals.

## Core Mechanics

Current official mechanics to preserve:

- Dynamic workflows require Claude Code v2.1.154 or later.
- They are available on paid plans, Anthropic API access, Amazon Bedrock, Google Cloud Vertex AI, and Microsoft Foundry.
- Pro users may need to enable Dynamic workflows in `/config`.
- A workflow is a script Claude writes for the task and runs across many subagents in the background.
- The script coordinates agents. The agents read, write, run commands, fetch, and use MCP tools.
- The workflow script itself has no direct filesystem or shell access.
- Intermediate results stay in script variables instead of filling the main Claude context.
- Runs are managed from `/workflows` or the task panel.
- Saved workflows live in `.claude/workflows/` for project scope or `~/.claude/workflows/` for personal scope.
- Saved workflows run as slash commands and can receive structured input through a global `args` variable.
- Paused runs can resume within the same Claude Code session. If Claude Code exits while a workflow is running, the next session starts the workflow fresh.
- Limits are up to 16 concurrent agents and up to 1,000 total agents per run.
- No mid-run user input is available except permission prompts. Split a process into separate workflows when human sign-off is needed between stages.
- Large workflow runs can use much more token budget than a conversation. Test on a small slice first.

## Decision Matrix

| Need | Best primitive | Reason |
|---|---|---|
| Reusable multi-agent process with branching | Dynamic workflow | The orchestration becomes runnable script logic. |
| Reusable instructions, templates, or procedure | Skill | The instructions trigger when relevant and can bundle references. |
| One isolated specialist worker | Subagent | It keeps task context separate without building a reusable runner. |
| External system or data access | MCP | It gives Claude a tool boundary to another system. |
| Mandatory lifecycle enforcement | Hook | It runs deterministically at configured events. |
| User-facing slash entrypoint | Saved workflow or skill | Workflows are better for orchestration; skills are better for instruction. |
| Recurring operational job | Claude routine, external scheduler, or optional persistent operating layer cron | Add persistent operating layer only when the fleet dashboard, memory, bus, and approvals matter. |
| Audit trail and durable org memory | Workflow artifacts, external tracker, or optional persistent operating layer task | Claude Code workflow logs are useful, but production teams may need a durable operating record. |

## Workflow Design Procedure

When designing a Claude Code workflow as an agentic loop:

1. Define the repeatable operator goal.
2. Define the trigger and how input enters through `args`.
3. Define state: current pass, previous results, known failures, budget, and artifacts.
4. Define the plan gate before worker agents act.
5. Identify independent fan-out units.
6. Define maker and checker subagent roles with explicit ownership.
7. Define the stop condition: pass, no progress, max iterations, budget cap, timeout, or human handoff.
8. Specify durable output paths and the artifact ledger.
9. Require source/provenance fields in artifacts.
10. Add a small-slice test mode.
11. Add failure labels, not silent empty results.
12. Add final aggregation and skeptical verification.
13. Define metrics for optimization: pass rate, cost, duration, retry count, verifier failures, and unresolved blockers.

## Recommended Workflow Spec Template

~~~markdown
# [Workflow Name]

## Goal
[One sentence describing the repeatable process.]

## Loop Thesis
[One sentence naming the loop: trigger -> state -> planner -> worker -> verifier -> stop -> improve.]

## Use When
- [Situation 1]
- [Situation 2]

## Do Not Use When
- [Human approval is needed mid-run]
- [Task is one small bounded delegation]

## Args Schema
```json
{
  "input": "",
  "output_dir": "",
  "dry_run": true,
  "max_items": 10,
  "max_iterations": 3,
  "budget_limit": "small"
}
```

## Outputs
- `brief.md`
- `brief.json`
- `run-log.json`
- `evidence/`

## Phases
1. Validate inputs.
2. Load state and previous artifacts.
3. Plan the next pass.
4. Dispatch makers in parallel.
5. Dispatch checkers or evaluators.
6. Decide continue, revise, stop, or hand off.
7. Write artifacts and metrics.
8. Return operator summary.

## Subagent Roles
- `planner`
- `maker`
- `checker`
- `skeptic`
- `writer`

## Failure Labels
- `success`
- `partial_success`
- `real_zero`
- `tool_failure`
- `permission_blocked`
- `human_decision_required`
- `no_progress`
- `budget_exceeded`
~~~

## Anti-Patterns

- Do not use a workflow just because a task is important. Use it because orchestration should be scripted.
- Do not ask for a workflow without specifying inputs, outputs, phases, and success criteria.
- Do not build a loop without a stop condition.
- Do not let the maker be the only checker.
- Do not keep loop state only in the chat.
- Do not optimize a loop without metrics.
- Do not hide human approval inside a workflow. Split the run before the approval boundary.
- Do not fan out to many agents before proving the workflow on a small slice.
- Do not treat workflow resume as durable cross-session recovery.
- Do not assume every workflow needs persistent operating layer. Use it only when scheduling, routing, fleet visibility, memory, approvals, or restart recovery matter.
- Do not use MCP as a workflow substitute. MCP gives capabilities; workflows coordinate work.
- Do not use a skill as a dumping ground for huge generated research. Put deep docs in `references/` and keep `SKILL.md` compact.

## Optional persistent operating layer Path

Claude Code Workflows are useful on their own. A user can apply this skill without persistent operating layer by designing a saved workflow, writing artifacts, and using whatever tracker or scheduler their environment already has.

Use the persistent operating layer path only when the user is running persistent operating layer or explicitly wants scheduled, multi-agent, bus-routed, approval-aware, memory-backed operations.

In that case, persistent operating layer can wrap a Claude Code workflow with:

- tasks make work visible on the dashboard
- bus messages route across agents
- crons schedule recurring operations
- heartbeat proves liveness
- approvals and human tasks make blockers explicit
- memory and docs preserve context across restarts

Use both together by creating a persistent operating layer task for the operational objective, then using Claude Code workflows for the bounded loop body inside that task. Keep this optional. Do not make it the default answer for users who only asked for Claude Code workflow design.

Optional positioning line for persistent operating layer users:

```text
Claude Code Workflows run the loop. persistent operating layer operates the loops.
```

## References

Load only the reference needed for the current request:

- `references/official-feature-surface.md`: feature mechanics, official docs, lifecycle, limits.
- `references/implementation-spec-patterns.md`: local spec patterns and workflow design examples.
- `references/comparison-decision-matrix.md`: deeper comparison across workflows, skills, subagents, MCP, slash commands, hooks, and persistent operating layer.
- `references/use-cases-patterns.md`: examples for content, research, coding, QA, scraping, and agent operations.
- `references/operational-risks-runtime.md`: resume, token cost, testing, failure modes, permissions, and safety.
- `references/modern-agentic-loop-patterns.md`: current loop engineering and agentic design pattern research.
- `references/agentic-loop-repo-from-31-pack.md`: local 31-pack loop repository analysis and Crabbox verification-box connection.
- `references/workflows-as-agentic-loops.md`: synthesis for using workflows to build auditable, observable, repeatable, optimizable loops.
