# Claude Code Workflows vs Skills vs Subagents vs MCP vs Slash Commands vs cortextOS Crons/Tasks

Date: 2026-06-29

## Executive Decision

Use the smallest primitive that owns the right part of the system:

- Use a slash command when a human wants an explicit in-session shortcut.
- Use a skill when an agent needs reusable procedural knowledge, references, scripts, or templates loaded on demand.
- Use a subagent when the work needs an isolated worker role, separate context, constrained tools, or a different model.
- Use a Claude Code dynamic workflow when the orchestration itself should live in rerunnable code and can fan out to many subagents.
- Use MCP when Claude needs live access to an external tool, database, API, resource, connector, or event channel.
- Use a cortextOS cron when the work must run unattended on this daemon across restarts.
- Use a cortextOS task when the work needs dashboard visibility, status, ownership, blocking, or completion accounting.

Most durable automations combine several primitives. For users running cortextOS, a durable operating pattern is:

`cortextOS cron -> tracked cortextOS task -> skill or workflow -> subagents as needed -> MCP/CLI tools for external systems -> task completion/event log`

## Comparison Matrix

| Primitive | Primary job | Trigger model | Who holds the plan | State and visibility | Best fit | Avoid when |
|---|---|---|---|---|---|---|
| Claude Code dynamic workflow | Rerunnable orchestration across many subagents | Explicit prompt such as "use a workflow", `ultracode`, saved workflow command, or bundled workflow such as `/deep-research` | JavaScript workflow script executed by the Claude Code workflow runtime | Workflow progress view, script variables, background run state in the session | Large audits, many-file migrations, cross-checked research, repeatable multi-agent quality gates | Small or sequential tasks, same-file edits, work where a simple skill or one subagent is enough |
| Skill | Reusable agent procedure and context package | Model-invoked when relevant, or explicit `/skill-name` | Claude follows the skill instructions; optional shell preprocessing and supporting files | Skill body loads only when used; supporting files remain on disk; optional forked subagent context | Repeated checklists, org procedures, local scripts, templates, domain rules, "how we do X" | Pure live data access, low-level API integration, one-off tasks, global always-on facts that belong in memory |
| Subagent | Isolated worker role | Claude delegates, user asks to use an agent, skill uses `context: fork`, or workflow spawns workers | Claude decides turn by turn inside a separate context window | Result returns to caller; custom definitions can constrain tools, model, permissions, memory, worktree isolation | Read-only exploration, code review, security review, independent implementation unit, evaluator role | Coordinating many peers, tasks requiring worker-to-worker discussion, or tightly coupled same-file changes |
| MCP | Tool/data/protocol integration | Claude uses exposed MCP tools/resources/prompts; user can manage with `/mcp` or `claude mcp` | External server owns tool semantics; Claude decides when to call tools | Server connection state in Claude Code; external system remains source of truth | Databases, SaaS apps, issue trackers, Figma, Slack, monitoring, resources, push channels | Encoding agent procedure, replacing skills, connecting untrusted prompt-injectable sources without guardrails |
| Slash command | Explicit session control or shortcut | Human types `/command` at the start of a message | Depends on command type: built-in CLI logic, bundled skill, bundled workflow, MCP prompt, or custom skill-backed command | Session-local UX; command registry shown by `/` | Fast manual invocation, setup, context management, skill/workflow entrypoint, debug actions | Unattended scheduling, durable cross-session automation, hidden behavior the user did not ask to run |
| cortextOS cron | Persistent unattended scheduling in the daemon | Daemon injects `[CRON FIRED ...] name: prompt` | Cron prompt plus the agent handling it | Registered in daemon cron state; fires across restarts; dashboard test-fire; must close loop with `update-cron-fire` | Heartbeats, recurring monitors, daily digests, scheduled research, periodic pipeline runs | Session-local `/loop` for persistent work, untracked tasks, one-shot jobs without self-removal |
| cortextOS task | Work tracking and coordination | Agent creates or updates through `cortextos bus` | Human or assigned agent owns execution; task record owns status | Dashboard-visible status: pending, in_progress, blocked, completed; supports assignee, priority, project | Any meaningful deliverable, blockers, human dependencies, approvals, cross-agent coordination | Replacing a procedure, storing long instructions, running work by itself |

