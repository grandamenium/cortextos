# Claude Code Workflows: Official Feature Surface and Terminology

Date: 2026-06-29

Scope: current official and primary-source terminology for Claude Code "workflows", with boundaries against adjacent automation features. This is written for research agent research use, not as implementation guidance for a specific repo.

## Executive summary

The official first-class feature is called "dynamic workflows", surfaced in the Claude Code docs under "Orchestrate subagents at scale with dynamic workflows". A dynamic workflow is not just a recommended prompt pattern. It is a JavaScript orchestration script that Claude writes for a task, then a workflow runtime executes in the background while the main session remains responsive. The workflow script coordinates subagents, stores intermediate results in script variables, and returns a final result to the conversation.

Official docs use "workflow" in several different ways, so terminology discipline matters:

- "Dynamic workflows" are the concrete Claude Code feature for scripted multi-agent orchestration.
- "Common workflows" are documentation recipes and prompt patterns, not a runtime feature.
- "GitHub Actions workflows" are GitHub CI YAML workflows that can run Claude Code through the `anthropics/claude-code-action`.
- "Routines" are saved cloud automations that run Claude Code on Anthropic-managed infrastructure on schedule, API, or GitHub triggers. They are related to automation but not the same feature as dynamic workflows.
- "Desktop scheduled tasks" and `/loop` are scheduling features, not dynamic workflows.
- "Skills" can encode repeatable instructions or invocable workflows in the generic sense, but they are prompt/instruction units, not the dynamic workflow runtime.
- "Hooks" are lifecycle-triggered commands, HTTP calls, LLM prompts, or subagents. They enforce deterministic or event-driven behavior around a session, not scripted multi-agent orchestration.
- "Agent teams" are independent Claude Code sessions coordinated by a lead session. They are experimental and disabled by default. They are adjacent to workflows because both support parallel work, but workflows put the plan in a script.

For research agent, use "dynamic workflow" when referring to Claude Code's scripted multi-agent orchestration feature. Use "routine" for Anthropic-managed, triggerable cloud automations. Use "scheduled task" or `/loop` for scheduling. Use "workflow" alone only when the context clearly means the dynamic workflow runtime or when quoting official wording.

## Primary source set

Official Anthropic or primary sources used:

- Dynamic workflows docs: https://code.claude.com/docs/en/workflows
- Claude Code docs map, last updated 2026-06-26 22:35:41 UTC: https://code.claude.com/docs/en/claude_code_docs_map
- Model configuration and `ultracode`: https://code.claude.com/docs/en/model-config
- Skills docs: https://code.claude.com/docs/en/skills
- Settings docs, including `disableWorkflows` and `disableBundledSkills`: https://code.claude.com/docs/en/settings
- Subagents docs: https://code.claude.com/docs/en/sub-agents
- Agent teams docs: https://code.claude.com/docs/en/agent-teams
- Hooks guide: https://code.claude.com/docs/en/hooks-guide
- Hooks reference: https://code.claude.com/docs/en/hooks
- Common workflows docs: https://code.claude.com/docs/en/common-workflows
- Routines docs: https://code.claude.com/docs/en/routines
- In-session scheduled tasks and `/loop`: https://code.claude.com/docs/en/scheduled-tasks
- Desktop scheduled tasks: https://code.claude.com/docs/en/desktop-scheduled-tasks
- Claude Code GitHub Actions docs: https://code.claude.com/docs/en/github-actions
- Official Claude Code Action repository: https://github.com/anthropics/claude-code-action
- Managed Code Review docs: https://code.claude.com/docs/en/code-review

## Official feature: dynamic workflows

The dynamic workflows page defines the feature as a way to "orchestrate many subagents from a script Claude writes and you can rerun." The core official definition is:

- A dynamic workflow is a JavaScript script.
- Claude writes the script for the described task.
- A runtime executes the script in the background.
- The script orchestrates subagents at scale.
- The main session remains responsive while the run is active.
- The resulting orchestration is readable and rerunnable.

