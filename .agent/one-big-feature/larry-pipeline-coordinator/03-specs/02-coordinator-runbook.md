# Spec 02 — Larry Coordinator Runbook (WS2, Larry writes; no production code)

**Goal:** The exact stage graph Larry follows to run a multi-harness build. This is an SOP doc
(lives at `larry/PIPELINE.md` or a skill), not code. Larry IS the orchestrator loop.

## Inputs
- A build request (task + target repo).
- `routing-config.json` (the per-stage provider/model table).

## The loop (one stage at a time; pass schema-valid results forward)

1. **Load routing** — read `.claude/workflows/routing-config.json`. This is the source of truth for
   which harness each stage uses. Josh may have edited it; honor it verbatim.

2. **explore** (provider=openrouter, read-only, parallelizable)
   - Write the explore prompt + EXPLORE_SCHEMA to temp files.
   - `node .claude/workflows/lib/sendwork-cli.js --stage explore --prompt-file … --schema-file …`
   - Capture the JSON (real Gemini/opencode output). This is the map that feeds Plan.

3. **plan** (provider=anthropic, Fable opt-in → Opus fallback)
   - Larry spawns his OWN Agent subagent (`fable-lean` if `lean:true` and Fable confirmed, else Opus).
   - Feed it the explore results. It returns a PLAN_SCHEMA object. Fable requires explicit confirm
     (`requiresConfirmation`); default to Opus fallback when not confirmed.

4. **implement** (provider=codex, worktree-isolated, EDITS FILES)
   - Heavy path: `bus send-message codexer normal 'GATE: build framework=one-big-feature slug=<slug> repo=<path> <plan>'`
     — the existing, working Codex harness hop. codexer edits a worktree branch, returns the diff.
   - (Light alt: `sendwork-cli --stage implement --allow-write` for tiny mechanical edits — same
     Codex harness, one-shot. Use codexer for anything real.)

5. **merge** (provider=anthropic) — Larry's own subagent (haiku) assembles/cleans the diff.

6. **review** (provider=anthropic, opus high) — Larry's own subagent adversarially reviews:
   scope match vs plan, no `any`, no `console.log`, org isolation, tests present. **NEVER route this
   off-Anthropic** — it is the merge-approval gate. On FAIL → loop back to implement (≤ maxReviewLoops).

7. **pr** (provider=anthropic, sonnet) — Larry opens the PR (`gh pr create --repo …`). Josh approves merge.

8. **lessons** (provider=anthropic, sonnet) — Larry's own subagent captures what to reuse next time.

## Rules
- Each non-Anthropic stage MUST actually shell to its harness (via sendwork-cli or bus→codexer).
  If a hop fails, STOP and surface — do NOT silently substitute an Anthropic subagent (that was PR #68).
- Every stage result is schema-validated before it feeds the next stage.
- The only stops that reach Josh: Fable confirmation (if used), PR merge approval, a genuine scope fork.
- Re-checkpoint current-mission.txt after each verified stage.

## Done
- Runbook committed as Larry's pipeline SOP; the stage→mechanism mapping matches routing-config.json.
