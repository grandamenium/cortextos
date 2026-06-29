# Agentic Loop Repo From The 31-Pack: Loop Engineering To Claude Code Workflows

Date: 2026-06-29

Scope: locate the agentic-loop related repo/topic in the stored 31-pack materials, explain the repo's ideas, and connect them to Claude Code Dynamic Workflows.

## Bottom Line

The relevant 31-pack thread is the "Agent Loop Starter Kit" cluster, especially rows 10, 11, 12, 13, and 15. The main repository is `cobusgreyling/loop-engineering`, mapped in the production plan as the `LOOP` comment-keyword deliverable.

The topic is not "better prompts." It is loop engineering: designing a repeatable control system that prompts agents, preserves state, checks work, enforces stop conditions, and hands off risky decisions. Claude Code Dynamic Workflows are a strong runtime match because they move orchestration into a reusable JavaScript workflow script, coordinate subagents, keep intermediate results out of chat, and can be saved under `.claude/workflows/`.

The connection to make in a Claude Code Workflows piece:

```text
Loop engineering defines the operating loop.
Claude Code Dynamic Workflows provide a runnable orchestration layer for one bounded loop run.
State files, schedules, hooks, skills, and human gates make that loop durable and safe.
```

## Where It Appears In The 31-Pack

Primary local sources:

- `docs/content/weekly-script-research-2026-06-22/30-short-form-production-tracker.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/31-pack-production-plan.json`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/10-design-the-loop-before-you-run-the-agent/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/11-every-useful-agent-loop-needs-a-stop-condition/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/12-use-a-maker-checker-loop-instead-of-trusting-one-agent/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/13-give-your-loop-external-state-or-it-forgets-what-it-is-doing/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/15-loop-engineering-is-prompt-engineering-for-people-who-stopped-typing-prompts/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/17-claude-workflows-are-not-just-bigger-subagents/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/18-workflows-keep-intermediate-work-out-of-your-context-window/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/20-when-should-you-use-a-workflow-instead-of-a-skill/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/23-workflow-subagent-skill-mcp-what-each-one-actually-does/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/31-agent-loops-need-isolated-verification-boxes/technical-doc.md`

The production plan defines the shared deliverable:

- Name: `cobusgreyling/loop-engineering`
- Type: third-party GitHub repo
- Status: `external_ready`
- Keyword: `LOOP`
- Hosted URL: `https://github.com/cobusgreyling/loop-engineering`
- Attribution note: MIT-licensed third-party repo; do not imply the skill author created it
- Recommended start points: `README.md`, `LOOP.md`, `STATE.md`, and `docs/safety.md`
- Used by rows: 10, 11, 12, 13, 15

The tracker also names adjacent proof sources:

- Addy Osmani's loop-engineering essay
- `ksimback/looper`
- `frankbria/ralph-claude-code`
- Jason Zhou / Crabbox, used as the isolated verification-box proof path
- Google ADK LoopAgent docs for stop-condition support

The core repo to carry forward is still `cobusgreyling/loop-engineering`.

## What The Repo Is

Primary repo: `https://github.com/cobusgreyling/loop-engineering`

Current primary-source confirmation shows it as a practical reference repo for loop engineering with AI coding agents. It includes:

- Patterns and starters for repeatable agent loops
- Tool mappings for Grok, Claude Code, Codex, OpenClaw, Cursor, and Windsurf
- CLI tools including `loop-audit`, `loop-init`, `loop-cost`, plus newer repo material around `loop-sync` and an MCP server
- Loop docs such as `README.md`, `LOOP.md`, `STATE.md`, `docs/safety.md`, `docs/primitives-matrix.md`, and `docs/loop-design-checklist.md`
- Production patterns such as daily triage, PR babysitter, CI sweeper, dependency sweeper, changelog drafter, post-merge cleanup, and issue triage

The repo's central idea is that the leverage point has moved from single prompts to control systems. A loop defines a purpose, then agents iterate with verification and external state until the goal is complete or the system hands off to a human.

## The Loop Model

The repo and 31-pack material converge on this operating model:

```text
schedule or trigger
-> triage skill or planner
-> read and write external state
-> isolated work surface
-> implementer agent
-> verifier agent
-> connector or artifact update
-> human gate or allowed action
-> run log and next loop
```

The important primitives:

- Schedule or trigger: the loop starts on a cadence, event, or explicit run.
- Skill or procedure: the loop uses stable instructions, not an ad hoc chat prompt.
- External state: `STATE.md`, a board, issue, or log stores memory outside the chat context.
- Isolation: worktrees or sandboxes protect concurrent work and make verification reproducible.
- Maker/checker split: the agent that creates the output should not be the only one judging it.
- Stop condition: max iterations, no-progress checks, budget caps, failed-state escalation, and handoff rules prevent runaway automation.
- Human gate: risky changes, broad edits, confidential configuration, infra, payments, auth, data deletion, and ambiguous decisions require approval.
- Observability: token budgets, run logs, readiness scores, and state updates make the loop auditable.

This maps cleanly to the 31-pack videos:

- Row 10: draw the loop before running the agent.
- Row 11: every useful loop needs a stop condition.
- Row 12: use maker-checker instead of trusting one agent.
- Row 13: external state prevents loop amnesia.
- Row 15: loop engineering is the next asset after prompt engineering.
- Row 31: isolated verification boxes make loop output trustworthy.

## How It Connects To Claude Code Workflows

Local workflow research says Claude Code Dynamic Workflows are JavaScript orchestration scripts that Claude writes and a workflow runtime executes in the background. The script coordinates subagents; agents do file, shell, web, and MCP work; intermediate results live in script variables; useful runs can be saved under `.claude/workflows/`; saved workflows can accept structured `args`.

That means Claude Code Workflows can run a bounded loop iteration well:

- Fan out source gathering or code inspection to subagents.
- Keep noisy intermediate findings out of chat.
- Preserve structured intermediate results in workflow variables.
- Spawn separate implementer and verifier roles.
- Return a concise operator summary with artifact paths.
- Save the orchestration for reuse as a slash command.

But Dynamic Workflows are not the whole loop by themselves:

- They do not replace durable state. A loop still needs `STATE.md`, a board, issues, or persisted artifacts.
- They do not solve scheduling alone. Pair with scheduled tasks, routines, cron, GitHub Actions, or an explicit operator run.
- They do not allow arbitrary mid-run human input. Approval checkpoints should be split into separate workflow runs or expressed as input flags.
- They do not remove cost and safety concerns. Use budgets, small-slice dry runs, denylist paths, and explicit escalation rules.

The clean teaching frame:

```text
Loop engineering is the architecture.
Claude Code Workflows are one execution substrate.
Skills are the reusable procedures.
Subagents are the workers.
MCP/connectors are the external reach.
State and logs are the memory.
Hooks and approval gates are the guardrails.
```

## Concrete Workflow Bridge

A useful Claude Code Workflow deliverable based on this repo would be:

```text
.claude/workflows/loop-readiness-audit.js
```

Suggested `args`:

```json
{
  "target_path": ".",
  "loop_type": "daily-triage | pr-babysitter | ci-sweeper | dependency-sweeper | custom",
  "risk_level": "report_only | assisted | unattended",
  "allow_file_writes": false,
  "output_dir": "docs/workflow-runs/loop-readiness-audit/YYYY-MM-DD"
}
```

Suggested phases:

1. Inspect loop surface: look for `LOOP.md`, `STATE.md`, `AGENTS.md`, skills, workflows, hooks, schedules, run logs, and budget files.
2. Map intended loop: identify goal, trigger, watched scope, state store, worker roles, verifier, stop condition, and handoff path.
3. Safety review: check denylist paths, connector scopes, auto-merge policy, human-gate rules, budget caps, and kill switch.
4. Workflow fit review: decide whether the job belongs in a Claude Dynamic Workflow, a skill, a hook, a scheduled task, or a GitHub Action.
5. Generate recommendations: output a readiness score, missing files, suggested `.claude/workflows/` skeleton, and state schema.
6. Verifier pass: run a separate reviewer agent against the recommendations before final output.

Suggested output artifacts:

```text
docs/workflow-runs/loop-readiness-audit/YYYY-MM-DD/report.md
docs/workflow-runs/loop-readiness-audit/YYYY-MM-DD/report.json
docs/workflow-runs/loop-readiness-audit/YYYY-MM-DD/evidence/
```

This would connect a `LOOP` deliverable to a Claude Workflows `WORKFLOW` deliverable without pretending that the third-party repo is the skill author's product.

## Content Angle For Claude Code Workflows

Strong angle:

```text
Claude Code Workflows make loop engineering executable.
```