Official positioning: dynamic workflows are for codebase audits, large migrations, cross-checked research, and other tasks where many agents or repeatable orchestration add value. Examples in the docs include a codebase-wide bug sweep, a 500-file migration, research that needs cross-checking across sources, and hard planning from multiple independent angles.

Availability and requirements:

- Requires Claude Code v2.1.154 or later.
- Available on all paid plans.
- Available with Anthropic API access.
- Available on Amazon Bedrock, Google Cloud Vertex AI, and Microsoft Foundry.
- On Pro, users must turn workflows on from the Dynamic workflows row in `/config`.
- Workflows are available in the CLI, Desktop app, IDE extensions, non-interactive mode with `claude -p`, and the Agent SDK.

Official command surface:

- `/deep-research <question>`: bundled workflow for multi-source research. It fans out web searches across angles, fetches and cross-checks sources, votes on claims, and returns a cited report. It requires the WebSearch tool.
- `/workflows`: lists running and completed workflows, opens the progress view, and supports run controls.
- `/effort ultracode`: enables an effort setting that combines `xhigh` reasoning with automatic workflow orchestration for substantive tasks.

Official trigger surface:

- User asks directly for a workflow in natural language, such as "use a workflow" or "run a workflow".
- User includes the keyword `ultracode` in a prompt to run a single task as a workflow without changing session effort.
- User sets `/effort ultracode`, letting Claude decide when a task warrants a workflow.
- User runs a bundled workflow such as `/deep-research`.
- User runs a saved workflow command.

Version terminology note:

- Before v2.1.160, the literal trigger keyword was `workflow`.
- Current docs say natural-language workflow requests work in both old and current versions, while `ultracode` is now the documented keyword for direct workflow triggering.

## Lifecycle

The official lifecycle is:

1. User requests a workflow, enables `ultracode`, or runs a workflow command.
2. Claude writes or selects a workflow script.
3. Claude Code presents a launch approval prompt when applicable.
4. The workflow runtime executes the script in an isolated environment.
5. The workflow spawns subagents according to the script.
6. Intermediate results stay in script variables rather than being inserted into the main conversation context.
7. The user monitors progress through `/workflows` or the task panel.
8. The user can pause, resume, stop, restart selected agents, or save a run's script as a command.
9. On completion, the final report or result lands in the session.

Approval model:

- In the CLI, the per-run prompt shows the planned phases.
- CLI options include "Yes, run it", "Yes, and don't ask again for `<name>` in `<path>`", "View raw script", and "No".
- `Ctrl+G` opens the script in an editor.
- `Tab` lets the user adjust the prompt before the run starts.
- In Default and accept edits permission modes, the user is prompted every run unless they previously selected the per-project "don't ask again" option.
- In Auto mode, the first launch prompts. Later launches can start without prompting after consent is recorded, and the prompt is skipped when `ultracode` is on.
- In bypass permissions, `claude -p`, and Agent SDK contexts, the run starts immediately.
- Desktop shows an approval card with the workflow name, phase list, usage caution, and Once, Always, and Deny actions.

Runtime behavior:

- Each run writes its script to a file under the session directory in `~/.claude/projects/`.
- Claude receives the path when the run starts, so the user can ask for it.
- The runtime tracks each agent's result as the run progresses.
- This tracking makes a run resumable within the same session.
- If Claude Code exits while a workflow is running, the next session starts the workflow fresh rather than resuming the previous run.

Monitoring and controls:

- `/workflows` lists running and completed workflows.
- The progress view shows phases, agent counts, usage totals, and elapsed time.
- The user can drill into phases and agents to read prompts, recent tool calls, and results.
- Controls include pause/resume, stop selected agent or whole workflow, restart selected running agent, filter agent list by status, and save the run's script as a command.

Saving and reuse:

- A successful workflow run can be saved as a command.
- Save locations are `.claude/workflows/` for project-shared workflows and `~/.claude/workflows/` for personal workflows.
- The saved workflow runs as `/<name>` in future sessions.
- In a monorepo, project workflows load from every `.claude/workflows/` along the path from working directory to repo root.
- If duplicate names exist, the closest project workflow wins. If a project workflow and personal workflow share a name, the project workflow wins.
- As of v2.1.178, saving to project location writes to the closest `.claude/workflows/` directory already present between the current directory and repo root, or to repo root if none exists.

Inputs:

- A saved workflow can accept an `args` parameter.
- The script reads this as a global variable named `args`.
- Claude passes structured data where possible, so the script can use array and object methods directly.
- If omitted, `args` is `undefined`.

## Exact official terms and recommended research agent usage

Use these terms precisely:

- "dynamic workflow": the first-class scripted orchestration feature.
- "workflow script": the JavaScript script Claude writes or loads.
- "workflow runtime": the engine that executes the script outside the main conversation.
- "run": one execution of a workflow script.
- "phase": a workflow progress grouping shown in `/workflows`.
- "agent" or "subagent": the workers spawned by the workflow. The workflow script coordinates them.
- "bundled workflow": a workflow shipped with Claude Code. Current official example: `/deep-research`.
- "saved workflow": a workflow script saved as a command in `.claude/workflows/` or `~/.claude/workflows/`.
- "`/workflows`": the management and progress UI command.
- "`ultracode`": a Claude Code setting and prompt keyword associated with workflow orchestration and `xhigh` effort.
- "routine": a saved cloud automation with prompt, repository selection, connectors, and triggers. Do not call this a dynamic workflow.
- "scheduled task": a Desktop or in-session scheduling construct. Do not call this a dynamic workflow.
- "hook": lifecycle-triggered automation. Do not call this a workflow unless describing what the hook runs.
- "skill": on-demand instructions and supporting files. Skills can encode repeatable workflows in the everyday sense, but are not dynamic workflows unless they invoke or instruct use of dynamic workflows.

Avoid these terms unless quoting:

- "Claude Code Workflows" as a product name. The official docs page title uses "dynamic workflows", and the docs navigation says "Dynamic workflows".
- "workflow engine" if referring to Routines, GitHub Actions, scheduled tasks, or hooks. These are different engines.
- "background agent" as a synonym for workflow. A workflow can run background agents, but the workflow is the script and runtime orchestration.

## Boundaries against adjacent Claude Code features

### Common workflows

"Common workflows" are official docs recipes for everyday tasks: exploring codebases, fixing bugs, refactoring, testing, creating pull requests, documentation, working with images, references, scheduling, resuming conversations, worktrees, planning before editing, delegating research to subagents, and piping Claude into scripts.

Boundary: these are usage patterns, not the dynamic workflow runtime. They are still "workflows" in ordinary documentation language, but research agent should not treat them as a first-class workflow object.

### Skills

Skills are `SKILL.md` files with instructions and optional supporting files. Claude loads a skill when relevant or when invoked directly with `/<skill-name>`. Official docs say skills are for repeatable instructions, reference material, and multi-step procedures. Custom commands have been merged into skills: `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy`.

Boundary: skills are prompt/instruction packages. They can describe a workflow or trigger a command, but they do not inherently run the dynamic workflow runtime. A saved dynamic workflow also becomes a slash command, but its storage and runtime are under `.claude/workflows/` or `~/.claude/workflows/`, not `.claude/skills/`.

### Subagents

Subagents are specialized AI assistants with their own context windows, system prompts, tools, and permissions. Claude delegates a focused task to a subagent and receives a result summary.

Boundary: subagents are the worker primitive. Dynamic workflows orchestrate many subagents from a script. A subagent by itself does not provide scripted loops, branching, resumable run state, or saved workflow commands.

### Agent teams

Agent teams coordinate multiple Claude Code instances. A main session acts as the team lead, teammates work independently, and the team uses shared tasks and inter-agent messaging. Agent teams are experimental and disabled by default behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.

