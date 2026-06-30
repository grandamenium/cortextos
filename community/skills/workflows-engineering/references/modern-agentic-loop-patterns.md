# Modern Agentic Loop Patterns

Date: 2026-06-29
Scope: recent agentic-loop ideas relevant to Claude Code Workflows, with emphasis on planner-executor-evaluator loops, reflection, self-improvement, eval-driven loops, memory feedback, tool-use loops, and observability.

## Bottom line

The current agent conversation is moving from "prompt the agent better" to "design the loops around the agent." The model/tool loop is now treated as the atomic unit: model receives context, calls tools, observes results, and repeats until a stopping condition is met. The higher-leverage work is stacking outer loops around that unit: planner-executor-evaluator, verification, event triggers, trace-to-eval feedback, memory consolidation, and harness improvement.

For Claude Code Workflows, this means a workflow should not be framed as "many subagents in parallel" alone. The more durable frame is: a workflow is a repeatable control loop with explicit state, isolated execution, separate verification, observable traces, budget limits, and a path for failures to become memory, skills, tests, or evals.

## Source base

Primary and current sources checked:

- Anthropic, "Building effective agents", 2024-12-19: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, "Demystifying evals for AI agents", 2026: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- OpenAI Agents SDK docs, running agents: https://developers.openai.com/api/docs/guides/agents/running-agents
- OpenAI Agents SDK tracing docs: https://github.com/openai/openai-agents-python/blob/main/docs/tracing.md
- OpenAI, "Evaluate agent workflows": https://developers.openai.com/api/docs/guides/agent-evals
- OpenAI Developers, "Testing Agent Skills Systematically with Evals", 2026: https://developers.openai.com/blog/eval-skills
- LangGraph workflows and agents docs: https://docs.langchain.com/oss/python/langgraph/workflows-agents
- LangGraph overview: https://docs.langchain.com/oss/python/langgraph/overview
- LangSmith evaluation docs: https://docs.langchain.com/langsmith/evaluation
- LangChain, "Agent Evaluation Readiness Checklist", 2026-03-27: https://www.langchain.com/blog/agent-evaluation-readiness-checklist
- LangChain, "How we build evals for Deep Agents", 2026-03-26: https://www.langchain.com/blog/how-we-build-evals-for-deep-agents
- LangChain, "The Art of Loop Engineering", 2026-06-16: https://www.langchain.com/blog/the-art-of-loop-engineering
- LangChain Deep Agents product page: https://www.langchain.com/deep-agents
- Vercel AI SDK loop control docs: https://ai-sdk.dev/docs/agents/loop-control
- OpenTelemetry, "Inside the LLM Call: GenAI Observability with OpenTelemetry", 2026: https://opentelemetry.io/blog/2026/genai-observability/
- Langfuse observability docs: https://langfuse.com/docs/observability/overview
- LangGraph memory concepts: https://docs.langchain.com/oss/python/concepts/memory
- Letta memory blocks docs: https://docs.letta.com/guides/core-concepts/memory/memory-blocks/
- Letta Code memory docs: https://docs.letta.com/letta-code/memory/
- Mem0 paper, arXiv 2504.19413: https://arxiv.org/abs/2504.19413
- Generative Agents paper, arXiv 2304.03442: https://arxiv.org/abs/2304.03442
- Magentic-One paper, arXiv 2411.04468: https://arxiv.org/html/2411.04468v1
- HumanLayer 12-Factor Agents: https://github.com/humanlayer/12-factor-agents
- Addy Osmani, "Loop Engineering", 2026-06-07: https://addyosmani.com/blog/loop-engineering/

## Pattern 1: The atomic tool-use loop

The base loop is now standardized across frameworks:

1. Prepare context and instructions.
2. Call the model.
3. If the model emits tool calls, execute them.
4. Return tool results to the model.
5. Continue until final output, handoff, approval stop, or a configured stop condition.

OpenAI's Agents SDK describes this directly as the "agent loop": call the current agent's model, inspect output, execute tool calls, switch agents on handoff, and return when the model produces a final answer. Vercel AI SDK exposes the same idea as loop control with `stopWhen` and `prepareStep`, including a default max-step safety cap. Anthropic's "Building effective agents" makes the same architectural distinction: workflows use predefined code paths, while agents dynamically direct their process and tool use.

Implication: the tool loop itself is table stakes. The differentiator is not that a system can call tools repeatedly. The differentiator is whether the outer loop can bound, observe, evaluate, and improve that repeated tool use.

## Pattern 2: Planner-executor-evaluator

The dominant production pattern is a split between planning, execution, and evaluation:

- Planner: decomposes the objective, chooses subtasks, assigns tools or agents, and tracks state.
- Executor: performs scoped work through tools, code, browser, search, files, or APIs.
- Evaluator: scores the output or trajectory against explicit criteria and decides whether to accept, retry, replan, or escalate.