## Key Distinctions

### Workflow vs Skill

Use a workflow when the loop, branching, fan-out, cross-checking, and intermediate results need to be codified and rerun. Official Claude Code docs describe dynamic workflows as JavaScript scripts that orchestrate subagents at scale, with the runtime executing the script in the background. They are meant for more agents than one conversation can coordinate, or when the orchestration itself should be readable and rerunnable.

Use a skill when the reusable asset is instruction, not orchestration code. Skills are folders with `SKILL.md` plus optional scripts, references, templates, and assets. Claude loads the full skill only when relevant or when invoked directly with `/skill-name`, which keeps large procedural context out of the main prompt until needed.

Decision rule:

- If the main reusable asset is "follow these steps with these references", make a skill.
- If the main reusable asset is "run this multi-agent algorithm with loops and quality checks", make a workflow.
- If a skill has grown into a fan-out controller that spawns many workers, migrates many files, or keeps intermediate tables of findings, promote the orchestration to a workflow and keep the domain rules in a skill.

### Skill vs Slash Command

Claude Code has largely converged custom commands and skills. A `.claude/commands/deploy.md` file and `.claude/skills/deploy/SKILL.md` can both create `/deploy`; skills add a directory, supporting files, frontmatter controls, model invocation, and optional subagent execution.

Decision rule:

- If a human must explicitly choose when to run it, expose it as a slash command.
- If Claude should discover and invoke it when relevant, make it a skill with a precise description.
- If it needs reference files, examples, templates, scripts, or assets, use a skill directory rather than a flat command file.
- If it is just a built-in session operation such as `/compact`, `/plan`, `/mcp`, `/agents`, or `/diff`, leave it as a command and do not wrap it.

### Skill vs MCP

MCP gives Claude access to external systems. Skills teach Claude how to use context and tools in a repeatable way. Anthropic's skills engineering post explicitly frames skills as complementary to MCP: MCP connects tools and data; skills encode complex workflows involving those tools.

Decision rule:

- If the agent lacks live capability, build or connect MCP.
- If the agent has the tool but keeps using it inconsistently, write a skill.
- If the workflow needs both, put the procedural policy in the skill and call the MCP tools from that procedure.

Example:

- Bad: "Make a Gmail MCP server that knows our customer follow-up policy."
- Better: "Use Gmail/Google Workspace MCP or CLI for access, and a follow-up skill for policy, templates, approval gates, and logging."

### Subagent vs Workflow

Subagents are workers. Workflows are orchestration. Claude Code's workflow docs define the core difference as who holds the plan: with subagents, Claude decides turn by turn and results land in context; with workflows, the script holds loops, branching, and intermediate results.

Decision rule:

- Use a subagent for one focused worker with a clear role.
- Use a few subagents when the main agent can coordinate them conversationally.
- Use a workflow when there are dozens to hundreds of agents, structured phases, retry/cross-check logic, or reusable fan-out.
- Use agent teams only when peer agents must communicate with one another. For this document, agent teams are adjacent to subagents and workflows, not a replacement for cortextOS fleet coordination.

### Subagent vs Skill

A skill answers "what procedure/context should the agent use?" A subagent answers "what isolated worker should do this?" They compose in both directions: a skill can run in a forked subagent context, and a subagent can preload skills.

Decision rule:

- Use a skill for repeatable instructions and resources.
- Use a subagent for isolation, separate context, different tool access, a different model, a reviewer/evaluator role, or background work.
- Use both when a reusable procedure should run isolated from the main conversation.

### Slash Command vs cortextOS Cron

A slash command is an in-session user interface. A cortextOS cron is daemon-owned scheduling. The local cron-management skill says daemon crons are stored in the agent's state directory, survive restarts, and should be managed with `cortextos bus add-cron`, `update-cron`, `remove-cron`, and `list-crons`. Session-local schedulers die when the process dies.

Decision rule:

- Use a slash command for "run this now".
- Use a cortextOS cron for "run this later or repeatedly even if I am away".
- If a cron prompt becomes long or fragile, move the procedure into a skill or script and let the cron invoke that stable entrypoint.
- Always close a recurring cron fire with `cortextos bus update-cron-fire <name> --interval <interval>` when the local cron protocol requires it.

### cortextOS Task vs Everything Else

A cortextOS task is not an execution primitive. It is the coordination and accountability record. The local task skill says every meaningful deliverable should have a task so the dashboard can show status, blockers, priority, and completion.

Decision rule:

- Create a task for significant work, especially anything over about 10 minutes, cross-agent, human-dependent, approval-gated, or deliverable-producing.
- Do not use tasks as hidden instruction storage. Put procedures in skills, scripts, workflows, or docs.
- Do not run recurring work from tasks alone. Use crons for time and tasks for tracked execution.

## When-To-Use Rules

### Use Claude Code dynamic workflows when:

- The work needs many independent agents or phases.
- The orchestration should be repeatable, inspectable, and saved.
- Intermediate results should live in script variables rather than bloating the conversation context.
- You need cross-checking, voting, adversarial review, or multi-angle research.
- The task is a codebase audit, large migration, broad refactor, or deep research report.

Do not use a workflow just because the task feels important. Use it when the shape of the work needs coded orchestration.

### Use skills when:

- You keep pasting the same checklist, rubric, prompt, or procedure.
- A section of `CLAUDE.md` has become a procedure rather than a fact.
- The agent needs local references, examples, templates, scripts, or assets.
- The procedure should be shareable, version-controlled, or reusable by multiple agents.
- The prompt should be available both by explicit command and by model invocation.

Good skill boundaries:

- One clear capability per skill.
- Precise description that controls when it triggers.
- Short `SKILL.md` with references loaded only as needed.
- Scripts for deterministic or repetitive substeps.
- Explicit approval and external-action gates inside the procedure.

### Use subagents when:

- You need context isolation, such as research output that should not fill the main context.
- You need a specialized worker role, such as `safe-researcher`, `security-reviewer`, `test-runner`, or `frontend-evaluator`.
- You want restricted tools, read-only behavior, a different model, a turn limit, background mode, or worktree isolation.
- You want the main agent to continue while a worker investigates or implements a bounded unit.

Prefer subagents for reviewer/evaluator separation. The agent that wrote the code should not be the only one judging whether it is correct.

### Use MCP when:

- Claude needs to read or write an external system directly.
- You are copying data from another app into chat and want that to become tool access.
- The source of truth is outside the repo, such as Linear, GitHub, Slack, Notion, Sentry, Postgres, Figma, Gmail, or a proprietary internal system.
- You need resources, prompts, tools, or push channels exposed through a standard protocol.

MCP is infrastructure. Keep business rules, editorial standards, and workflow policy in skills or repo docs unless the external service itself owns those rules.

### Use slash commands when:

- The user needs a memorable manual entrypoint.
- The action is session control, setup, inspection, or debugging.
- The command wraps a skill or saved workflow that should be manually invoked.
- The command should accept positional arguments such as `/fix-issue 123`.

Slash commands should be obvious, explicit, and low-surprise. If the user would be surprised that it ran automatically, it should not be model-invoked.

### Use cortextOS crons when:

- The work must run on a schedule from the daemon.
- It must survive hard restarts, context compaction, and daemon restarts.
- The workflow is operational: heartbeat, digest, monitor, scrape, report, recurring cleanup, or once-at-a-time reminder.
- The prompt can be safely injected later and treated like a user request.

For this data-codex agent, current cron patterns include heartbeat, GitHub trending feed, research digest, YouTube monitoring, short-form monitoring, weekly trends, experiment evaluation, broadcast scraper, daily signal pipeline, and nightly topic briefing.

### Use cortextOS tasks when:

- There is a meaningful deliverable.
- The user, dashboard, or another agent needs to know status.
- The work can block or be blocked.
- A human task or approval must be represented.
- Completion needs a result summary and event log.

