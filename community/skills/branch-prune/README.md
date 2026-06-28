# branch-prune

Stop letting your coding agent commit to the first idea it has. Branch and
prune: generate N genuinely different solutions in parallel subagents, review
each, prune to a winner, merge with one OK.

A Claude Code skill. Self-contained — no external dependencies, no MCP servers,
nothing beyond vanilla Claude Code (subagents + git).

## Install

```bash
mkdir -p ~/.claude/skills/branch-prune
cp SKILL.md ~/.claude/skills/branch-prune/SKILL.md
```

Per-project install: use `<repo>/.claude/skills/branch-prune/SKILL.md` instead.

## Use

In any Claude Code session:

```
/branch <your task>
```

or just ask: "run branch and prune on <task>". The skill never triggers on its
own — you invoke it.

It works at any level: planning a large architecture, building a feature,
designing UI, even non-coding tasks like copywriting.

## What it does

1. Asks how many variations you want (no cap; warns about cost on large N).
2. Suggests 5-10 diversity axes derived from your task — you pick.
3. Asks how to configure the subagents (forked vs fresh context, model).
4. Runs one subagent per variation, each in its own git worktree, each with a
   distinct prompt so outputs genuinely differ. Errors get redeployed, never
   silently dropped. (After 3 consecutive failures of one variation it asks
   you what to do — a safety default added by the authors on top of the
   original "redeploy, no cap" spec, since confirmed by the spec owner as
   intended behavior.)
5. Reviews every variation with its own review subagent.
6. Prunes: a single fair LLM judge with an editable rubric, or you judge
   manually — your choice.
7. Delivers per-variation git branches + a report with a winner-based merge
   suggestion. You give one OK and it merges.

## Pro tip

Generate some variations with different LLMs entirely (Gemini, Codex, Claude)
and feed them into the judging phase manually. The skill leaves vendor
orchestration to you on purpose.

---

Part of the cortextOS approach to agent engineering: https://github.com/grandamenium/cortextos
