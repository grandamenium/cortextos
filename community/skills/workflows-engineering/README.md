# Workflows Engineering

A reusable skill for designing Claude Code Dynamic Workflows as agentic loops.

Use it when you need to turn repeatable agent work into an auditable, observable, repeatable, and optimizable workflow. The skill helps decide when to use Dynamic Workflows versus skills, subagents, MCP, slash commands, hooks, routines, or an optional operating layer.

## What It Covers

- Claude Code Dynamic Workflow mechanics and limits
- Agentic loop design: trigger, state, planner, worker, verifier, stop rule, and artifact ledger
- Anthropic's six dynamic-workflow patterns: classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament, and loop until done
- Workflow spec templates
- Maker and checker patterns
- Use cases for research, content, coding, QA, scraping, and agent operations
- Runtime risks, testing strategy, and failure modes
- Optional persistent operating layer integration for scheduled or bus-routed operations

## Install

Copy this directory into your skills folder:

```bash
mkdir -p ~/.codex/skills/workflows-engineering
cp -R SKILL.md references metadata.json ~/.codex/skills/workflows-engineering/
```

Then ask your agent about workflows engineering, Claude Code Dynamic Workflows, agentic loops, or when to use workflows versus neighboring primitives.

## Structure

- `SKILL.md`: trigger, routing guidance, core mechanics, and design procedure
- `references/`: deeper reference docs loaded only when needed
- `metadata.json`: public catalog metadata

## License

MIT