Boundary: agent teams are lead-agent orchestration across independent Claude Code sessions. Dynamic workflows move orchestration into a JavaScript script. Official docs compare them directly: agent teams have a lead agent deciding turn by turn, while workflows have a script deciding what runs next.

Current agent team limitations matter when comparing:

- No session resumption with in-process teammates.
- Task status can lag.
- Shutdown can be slow.
- One team per session.
- No nested teams.
- Lead is fixed.
- Per-teammate permissions cannot be set at spawn time.
- Split panes require tmux or iTerm2 and are not supported in VS Code integrated terminal, Windows Terminal, or Ghostty.

### Hooks

Hooks are user-defined shell commands, HTTP endpoints, LLM prompts, or subagents that execute automatically at lifecycle events. Official docs describe events across session, turn, tool-call, task, worktree, compaction, file, config, and display lifecycles.

Boundary: hooks are event-driven automation. They are best for deterministic enforcement, notifications, logging, and validation. Dynamic workflows are task level multi-agent orchestration. A hook can launch something or block an action, but it is not itself the workflow runtime.

Important lifecycle overlap:

- Hooks can observe task events such as `TaskCreated` and `TaskCompleted`.
- Hooks can enforce rules around tool calls, file edits, and session boundaries.
- Workflow-spawned subagents still interact with permissions and tool allowlists.

### Routines

Routines are cloud automations for Claude Code on the web. Official docs define a routine as a saved Claude Code configuration: prompt, one or more repositories, and connectors, packaged once and run automatically. Routines run on Anthropic-managed cloud infrastructure and continue when the user's laptop is closed.

Routine trigger types:

- Scheduled: recurring cadence or one-off future time.
- API: HTTP POST to a per-routine endpoint.
- GitHub: repository events such as pull requests or releases.

Routine management:

- Created and managed at `claude.ai/code/routines`.
- Can also be created from CLI with `/schedule` for scheduled routines only.
- CLI can list, update, or run existing routines.
- API and GitHub triggers are configured from the web UI only.

Routine limitations and preview status:

- Routines are in research preview.
- Behavior, limits, and API surface may change.
- The `/fire` endpoint is under the beta header `experimental-cc-routine-2026-04-01`.
- Request and response shapes, rate limits, and usage semantics may change.
- `/fire` is available to claude.ai users only and is not part of the Claude Platform API surface.
- GitHub trigger events are subject to hourly per-routine and per-account caps during research preview.
- GitHub triggers require installing the Claude GitHub App. Running `/web-setup` grants repository cloning access but does not install the app or enable webhook delivery.

Boundary: routines are triggerable cloud sessions. They may run Claude Code work that includes normal tasks, and potentially work that asks for a dynamic workflow, but the routine itself is not a dynamic workflow script.

### In-session scheduled tasks and `/loop`

The scheduled tasks docs cover local prompts on a schedule inside an open Claude Code session. Under the hood, Claude uses:

- `CronCreate`
- `CronList`
- `CronDelete`

Official constraints:

- A session can hold up to 50 scheduled tasks.
- Scheduled prompts fire between turns, not while Claude is mid-response.
- Times are interpreted in local timezone.
- Recurring tasks have deterministic jitter.
- Recurring tasks expire after 7 days.
- For durable scheduling, official docs point users to Routines or Desktop scheduled tasks.

Boundary: `/loop` and scheduled prompts are session-scoped scheduling tools. They do not create a dynamic workflow script or background workflow runtime.

### Desktop scheduled tasks

Desktop scheduled tasks create new Claude Code Desktop sessions automatically at selected times and frequencies. A local task runs on the user's machine with direct access to local files and tools.

Official constraints:

- Tasks only run while the Desktop app is running and the computer is awake.
- If the computer sleeps through a scheduled time, the run is skipped.
- On wake/start, Desktop checks for missed runs in the last seven days and starts exactly one catch-up run for the most recently missed time.
- Each task has its own permission mode.
- Ask mode tasks can stall until the user approves a needed tool.

