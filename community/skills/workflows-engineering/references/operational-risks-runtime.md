# Claude Code Workflows: Operational Risks and Runtime Behavior

Date: 2026-06-29
Scope: Claude Code Dynamic Workflows, also surfaced through `/workflows`, `/deep-research`, and `ultracode`.

## Bottom Line

Claude Code Workflows are best understood as a session-scoped orchestration primitive, not a durable operating system. The feature is powerful because the plan moves out of the chat transcript and into a JavaScript workflow script that can spawn many subagents, keep intermediate state in script variables, and return a verified final report. The operational risk is that reliability, permissions, recovery, and verification still depend on the surrounding Claude Code session, the local or cloud runtime, and the operator's controls.

Optional persistent operating layer angle for users running that operating layer: do not position it as "replace Workflows." Position it as "supervise, persist, schedule, audit, and coordinate them." Workflows are a high-throughput work unit. persistent operating layer is an always-on fleet layer around work units when the user needs persistent operations.

## Runtime Behavior

Official Anthropic docs describe a dynamic workflow as a JavaScript script that Claude writes for the task and a runtime executes in the background while the main session stays responsive. The key runtime distinction is where the plan and intermediate results live:

- Subagents: Claude decides what to run next turn by turn, and results land in Claude's context window.
- Skills: Claude follows instructions, still mostly inside the conversation context.
- Agent teams: a lead agent supervises peer sessions through a shared task list.
- Workflows: the script decides what runs next, and intermediate results stay in script variables until the final answer.

Operational constraints documented by Anthropic:

- Workflow scripts run in an isolated environment separate from the conversation.
- The script coordinates agents, but does not directly read files, write files, or run shell commands.
- Agents perform file reads, file edits, shell commands, web fetches, and MCP calls.
- Up to 16 agents can run concurrently, with fewer possible on machines with limited CPU.
- Up to 1,000 agents can be spawned in one run.
- `/workflows` shows phase status, agent status, token totals, elapsed time, prompts, recent tool calls, and results.
- Runs can be paused, resumed, stopped, restarted at the agent level, and saved as reusable workflow commands.

This makes Workflows a real orchestration mechanism, but not a fully durable job system. The source of truth for a run is still the Claude Code session plus the generated script and runtime state under `~/.claude/projects/`.

## Resume and Pausing Behavior

Pause behavior is intentionally narrow:

- A user can pause or resume a run from `/workflows` by pressing `p`.
- A user can stop a selected agent or the whole run with `x`.
- A stopped or paused run can be resumed in the same Claude Code session.
- Completed agents return cached results on resume; unfinished agents run live.
- If Claude Code exits while a workflow is running, the next session starts the workflow fresh.

Anthropic's docs are explicit that resume works within the same Claude Code session. This is the main operational weakness. It means:

- Workflows do not provide crash-resilient continuation across a fresh Claude Code session.
- A daemon restart, terminal close, laptop sleep plus process exit, or session corruption can force a fresh run.
- Completed work may be visible in transcripts or artifacts, but the workflow runtime does not guarantee cross-session continuation.
- A workflow requiring human sign-off between stages should be split into multiple workflows, because there is no general mid-run user input beyond agent permission prompts.

Related Claude Code session behavior matters but should not be confused with Workflow resume:

- `claude --continue` and `claude --resume` reopen a conversation under the same session ID and append new messages.
- `/loop` and session-scoped scheduled tasks can be restored only if they have not expired, and only while Claude Code is running and idle.
- Background Bash and monitor tasks are not restored on resume.
- A goal active at session end is restored on resume, but its turn count, timer, and token-spend baseline reset.

So the practical rule is simple: resume the conversation, but do not assume the workflow job itself resumed unless `/workflows` confirms it in the same live session.

## Context and Token Implications

The context benefit is real: intermediate results stay in script variables rather than flooding the main conversation. That reduces context pressure in the supervising session and makes broad fan-out possible.

The token risk is also real:

- Every spawned agent is still a Claude interaction with its own context, tool calls, and outputs.
- Anthropic warns that a single workflow can use meaningfully more tokens than working through the same task in conversation.
- Workflow runs count toward plan usage and rate limits like any other Claude Code session.
- `/workflows` shows each agent's token usage during the run.
- Agent caps bound runaway cost, but 1,000 possible agents is still enough to create a large spend event.
- Every agent uses the session's model unless the script routes a stage to another model.

Operational controls:

- Run a small slice first, such as one directory, one file family, or a narrow research question.
- Ask Claude to use smaller models for low-risk stages.
- Check `/model` before large runs.
- Treat `ultracode` as a cost multiplier, not a default mode for all work.
- Save proven workflows and inspect the generated script before making them routine.
- Require workflow scripts to expose an `args.test_mode`, `args.max_agents`, or similar budget parameter for reusable workflows.

