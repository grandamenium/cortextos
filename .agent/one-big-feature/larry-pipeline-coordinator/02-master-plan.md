# Master Plan — Larry-as-Pipeline-Coordinator

**Framework:** one-big-feature · **Repo:** ~/code/cortextos · **Slug:** larry-pipeline-coordinator
**Author:** larry · 2026-07-05 · **Owner:** Larry → codexer (one thin CLI wrapper only)

## Architecture (Option B, folded into Larry)

```
                    ┌─────────────────────────────────────────────┐
   Josh edits ─────▶│  .claude/workflows/routing-config.json       │  (control surface — already exists)
                    │  per-stage { provider, model, effort, lean } │
                    └───────────────────────┬─────────────────────┘
                                            │ read at kickoff
                    ┌───────────────────────▼─────────────────────┐
   Josh asks  ─────▶│                 LARRY (claude runtime)       │  = the coordinator (has Bash)
   "build X"        │  runs the stage graph, one stage at a time   │
                    └───┬───────────────┬───────────────┬─────────┘
        provider=anthropic     provider=openrouter   provider=codex
                    │               │                     │
          ┌─────────▼──────┐  ┌─────▼──────────────┐  ┌───▼───────────────┐
          │ Larry's OWN    │  │ Bash → sendwork-cli │  │ Codex harness      │
          │ Agent subagent │  │ → opencode run      │  │ (heavy: bus→codexer│
          │ (Task tool)    │  │   --model <slug>    │  │  OR sendwork-cli   │
          │ plan/merge/    │  │ = Gemini/DeepSeek/  │  │  codex exec)       │
          │ review/pr      │  │   GLM harness       │  │                    │
          └────────────────┘  └────────────────────┘  └───────────────────┘
```

**Stage graph (unchanged shape):** explore(parallel, read-only) → plan(single) →
implement(worktree-isolated) → merge → review(loop back ≤N) → pr → lessons.

## Stage → harness map (default routing-config.json, already on disk)
| Stage | Provider | Model | Mechanism (how Larry runs it) |
|-------|----------|-------|-------------------------------|
| explore | openrouter | gemini-3.5-flash | Bash → `sendwork-cli --stage explore` → opencode harness |
| plan | anthropic | fable→opus fallback | Larry's own Agent subagent (fable-lean) |
| implement | codex | gpt-5.4 / gpt-5-codex | bus→codexer (persistent, has worktree) — ALREADY WORKS |
| merge | anthropic | haiku | Larry's own Agent subagent |
| review | anthropic | opus (high) | Larry's own Agent subagent — **NEVER off-Anthropic (merge gate)** |
| pr | anthropic | sonnet | Larry (self) opens the PR |
| lessons | anthropic | sonnet | Larry's own Agent subagent |

## What already exists (REUSE — do not rebuild)
1. **`.claude/workflows/lib/runtime-bridge.js` → `sendWork()`** — already shells `opencode run
   --model <slug> --format json` (OpenRouter: Gemini/DeepSeek/GLM) and `codex exec --output-schema`
   (gpt-5-codex). Does JSON-only prompting, schema-validation, one retry, fail-loud on missing
   `OPENROUTER_API_KEY`. This is the harness-hop primitive. It works whenever the caller has
   `child_process` — Larry does (via Bash); the Workflow sandbox did not (that was the whole bug).
2. **`routing-config.json`** — the per-stage table. Josh's edit surface. Keep as-is.
3. **codexer** (daemon agent, `runtime: codex-app-server`, `gpt-5-codex`) — the Codex harness for the
   heavy implement stage. Larry already dispatches to it over the bus with a `GATE:` directive.
