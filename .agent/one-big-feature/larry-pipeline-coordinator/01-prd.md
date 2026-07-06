# PRD — Larry-as-Pipeline-Coordinator (multi-harness dynamic pipeline)

**Framework:** one-big-feature · **Repo:** ~/code/cortextos · **Slug:** larry-pipeline-coordinator
**Author:** larry · 2026-07-05 · **Owner:** Larry (coordinator) → codexer (thin CLI wrapper only)

## Why (Josh's exact words, this session)
- *"the pipeline is not fixed at all. You're supposed to actually use the proper Gemini that james mentioned in his video and the proper deep sea [DeepSeek] and the proper GLM and codex and three diff[erent] harness's… you just only mention and drops."*
- *"if B is what you eventually want then we should just do what we have to do to make B work."*
- *"don't we just make this all part of Larry who is already the coding coordinator? And anthropic work is done in his own subagents?"*

Josh wants a pipeline where each stage runs on the **right real harness** — not a pipeline that
names Gemini/DeepSeek/GLM/Codex and then silently collapses every stage to Anthropic (that was
PR #68, my error, closed). And he wants it **folded into Larry**, not a separate sandboxed Workflow.

## The core insight (why the old approach kept failing)
The sandboxed `Workflow` tool cannot shell out (`no child_process`) — so any pipeline that lives
*inside* it can only ever call `agent()` (Anthropic-tier). That is why every attempt collapsed to
Anthropic-only. **Larry is not sandboxed.** Larry runs on the claude runtime with real Bash, so
Larry can BOTH spawn Anthropic subagents (Agent tool) AND shell a stage to a different harness
(`opencode run --model <openrouter-slug>`, `codex exec`). The coordinator therefore belongs in
Larry, not in the Workflow sandbox.

## What "done" looks like
A pipeline run (kicked off by Larry) executes the stage graph with each stage on its declared
harness, proven by artifacts:
- **explore** → real Gemini output (opencode harness, OpenRouter slug) enters Plan.
- **plan** → Anthropic (Fable opt-in, Opus fallback) in Larry's own subagent.
- **implement** → real Codex (gpt-5-codex) edits a worktree branch.
- **merge / review / pr** → Anthropic in Larry's own subagents (review is the merge gate, never off-Anthropic).
- The per-stage harness is chosen from **one editable file** (`routing-config.json`) — Josh's control surface.

## Non-goals
- No new persistent daemon agent unless Josh picks that fork (see master-plan "Open decision").
- No dashboard UI for routing (JSON edit is the MVP surface).
- No change to the daemon degrade/failover path (already landed).
- Not reviving the sandboxed `dynamic-pipeline.js` as the orchestrator — it stays a thin demo only.

## Users
- **Josh** — edits `routing-config.json` to re-route any stage; kicks a build by asking Larry.
- **Larry** — the coordinator; runs the stage graph, hops harnesses, adversarial-reviews, opens PR.

## Success metric
One end-to-end run on a trivial task (e.g. a one-line doc fix) where the logs/artifacts prove a
real Gemini stage AND a real Codex stage executed — not an Anthropic stand-in — and a PR is produced.