Context compaction is adjacent risk. Claude Code automatically compacts as context fills, and older tool outputs are cleared or summarized first. Anthropic warns that detailed instructions from early in a conversation can be lost. Persistent rules should live in `CLAUDE.md`, settings, permissions, or workflow code, not just in the operator's chat instructions.

## Verification and Testing

Workflows are especially useful for verification because they can fan out independent agents and cross-check claims before reporting back. The built-in `/deep-research` workflow is documented as searching across angles, fetching sources, cross-checking, voting on claims, and returning a cited report with failed claims filtered out.

For code workflows, verification should be designed as part of the script, not added after the run:

- Add a small-slice dry run path before full-repo execution.
- Make each phase return structured results, not prose-only summaries.
- Add explicit verifier agents that inspect worker outputs adversarially.
- Require tests to run after edits, but do not treat test success as the only acceptance criterion.
- For UI work, require browser or screenshot verification across relevant viewports.
- For migrations, use a measurable completion bar: changed files, unchanged files, failing tests, skipped files, unresolved conflicts.
- For research, require source URLs, claim-level provenance, and a killed-claims section.
- For repeated workflows, save the script and diff changes before reuse.

Testing failure modes should be part of the workflow design:

- Empty input or malformed `args`.
- No matching files.
- Tool permission denied.
- Test command missing.
- Dependency install failure.
- Rate limit or model overload.
- Agent timeout.
- Partial success where some agents return usable output and others fail.

The output should say which of these happened. Silent partial success is the most dangerous workflow failure mode because a large agent run can create the impression of verification even when the verification phase did not actually run.

## Failure Modes

High-probability operational failures:

- Session loss: exiting Claude Code during a run forces the next session to start the workflow fresh.
- Permission stalls: agents pause on tool permission prompts, especially in Ask mode or sensitive repos.
- Runaway fan-out: a poorly written loop can spawn far more agents than intended until caps stop it.
- Token burn: broad prompts and high-effort models can consume plan usage quickly.
- Partial completion: some agents fail while the overall report still looks polished.
- Context drift: the supervising session may compact or lose early instructions.
- Source contamination: research agents can ingest prompt-injected web pages or untrusted repository content.
- Script opacity: if users do not inspect the generated JavaScript, they may not know what logic is coordinating the run.
- False confidence: multiple agents can independently repeat the same mistaken assumption if their prompts, sources, or tools overlap.
- Local resource contention: 16 concurrent agents can stress CPU, memory, file locks, package managers, and test databases.

Cloud-specific failures:

- Cloud sessions have resource ceilings. Anthropic currently documents approximate limits of 4 vCPUs, 16 GB RAM, and 30 GB disk for cloud sessions, subject to change.
- Setup hooks can add startup latency and may fail under restricted network settings.
- Network access may be None, Trusted, Full, or Custom, which affects package installs and external fetches.
- GitHub operations in Claude Code on the web go through a proxy and pushes are restricted to the current branch.

GitHub Actions-specific failures, if Workflows are wrapped in CI:

- Job-level `timeout-minutes` and workflow concurrency should be set to prevent long-running or overlapping automation.
- Use least-privilege GitHub workflow permissions.
- Avoid `pull_request_target` patterns that check out untrusted PR code into the workspace before running an agent with confidential configuration.
- Prefer short-lived credentials or workload identity federation over long-lived personal credentials.

## Security and Permissions

Anthropic's official security model is permission based:

- Claude Code is read-only by default.
- File edits, modifying Bash commands, tests, and many network actions require explicit permission.
- Allow rules auto-approve matching tools.
- Ask rules force a prompt.
- Deny rules prevent matching tools or remove an entire tool from Claude's context.
- Deny rules are evaluated before ask, and ask before allow.
- Permission rules are enforced by Claude Code, not by the model.

Workflow-specific implications:

- The workflow script itself does not directly use filesystem or shell access, but the agents it spawns can request those tools.
- Permission prompts can pause a workflow agent, so preflight permissions matter for unattended runs.
- `bypassPermissions` is dangerous for workflow runs because many agents can act in parallel. Anthropic says to use it only in isolated containers or VMs where Claude Code cannot cause damage.
- Plan mode is useful for reviewing a proposed workflow before disk changes.
- Managed settings can enforce organization-wide policy and disable Workflows entirely through `disableWorkflows`.
- `CLAUDE_CODE_DISABLE_WORKFLOWS=1` disables Workflows at startup.
- The Bash sandbox can enforce filesystem and network boundaries for Bash commands and child processes. Permissions control which tools Claude can call; sandboxing controls what Bash processes can touch at the OS level.