Tasks are the "work ledger" for cortextOS. They should surround substantial runs of the other primitives.

## Anti-Patterns

| Anti-pattern | Why it fails | Better pattern |
|---|---|---|
| Huge `CLAUDE.md` with every procedure | Always consumes context and mixes facts with workflows | Move procedures into skills; keep stable facts in memory/docs |
| Skill as a database connector | Skills do not provide live system access by themselves | MCP or CLI for access, skill for policy |
| MCP as a workflow brain | MCP tools expose capabilities, but they should not hide agent procedure and approval logic | Skill or workflow orchestrates MCP calls |
| Slash command as persistent scheduler | Commands only run when invoked in a session | cortextOS daemon cron, or Claude Code routines when cloud execution is desired |
| `/loop` for daemon-critical work | Session-local loops can die on restart and silently drop work | cortextOS cron registered through the bus |
| Cron prompt with hundreds of lines | Hard to maintain, hard to test, easy to drift | Cron invokes a skill or script entrypoint |
| Cron fire without closure | Daemon cannot distinguish handled work from stuck work | Call `update-cron-fire` after successful recurring cron handling |
| Editing `config.json.crons[]` and expecting hot reload | Local cron docs say mid-session changes must use bus cron commands | Use `add-cron`, `update-cron`, `remove-cron`, then confirm with `list-crons` |
| Task used as a procedure document | Tasks track work; they do not execute or encode reusable behavior | Skill/workflow/script for procedure, task for status |
| Subagents for tightly coupled same-file edits | Coordination overhead and merge conflict risk | Single main session, or worktree-isolated units only if separable |
| Workflow for a one-worker job | More token/time overhead than benefit | Skill, subagent, or direct prompt |
| Skill that triggers too broadly | Claude loads or uses it at the wrong time | Narrow the description, add path filters, or disable model invocation |
| External action hidden inside reusable automation | Risky actions need approval and auditability | Add approval gate, task blocker, and explicit external-comms/deployment/data-deletion category |
| Tooling choice before trigger choice | Leads to overbuilt or fragile automations | First decide manual vs automatic vs external-event vs tracked work |

## Migration Heuristics

### Prompt to Skill

Migrate when:

- The same prompt/procedure has been used 3 or more times.
- The prompt includes a checklist, rubric, file paths, examples, or a sequence of commands.
- The procedure is useful across sessions or agents.

Keep as a prompt when:

- It is a one-off exploration.
- The instructions depend on transient context that will not recur.

### Command to Skill

Migrate a flat `.claude/commands/*.md` command to `.claude/skills/<name>/SKILL.md` when:

- It needs supporting files, references, templates, assets, scripts, or examples.
- Claude should be allowed to auto-invoke it.
- It should run in a forked subagent context.
- It needs frontmatter controls such as allowed tools, model, effort, hooks, path filters, or invocation restrictions.

Keep as a simple command when:

- It is only a manual shortcut with a short prompt and `$ARGUMENTS`.

### Skill to Workflow

Promote when:

- The skill has become an orchestrator rather than instructions.
- It spawns many subagents or repeats the same fan-out/cross-check pattern.
- Intermediate findings exceed what should live in context.
- You want the same orchestration to run with stable phases and inspectable script logic.

Keep as a skill when:

- The agent can simply follow steps.
- The number of workers is small.
- The procedure is mostly policy, examples, or tool usage guidance.

### Subagent to Workflow

Promote when:

- The main agent is repeatedly coordinating multiple subagents in the same pattern.
- The work needs phase gates, retries, aggregation, voting, or adversarial review.
- The worker count is larger than a conversation can manage cleanly.

Keep as subagents when:

- There are only one to a few bounded workers.
- Each worker just reports back to the main agent.

### External Copy/Paste to MCP

Migrate when:

- The agent repeatedly asks the user to paste data from the same external system.
- The task requires fresh external state.
- The agent must act in the external system, not just reason over exported text.

Do not migrate when:

- Static exports are sufficient.
- The server would expose high-risk data without clear permissions, logging, or prompt-injection mitigations.

### Manual Run to cortextOS Cron