Anthropic's evaluator-optimizer workflow is the cleanest general form: one LLM generates, another evaluates and feeds back until the criteria are satisfied. Magentic-One is a multi-agent version: an orchestrator plans, tracks progress, maintains ledgers, delegates to specialized agents, and replans to recover from errors. LangGraph formalizes these patterns as explicit graphs with persistence, streaming, debugging, and deployment.

The important shift is that evaluator and planner should not be implicit in the same agent prompt. The loop becomes more reliable when the planner state and evaluator criteria are explicit artifacts.

Claude Code Workflow translation:

- A workflow script should contain an explicit plan object or state ledger.
- Worker agents should return structured results, not just prose.
- A verifier phase should be separate from the implementation phase.
- The verifier should be allowed to fail the run, narrow scope, request more evidence, or route to a human.

## Pattern 3: Reflection and self-critique

Reflection is still useful, but recent practice is narrower and more skeptical than early agent demos. The pattern is not "let the same model think harder forever." It is:

- Ask an agent to critique its own draft for cheap local improvements.
- Use external observations such as test results, tool outputs, or retrieved sources as grounding.
- Prefer separate reviewer agents for high-stakes checks.
- Convert recurring reflection findings into prompts, skills, tests, or evals.

The Generative Agents paper remains the canonical older architecture for observation, memory, reflection, and planning. Current tool builders are applying a more operational version: reflection should produce structured changes to state or memory, not just more reasoning text.

Best use cases:

- Draft revision where qualitative feedback is valuable.
- Research completeness checks.
- Code review against a narrow spec.
- Tool-call recovery after an error.

Failure mode:

- Same-agent self-grading creates false confidence. Addy Osmani's loop engineering post states the practical version clearly: split the maker from the checker. Claude Code Workflows should do the same.

## Pattern 4: Eval-driven loops

The strongest recent pattern is the eval flywheel:

1. Run the agent on real or curated tasks.
2. Capture trace, tool calls, artifacts, and final output.
3. Grade the run with deterministic checks, LLM-as-judge, human review, or a mix.
4. Inspect failures.
5. Convert failures into new dataset rows, tests, prompt edits, tool descriptions, skills, or guardrails.
6. Rerun and compare over time.

Anthropic's eval guide emphasizes that agents are harder to evaluate because they run over many turns, use tools, modify environment state, and can compound mistakes. OpenAI's agent eval docs recommend starting with traces while debugging, then moving to datasets and eval runs for repeatability. OpenAI's skill eval guide gives a concrete formula: prompt -> captured run with trace and artifacts -> checks -> score. LangChain's agent eval checklist pushes the same discipline: use offline, online, and ad-hoc evals; review traces; track step count, tool calls, latency, and quality; feed production failures back into datasets.

The practical insight: evals are not a separate QA step. They are one of the loops. A good workflow should be designed so its failures are easy to turn into eval cases.

Claude Code Workflow translation:

- Every saved workflow should have a small eval set.
- Store run traces or structured summaries with enough detail to replay failures.
- Track both outcome metrics and process metrics: tool calls, retries, elapsed time, token use, files touched, sources cited, and verifier pass rate.
- Prefer binary or rubric-specific graders over broad "quality" scores.
- Add negative controls where the workflow should not act.

## Pattern 5: Memory feedback loops

Modern agent memory is splitting into several layers:

- Short-term state: thread-scoped history, current plan, open subtasks, generated artifacts.
- Episodic memory: traces, transcripts, prior runs, failures, decisions, and outcomes.
- Semantic memory: durable facts about users, repos, systems, preferences, and domain knowledge.
- Procedural memory: skills, runbooks, tool rules, conventions, and eval-derived lessons.

LangGraph documents short-term memory as thread state persisted through checkpoints and long-term memory as namespaced cross-session storage. Letta exposes memory blocks as structured, persistent context that agents can read and update. Letta Code adds the coding-agent version: the agent can self-edit memory, run background "dream" subagents, and store memory in a git-backed filesystem. Mem0 frames production memory as dynamic extraction, consolidation, and retrieval of salient information from ongoing conversations.

The current design debate is not "should agents have memory." It is where memory updates happen:

- Hot path memory: the agent decides to save a fact before responding. More immediate, but can add latency and mistakes.
- Background memory: a later process reviews traces or conversations and writes distilled lessons. Slower, but often cleaner.
- Human-gated memory: durable rules and project conventions require review before they affect future runs.

Claude Code Workflow translation:

- Treat workflow state, memory, and evals as different things.
- Keep current run state in workflow artifacts.
- Promote durable lessons only after verification.
- Write memory as specific operating guidance, not vague summaries.
- Store procedural lessons as skills or workflow changes when they are repeatable.