Expanded:

Most people will use Claude Workflows as "more agents." The better framing is that a workflow is a reusable loop runner. It can coordinate the planner, implementer, verifier, artifact writer, and skeptic. But the loop only becomes production-grade when you add external state, stop conditions, cost controls, and human gates.

This bridges rows 10-15 into rows 17-23:

- Rows 10-15 teach what an agent loop must contain.
- Rows 17-23 teach which Claude primitive runs which part.
- Rows 19, 21, and 22 are natural loop examples: URL-to-brief, daily signal triage, and tool-claim evaluator.

For example:

- URL-to-brief loop: capture source, classify authority, extract claims, verify, write artifacts, return caveats.
- Daily signal triage loop: gather candidates, normalize, dedupe, score, route, write brief, record failures.
- Tool-claim evaluator loop: capture claim, verify primary sources, inspect repo/license, run bounded tests, write a replacement matrix.

All three are workflow-shaped because they have branching, fan-out, evidence capture, and reducer phases. All three also need loop-engineering discipline because they can otherwise become expensive, overconfident, or hard to audit.

## Guardrails And Attribution

- Treat `cobusgreyling/loop-engineering` as a third-party MIT resource.
- Attribute the repo and do not imply the skill author created it.
- Keep Addy Osmani as concept/source framing, not as a claim that every implementation detail comes from him.
- Use Crabbox only for the isolated verification-box angle, not as the main loop starter repo.
- Do not package or redistribute third-party content unless the license is clear.
- Do not say Claude Workflows provide durable scheduling or cross-session persistence by themselves. The local workflow research says resumed runs are session-bounded and fresh starts happen after exiting Claude Code.
- Do not design loops with auto-merge, external posting, or paid services as defaults. Use report-only first, then assisted, then unattended only after safety checks.

## Source Ledger

Local:

- `docs/content/weekly-script-research-2026-06-22/30-short-form-production-tracker.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/31-pack-production-plan.json`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/10-design-the-loop-before-you-run-the-agent/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/11-every-useful-agent-loop-needs-a-stop-condition/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/12-use-a-maker-checker-loop-instead-of-trusting-one-agent/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/13-give-your-loop-external-state-or-it-forgets-what-it-is-doing/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/15-loop-engineering-is-prompt-engineering-for-people-who-stopped-typing-prompts/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/17-claude-workflows-are-not-just-bigger-subagents/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/18-workflows-keep-intermediate-work-out-of-your-context-window/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/20-when-should-you-use-a-workflow-instead-of-a-skill/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/23-workflow-subagent-skill-mcp-what-each-one-actually-does/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/31-pack-production-plan/sections/31-agent-loops-need-isolated-verification-boxes/technical-doc.md`
- `docs/content/weekly-script-research-2026-06-22/workflow-specs/_workflow-build-prompts/claude-workflows-feature-research-2026-06-23.md`
- `docs/content/weekly-script-research-2026-06-22/workflow-specs/_workflow-build-prompts/claude-agent-build-prompts.md`
- `docs/content/weekly-script-research-2026-06-22/workflow-specs/url-to-brief/url-to-brief-workflow-spec.md`
- `docs/content/weekly-script-research-2026-06-22/workflow-specs/daily-signal-triage/daily-signal-triage-workflow-spec.md`
- `docs/content/weekly-script-research-2026-06-22/workflow-specs/tool-claim-evaluator/tool-claim-evaluator-workflow-spec.md`
- `docs/research/2026-06-29-claude-code-workflows/01-official-feature-surface.md`
- `docs/research/2026-06-29-claude-code-workflows/04-use-cases-patterns.md`

Primary/source confirmation:

- `https://github.com/cobusgreyling/loop-engineering`
- `https://raw.githubusercontent.com/cobusgreyling/loop-engineering/main/README.md`
- `https://raw.githubusercontent.com/cobusgreyling/loop-engineering/main/LOOP.md`
- `https://raw.githubusercontent.com/cobusgreyling/loop-engineering/main/STATE.md`
- `https://raw.githubusercontent.com/cobusgreyling/loop-engineering/main/docs/safety.md`
- `https://raw.githubusercontent.com/cobusgreyling/loop-engineering/main/docs/primitives-matrix.md`
- `https://raw.githubusercontent.com/cobusgreyling/loop-engineering/main/docs/loop-design-checklist.md`