4. **Larry's Agent/Task tool** — Larry spawns Anthropic subagents (`fable-lean`, `architect`, etc.)
   natively. This is "anthropic work done in his own subagents" (Josh's phrase), no new code.

## THE ONE NET-NEW PIECE
A **thin, stateless CLI wrapper** around the existing `sendWork()` so Larry can run a non-Anthropic
stage from Bash and get schema-valid JSON back:

`node .claude/workflows/lib/sendwork-cli.js --stage <name> --prompt-file <f> --schema-file <f> [--cwd <d>] [--allow-write]`
- Loads `routing-config.json`, resolves `{provider, model, effort}` for `<stage>`.
- Calls `sendWork({provider, model, prompt, schema, cwd, effort, allowWrite})`.
- Prints the parsed JSON to stdout; non-zero exit + stderr on failure (fail-loud, no silent fallback).

That's it. ~40 lines. It's `.js` → **codexer's domain** (Larry specs, codexer writes). Everything
else is Larry's coordinator runbook (a doc Larry follows) + reuse of existing infra.

## DECISION (Josh, 2026-07-05): Option 2 — convert the existing opencode agent into the worker
Josh: *"Just turn the existing open code agent into what's needed like Codexer."* → We do NOT build
the sendwork-cli for cheap stages. Instead the existing `opencode` daemon agent (runtime `opencode`,
model `openrouter/z-ai/glm-4.7-flash`) becomes **Opencoder** — a codexer-style, bus-driven stage
worker. Mechanism: Larry dispatches a stage prompt+schema over the bus; Opencoder runs it NATIVELY
on its OpenRouter model (it IS the harness — no shell-out needed) and returns schema-valid JSON to
Larry. This ALSO rescues the agent, which had been stuck in interactive onboarding since 2026-07-02
(codexer-style workers don't onboard interactively). Done via: IDENTITY.md + goals.json rewrite +
`state/opencode/.onboarded` marker to kill the first-boot onboarding loop, then restart.
Per-stage model (per the AGREED plan / routing-config.json): Opencoder runs the EXACT model each
stage names by invoking `opencode run --model <slug> --format json` per dispatch (proper Gemini for
explore, DeepSeek, GLM — whatever routing-config says). Its own session model is only the dispatcher;
the stage runs on the specified model. NO single-model caveat — one worker serves all OpenRouter
models by shelling the named one per stage. Verified 2026-07-05: `opencode run --model
openrouter/google/gemini-3.5-flash` returns on Gemini (header `> build · google/gemini-3.5-flash`).

## (Superseded) Original open fork — kept for context
For the non-Anthropic **cheap** stages (explore/mechanical → Gemini/DeepSeek/GLM), two ways to hop:
- **(1) sendWork one-shot CLI [RECOMMENDED]** — stateless subprocess, no persistent agent, already
  built. Truly a harness hop (real opencode process). Avoids adding another daemon agent to babysit
  (note: our one persistent opencode agent has been stuck in onboarding since 2026-07-02).
- **(2) persistent opencode worker agent** — symmetric with codexer (bus→opencoder), conversational,
  bus-tracked. Cost: another always-on daemon agent, onboarding, babysitting; the flaky path.

**Larry's recommendation: (1) for cheap stages, keep bus→codexer for heavy Codex implement.** Minimal
net-new surface (one CLI wrapper), no new persistent agent, matches "part of Larry." We can add a
persistent opencode worker later if we want conversational multi-turn cheap stages — the CLI ships value now.

## Build workstreams (sequence)
- **WS1 — sendwork-cli.js** (codexer, `.js`): the wrapper above. Spec: `03-specs/01-sendwork-cli.md`.
- **WS2 — Larry coordinator runbook** (Larry writes, no code): the stage-graph SOP Larry follows —
  read routing-config, run each stage on its mechanism, pass schema-valid results forward, adversarial
  review, PR. Spec: `03-specs/02-coordinator-runbook.md`.
- **WS3 — end-to-end proof** (Larry): run the graph on a trivial task; capture artifacts proving a real
  Gemini stage AND a real Codex stage ran. Spec: `03-specs/03-e2e-proof.md`.

## Guardrails
- Review stage NEVER off-Anthropic (merge-approval gate stays Opus) — mirrors "larry never degrades."
- Fail loud on missing `OPENROUTER_API_KEY` / bad provider — never a silent Anthropic stand-in that hides a misroute.
- No new runtime deps. No `any`, no `console.log` in committed `.ts`; the wrapper is dependency-free `.js`.
- codexer writes only the `.js` wrapper (hook-enforced); Larry writes docs/specs and drives the graph.
- Merge to main = Josh-gated, as always.

## Definition of done
- `sendwork-cli.js` exists, reads routing-config, runs a stage on its provider, returns schema-valid JSON, fails loud.
- Coordinator runbook documents the exact stage graph Larry follows.
- One proven end-to-end run: artifacts show a REAL Gemini stage + a REAL Codex stage (not Anthropic stand-ins) → PR produced.
- Josh approves the merge of the wrapper.