## Pattern 6: Event-driven and ambient loops

Recent "loop engineering" discourse emphasizes that an agent loop becomes operational when it is triggered by events rather than manual prompting. Events include:

- Cron schedules.
- Webhooks.
- New GitHub issues or PRs.
- CI failures.
- New documents.
- Slack, Linear, email, or ticket activity.
- Human approval callbacks.

LangChain's "Art of Loop Engineering" names this as the event-driven loop: the agent runs inside a larger system when an event fires. Addy Osmani's June 2026 post maps the same shape across Codex and Claude Code: automations, worktrees, skills, connectors, subagents, and persistent state.

The key point is that triggers do not make a loop reliable by themselves. A production event loop needs:

- Idempotency.
- State file or task ledger.
- Duplicate suppression.
- Clear stop conditions.
- Budget caps.
- Human escalation path.
- Observability and audit trail.

Claude Code Workflow translation:

- A workflow is a bounded job. A routine, cron, hook, or daemon is what makes it ambient.
- Do not make a workflow discover work, execute work, approve itself, and deploy results with no outer supervisor.
- Use event-driven triggers to create or resume a tracked task, then run the workflow with explicit input and expected output.

## Pattern 7: Observability as the improvement substrate

Observability is becoming the shared foundation for debugging and self-improvement:

- OpenAI Agents SDK tracing captures model generations, tool calls, handoffs, guardrails, and custom events.
- OpenAI agent evals use traces and graders to find workflow-level issues.
- LangSmith treats traces, runs, threads, datasets, and eval results as the improvement layer.
- Langfuse defines tracing as the key LLM-app observability primitive because it preserves prompts, responses, tool calls, retrieval steps, timings, and relationships.
- OpenTelemetry GenAI semantic conventions standardize model name, token counts, latency, prompts, completions, tool calls, and tool results where content capture is enabled.

LangChain's loop engineering post adds the next step: a hill-climbing loop. Production traces feed an analysis agent, which identifies recurring issues and proposes changes to prompts, tools, graders, memory, or harness config.

Claude Code Workflow translation:

- Require a run record for every workflow: goal, inputs, script path, model, budget, spawned agents, tool counts, token counts, artifacts, verifier result, final status.
- Use trace-derived failure clusters to update skills and evals.
- Do not let the same unattended loop rewrite its own harness and deploy the change without review.
- Instrument enough that an operator can answer: why did this run stop, what did it change, what did it ignore, and what proof did it collect?

## Pattern 8: Tool-interface engineering

Recent agent builders keep converging on the same point: tools are part of the loop design, not just capabilities. Anthropic's tool guidance emphasizes clear tool design and documentation. HumanLayer's 12-Factor Agents argues that tools are structured outputs and that developers should own prompts, context, control flow, state, and pause/resume APIs. Vercel's loop-control docs expose tool-loop stopping and per-step setting changes as first-class controls.

Good tool loops have:

- Narrow tools with clear names and schemas.
- Tool docs that describe when not to use the tool.
- Deterministic error messages compact enough to feed back into context.
- Approval stops for sensitive tools.
- Idempotent write tools where possible.
- Tool-level tracing.

Bad tool loops have:

- Large ambiguous tools.
- Hidden side effects.
- No distinction between read and write.
- Errors that are too verbose or too vague.
- No way to tell whether repeated calls are progress or thrashing.

## Pattern 9: Human oversight loops

The current production consensus is not full autonomy. It is autonomy with explicit human control points:

- Human approval before sensitive writes.
- Human review for ambiguous grader failures.
- Human acceptance before harness self-improvement lands.
- Human ownership of shipped code, external comms, financial actions, and data deletion.

This is not a contradiction of agentic loops. It is part of loop design. The loop should know when it can continue automatically, when it should ask a verifier, when it should escalate to a human, and when it should stop.

## Proposed taxonomy for Claude Code Workflows

Use this taxonomy when describing or designing workflows:

### 1. Goal loop

Purpose: keep working until an explicit condition is satisfied.

Minimum controls:

- Verifiable stop condition.
- Max turns, max agents, max tokens, or max elapsed time.
- Separate checker.
- Final proof artifact.

Best for: test-pass loops, migration completion loops, docs consistency loops.

### 2. Planner-executor-evaluator loop

Purpose: decompose complex work, execute subparts, evaluate outputs, then replan.

Minimum controls:

- State ledger.
- Worker result schema.
- Evaluator rubric.
- Replan criteria.
- Partial-success handling.

Best for: codebase migrations, bug sweeps, multi-source research, refactors.

### 3. Reflection loop

Purpose: improve a draft or plan before final output.

Minimum controls:

- Reflection prompt scoped to known criteria.
- External evidence such as tests, sources, logs, or tool output.
- Limit on reflection passes.
- Separate verifier for important outputs.

Best for: writing, research synthesis, UX copy, code review notes.

### 4. Eval flywheel loop

Purpose: turn failures into measurable future checks.

Minimum controls:

- Captured trace and artifacts.
- Failure taxonomy.
- Dataset update path.
- Grader versioning.
- Regression run before accepting harness changes.

Best for: recurring skills, high-volume workflows, production agents.

### 5. Memory consolidation loop

Purpose: distill repeated experience into durable memory or procedure.

Minimum controls:

- Separation of raw traces from curated memory.
- Human review for persistent rules.
- Memory scope: user, repo, org, or workflow.
- Expiration or correction path.

Best for: agent preferences, repo conventions, operational incidents, recurring mistakes.

### 6. Ambient operations loop

Purpose: run from external triggers and maintain an ongoing process.

Minimum controls:

- Trigger source.
- Idempotency key.
- Task or state record.
- Duplicate suppression.
- Escalation channel.
- Completion logging.

Best for: daily research, issue triage, CI failure summaries, monitoring.

### 7. Harness improvement loop

Purpose: analyze traces and propose changes to prompts, tools, skills, graders, or workflow scripts.

Minimum controls:

- Change proposal artifact.
- Before/after eval result.
- Human approval before production use.
- Rollback path.

Best for: mature workflows with enough trace volume to find patterns.

## What people are implicitly optimizing for

Recent sources point to the same optimization targets:

- Repeatability: can the same loop run tomorrow with the same contract?
- Auditability: can an operator inspect what happened and why?
- Verifiability: does the loop know what "done" means?
- Recoverability: can the loop resume or at least reconstruct state after failure?
- Bounded autonomy: can the loop act without exceeding permissions, budget, or scope?
- Composability: can planner, executor, evaluator, memory, and triggers be swapped or improved independently?
- Improvement over time: do traces, evals, and memory make the next run better?

## Anti-patterns to avoid

- Single-agent monolith: one agent plans, acts, verifies, remembers, and declares success.
- Infinite enthusiasm loop: no hard stop condition or budget.
- Self-grading only: the same context that created the output decides it is correct.
- Hidden state: progress exists only in chat history or scratchpad.
- Generic evals: broad helpfulness scores that do not map to production failure modes.
- No negative controls: workflows that always act when they should sometimes decline.
- Unscoped memory writes: every run writes durable memory without review.
- Unobservable retries: the loop keeps trying but does not expose why.
- Parallel chaos: many agents share one worktree or state file and overwrite each other.
- Trigger without owner: a scheduled loop runs, but no task, artifact, or human owns the result.

## Design implications for the Claude Code Workflows narrative

The strongest positioning is:

"A workflow is the place where the loop becomes inspectable."

That means Claude Code Workflows should be explained as more than subagent fanout:

- The workflow script is the control plane for one bounded job.
- The plan and state ledger make progress auditable.
- The executor agents do scoped work in isolated contexts.
- The evaluator agents decide whether outputs meet criteria.
- The trace and artifacts let failures become evals.
- The memory layer decides what should persist beyond the run.
- The outer operating layer decides when the workflow runs, who approves sensitive actions, and what happens after failure.

This maps directly onto the user's requested frame: complex, auditable, observable, repeatable, optimizable loops.

## Practical workflow checklist

For any serious Claude Code Workflow, require:

1. Goal: one sentence, with explicit success and failure conditions.
2. Inputs: files, repos, URLs, tickets, or datasets.
3. Scope limits: directories, max agents, max turns, max tokens, max elapsed time.
4. State: a visible ledger of plan, subtasks, attempts, and decisions.
5. Execution isolation: separate worktree or scoped subagent contexts where needed.
6. Evaluation: deterministic checks first, LLM rubric second, human review for ambiguous or sensitive cases.
7. Observability: trace or structured run log with tool calls, handoffs, errors, costs, and artifacts.
8. Memory policy: what gets promoted to durable memory, skill, eval, or no persistent state.
9. Escalation: when to pause for human input.
10. Final status: passed, partial, failed, blocked, or cancelled.

## Final synthesis

Modern agentic loop practice is converging on one thesis: agents become useful when the loop around them is engineered. The model/tool loop does the work. The planner-executor-evaluator loop makes work coordinated. The reflection loop improves drafts. The eval loop turns failures into tests. The memory loop makes lessons persist. The event loop makes agents ambient. The observability loop makes everything debuggable and optimizable.

For Claude Code Workflows, the strategic opportunity is to present workflows as the repeatable loop substrate for Claude Code: scripts that can plan, fan out, verify, observe, and improve bounded jobs, while a higher operating layer handles persistence, permissions, schedules, approvals, and cross-session memory.