Data retention risk:

- Claude Code transcripts and history under `~/.claude/` are not encrypted at rest.
- If a tool reads `.env` or a command prints credentials, those values can be written into session JSONL.
- Use permission deny rules for credential files.
- For sensitive scripted runs, consider `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `--no-session-persistence` in non-interactive mode, or short retention settings.

Prompt injection risk:

- Workflows multiply exposure because many agents may read external pages, issues, PR comments, docs, and code.
- Do not process untrusted content with broad write permissions.
- For public GitHub automation, restrict actors and comments, sanitize external inputs, and keep workflow token scopes minimal.
- Prefer raw-source review before allowing external contributor content to steer a write-capable workflow.

## Optional persistent operating layer Path

Claude Code Workflows stand on their own as a bounded orchestration feature. Add persistent operating layer only when the user is running persistent operating layer or explicitly needs scheduled, multi-agent, bus-routed, approval-aware, memory-backed operations.

The optional distinction for persistent operating layer users:

- Claude Code Workflow: a high-throughput orchestration script inside a Claude Code session.
- persistent operating layer: a persistent operating layer for many agents, with daemon restart, memory, tasks, inbox, approvals, operator chat control, and cross-agent routing.

Optional positioning claims that hold up:

- Workflows are excellent for bounded jobs. persistent operating layer is better for ongoing operations.
- Workflows resume only inside the same session. persistent operating layer is designed around cold-start recovery from memory and daemon restart.
- Workflows coordinate subagents for one task. persistent operating layer coordinates a fleet across tasks, agents, users, and schedules.
- Workflows can be saved as reusable scripts. persistent operating layer can treat those scripts as skills or job primitives and wrap them with approvals, tasks, logs, and memory.
- Workflows reduce context pressure inside Claude Code. persistent operating layer reduces organizational memory loss across sessions and agents.
- Workflows need operator discipline around permissions and verification. persistent operating layer can encode that discipline as guardrails, approvals, heartbeat checks, and event logs.

Optional frame for persistent operating layer-aware users:

"Claude Workflows are the engine for a big job. persistent operating layer is the control tower that decides when jobs run, who owns them, what permissions they get, how failures surface, and what survives a restart."

Optional product implications:

- Add a `workflow-run` task type in persistent operating layer that tracks workflow name, args, model, max agents, start time, status, artifact paths, and verification result.
- Require a preflight checklist before launching broad Workflows: clean git state, permissions, budget, test command, expected artifacts, rollback path.
- Require workflow outputs to be ingested into memory or KB only after verifier pass.
- Use approvals for external writes, deployments, emails, GitHub PR creation, data deletion, or paid actions triggered by workflow agents.
- Treat Claude Code Workflows as an execution backend that persistent operating layer can supervise when the user wants that operating layer, not as a required part of workflow engineering.

## Recommended Operating Policy

For production-like use:

1. Run Workflows only from a clean worktree or an isolated worktree.
2. Start with a small-slice run.
3. Inspect the generated script before broad execution.
4. Set explicit max-agent and max-scope parameters in reusable workflows.
5. Use least-privilege permission rules and deny reads of confidential configuration.
6. Avoid `bypassPermissions` outside containers or VMs.
7. Split human-gated stages into separate workflows.
8. Capture artifacts to explicit paths.
9. Make verifier output mandatory.
10. Log result status as `passed`, `partial`, `failed`, or `blocked`, not just `done`.

## Primary Sources

- Anthropic Claude Code Dynamic Workflows docs: https://code.claude.com/docs/en/workflows
- Anthropic Claude Code security docs: https://code.claude.com/docs/en/security
- Anthropic Claude Code permissions docs: https://code.claude.com/docs/en/permissions
- Anthropic Claude Code sandboxing docs: https://code.claude.com/docs/en/sandboxing
- Anthropic Claude Code scheduled tasks docs: https://code.claude.com/docs/en/scheduled-tasks
- Anthropic Claude Code internals and context docs: https://code.claude.com/docs/en/how-claude-code-works
- Anthropic Claude Code `.claude` storage docs: https://code.claude.com/docs/en/claude-directory
- Anthropic Claude Code on the web docs: https://code.claude.com/docs/en/claude-code-on-the-web
- Anthropic Opus 4.8 announcement, including Dynamic Workflows launch framing: https://www.anthropic.com/news/claude-opus-4-8
- GitHub Actions workflow syntax, timeouts, permissions, and concurrency: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax and https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