Boundary: Desktop scheduled tasks are local scheduled session starts. Routines are remote durable scheduled or triggerable cloud sessions. Dynamic workflows are in-session scripted multi-agent orchestration.

### GitHub Actions

Claude Code GitHub Actions integrates Claude Code into GitHub Actions workflows. Official docs say the action can run Claude Code within GitHub Actions workflows and can be used to build custom workflows on top of Claude Code. The official repo describes it as a general-purpose action for GitHub PRs and issues that answers questions and implements code changes.

Feature surface from official docs and repo:

- `@claude` mention support for PRs and issues.
- Workflow-context mode detection.
- Issue and PR interaction.
- Code implementation and PR creation.
- Code review use cases.
- Structured outputs that become GitHub Action outputs.
- Runs on the user's GitHub runner infrastructure.
- Supports Anthropic direct API, workload identity federation, Amazon Bedrock, Google Vertex AI, and Microsoft Foundry.

Key inputs:

- `prompt`
- `claude_args`
- `plugin_marketplaces`
- `plugins`
- `anthropic_provider_config`
- `github_provider_config`
- `trigger_phrase`
- `use_bedrock`
- `use_vertex`

Boundary: GitHub Actions workflows are GitHub's CI/CD workflow files. They can run Claude Code and can ask it to do automation. They are not the Claude Code dynamic workflow runtime unless the Claude Code process they launch uses dynamic workflows.

### Managed Code Review

Code Review is a managed research-preview service for Team and Enterprise subscriptions. It analyzes GitHub pull requests with multi-agent analysis on Anthropic infrastructure and posts inline comments. It is not available for organizations with Zero Data Retention enabled.

Official behavior:

- Triggered on PR open, every push, or manual commands depending on repo configuration.
- Manual commands are `@claude review` and `@claude review once`.
- Multiple specialized agents analyze the diff and surrounding code in parallel.
- A verification step filters false positives.
- Results are deduplicated, severity-ranked, and posted inline where possible.
- Check runs complete with neutral conclusion, so Code Review does not block merging by default.

Boundary: managed Code Review is a productized review service. It uses multi-agent analysis, but it is not the general dynamic workflows feature. Local `/code-review` and `/code-review ultra` are commands in Claude Code with related review behavior.

## Current limitations and constraints

Dynamic workflow limitations:

- No mid-run user input. Only agent permission prompts can pause a run.
- No direct filesystem or shell access from the workflow script itself. Agents read, write, and run commands. The script coordinates agents.
- Up to 16 concurrent agents, fewer on machines with limited CPU cores.
- 1,000 agents total per run.
- Resume works only within the same Claude Code session.
- If Claude Code exits while a workflow runs, the next session starts the workflow fresh.
- Workflow subagents always run in `acceptEdits` mode and inherit the user's tool allowlist, regardless of the main session's mode.
- File edits are auto-approved for workflow subagents.
- Shell commands, web fetches, and MCP tools not in the allowlist can still prompt mid-run.
- In `claude -p` and Agent SDK contexts there is no interactive user to prompt, so tool calls follow configured permission rules without interactive confirmation.
- Workflows can use meaningfully more model budget than ordinary conversational work.
- Cost is bounded by concurrency and total-agent caps, but large workflows should be tested on a small slice first.
- Every agent in a workflow uses the session model unless the script routes a stage to a different model.
- `/deep-research` requires WebSearch to be available.

Control and disablement:

- Users can disable workflows from `/config` by toggling Dynamic workflows off.
- Users can set `"disableWorkflows": true` in `~/.claude/settings.json`.
- Users can set `CLAUDE_CODE_DISABLE_WORKFLOWS=1` before startup.
- Organizations can set `"disableWorkflows": true` in managed settings or use the Claude Code admin settings page.
- When workflows are disabled, bundled workflow commands are unavailable, `ultracode` no longer triggers a run, and `ultracode` is removed from `/effort`.

Routines limitations:

- Research preview.
- API `/fire` beta header required.
- API surface may change.
- `/fire` is for claude.ai users only and is not part of the Claude Platform API surface.
- CLI `/schedule` creates scheduled routines only. API and GitHub triggers require web configuration.
- GitHub trigger caps can drop events during preview.
- GitHub triggers require Claude GitHub App installation.

Scheduling limitations:

- In-session scheduled tasks are session-bound and recurring tasks expire after 7 days.
- Desktop scheduled tasks require the app to be open and the computer awake, except for a single catch-up run on wake/start.
- Ask mode scheduled tasks can stall on permissions.

Agent team limitations:

- Experimental and disabled by default.
- Known issues around resumption, task status, shutdown, one-team-per-session, no nested teams, fixed lead, spawn-time permissions, and split-pane support.

Managed Code Review limitations:

- Research preview.
- Team and Enterprise only.
- Not available with Zero Data Retention.
- Reviews are best effort.
- Failed reviews do not retry automatically.
- Check run conclusion is neutral by default, so teams must parse check output themselves if they want gating.
- Pricing is usage-based and can average $15-25 per review, scaling with PR size and complexity.

## Implications for research agent naming and modeling

Recommended internal ontology:

- `dynamic_workflow`: Claude Code scripted multi-agent orchestration.
- `workflow_run`: one execution of a dynamic workflow.
- `workflow_script`: JavaScript orchestration artifact.
- `workflow_phase`: progress grouping in a run.
- `workflow_agent`: subagent instance spawned by a workflow.
- `saved_workflow_command`: command backed by a saved script in `.claude/workflows/` or `~/.claude/workflows/`.
- `routine`: Anthropic-managed cloud automation with prompt, repositories, connectors, and triggers.
- `desktop_scheduled_task`: local Desktop app recurring task.
- `session_scheduled_task`: in-session cron or `/loop` scheduled prompt.
- `github_actions_integration`: GitHub Actions YAML using `anthropics/claude-code-action`.
- `managed_code_review`: Claude Code Review service for PR analysis.
- `skill`: on-demand instruction and asset package.
- `hook`: lifecycle-event automation.
- `subagent`: isolated worker inside a session.
- `agent_team`: experimental group of independent Claude Code sessions coordinated by a lead.

Recommended phrase policy:

- Say "dynamic workflows" for the official feature.
- Say "saved workflows" only for scripts saved under `.claude/workflows/` or `~/.claude/workflows/`.
- Say "routine" for cloud scheduled/API/GitHub-triggered automation.
- Say "GitHub Actions workflow" when referring to YAML running Claude Code in CI.
- Say "common workflow" only for docs recipes.
- Avoid "workflow" alone in database schema, task labels, or briefs unless a surrounding namespace disambiguates it.

## Open questions to track

The official surface is moving quickly. These items should be rechecked before building long-lived automation around it:

- Whether dynamic workflows remain under the same availability rules after research-preview adjacent features graduate.
- Whether `ultracode` remains the primary keyword and session setting for workflow orchestration.
- Whether the workflow runtime adds direct non-agent capabilities or changes the no direct filesystem/shell constraint.
- Whether resume behavior expands across sessions.
- Whether the 16 concurrent agents and 1,000 total agents caps change.
- Whether Routines `/fire` leaves the beta header and becomes part of a broader official API surface.
- Whether agent teams graduate from experimental status and how that changes boundaries with workflows.

## Bottom line

The safest official framing is:

Dynamic workflows are Claude Code's scripted multi-subagent orchestration feature. They are best understood as a background runtime for JavaScript plans written by Claude, with monitoring through `/workflows`, optional saving as slash commands, and strict limits around user input, tool access, concurrency, total agents, and session-scoped resume.

Routines, scheduled tasks, hooks, skills, GitHub Actions, Code Review, subagents, and agent teams all sit nearby, but each has a separate official meaning. For research agent, model them as adjacent automation primitives rather than collapsing them into a single "workflow" bucket.