Migrate when:

- The same command or workflow is run on a predictable cadence.
- Missing the run has operational consequences.
- It should happen while the user is away.
- It needs daemon persistence and dashboard test-fire.

Implementation pattern:

1. Put the real procedure in a skill or script.
2. Register a cortextOS cron that invokes that entrypoint.
3. Create/update a task when the cron run starts if there is a meaningful deliverable.
4. Close the cron fire and complete the task with a result summary.

### Cron Prompt to Skill or Script

Migrate when:

- The cron prompt has branching logic.
- It repeats paths, command sequences, or reporting formats.
- It is hard to test outside the scheduler.
- Multiple crons need the same behavior.

Use a script for deterministic data movement. Use a skill when judgment, source synthesis, or agentic procedure matters. Use both when the skill calls deterministic scripts.

### Untracked Work to cortextOS Task

Migrate when:

- The work takes more than about 10 minutes.
- Another agent or human cares about status.
- There is a deliverable path.
- There is a blocker or approval.
- Completion should appear in the dashboard and activity feed.

## Practical Composition Patterns

### Scheduled Research Digest

Use:

- cortextOS cron for schedule
- cortextOS task for tracked run
- skill for digest procedure and formatting
- MCP/CLI/web tools for source access
- subagents for independent research lanes
- workflow only if cross-checking many sources or claims at scale

### Codebase-Wide Migration

Use:

- slash command or prompt to start
- dynamic workflow for fan-out across modules/worktrees
- subagents for implementation units and reviewers
- skill for project migration rules
- cortextOS task if this is part of the daemon's tracked work

### External App Automation

Use:

- MCP for the external app connection
- skill for policy, templates, approvals, and logging
- subagent for read-only review or preparation
- cortextOS task for visible work status
- approval before irreversible external action

### Nightly Monitoring Pipeline

Use:

- cortextOS cron as the scheduler
- script for deterministic scraping/scoring
- skill for interpretation and routing
- task for visible pipeline run
- KB ingest for durable output
- bus message to downstream agents

## Source Notes

Primary/official sources used:

- Claude Code skills docs: skills are `SKILL.md` files, can be model-invoked or invoked with `/skill-name`, load only when used, and custom commands have merged into skills. https://code.claude.com/docs/en/skills
- Agent Skills standard: a skill is a folder with `SKILL.md`, optional scripts/references/assets, progressive discovery, activation, and execution. https://agentskills.io/home
- Claude Code dynamic workflows docs: workflows are JavaScript scripts that orchestrate subagents at scale, keep intermediate results in script variables, and can be saved as commands. https://code.claude.com/docs/en/workflows
- Claude Code subagents docs: subagents are Markdown/YAML definitions with tool, model, permission, memory, background, and isolation controls. https://code.claude.com/docs/en/sub-agents
- Claude Code MCP docs: MCP connects Claude Code to external tools, data sources, APIs, resources, prompts, and event channels, with trust and prompt-injection considerations. https://code.claude.com/docs/en/mcp
- MCP official intro: MCP is an open standard for connecting AI applications to external systems. https://modelcontextprotocol.io/docs/getting-started/intro
- Claude Code commands docs: slash commands control sessions, can be built-in commands, bundled skills, bundled workflows, or MCP prompts. https://code.claude.com/docs/en/commands
- Claude Code routines docs, for boundary only: routines are Anthropic-managed scheduled/API/GitHub-triggered cloud runs; cortextOS crons are the local daemon-owned equivalent in this environment. https://code.claude.com/docs/en/routines

Local cortextOS sources used:

- `TOOLS.md`: bus command index for tasks, crons-related workflows, messages, heartbeats, approvals, KB, and worker sessions.
- `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`: tasks provide dashboard-visible lifecycle tracking for meaningful work.
- `plugins/cortextos-agent-skills/skills/cron-management/SKILL.md`: daemon-managed crons live in the agent state directory, survive restarts, and are managed with bus cron commands.
- `config.json`: data-codex currently uses recurring and crontab schedules for heartbeat, monitoring, research digests, and signal pipelines.
