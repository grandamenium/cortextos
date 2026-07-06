# Spec 03 — End-to-End Proof (WS3, Larry)

**Goal:** Prove the multi-harness pipeline actually hops harnesses — not an Anthropic stand-in.
This is the acceptance gate for the whole build. Josh's complaint was "you just mention and drop";
this spec exists so we can never claim done without artifacts.

## Trivial task under test
A one-line, low-risk change (e.g. add a doc comment or a README line in cortextos). Small enough
that the pipeline shape is what's being tested, not the change.

## Steps + required artifacts
1. **explore on real Gemini** — run `sendwork-cli --stage explore`. Capture:
   - the exact command, and
   - stdout JSON, and
   - evidence it was opencode/OpenRouter (e.g. the process ran `opencode run --model openrouter/google/gemini-3.5-flash`).
   FAIL if the output could have come from Anthropic (no opencode process = not proven).
2. **plan on Anthropic subagent** — Larry spawns the fable-lean/Opus subagent; capture the plan object.
3. **implement on real Codex** — dispatch to codexer (or `sendwork-cli --stage implement`). Capture:
   - the diff codexer/Codex produced, and
   - evidence the Codex harness ran (codex-app-server / `codex exec`).
4. **review on Opus** — Larry's subagent reviews; capture PASS/FAIL + reasoning.
5. **pr** — open the PR; capture the PR URL.

## Acceptance (all required)
- [ ] Artifact proving a REAL Gemini (opencode/OpenRouter) stage executed.
- [ ] Artifact proving a REAL Codex stage executed.
- [ ] Anthropic stages ran in Larry's own subagents.
- [ ] Missing OPENROUTER_API_KEY path tested once → fails loud (no silent Anthropic run).
- [ ] A PR was produced end-to-end.
- [ ] Larry reports each artifact to Josh (not "trust me — it works").

## Anti-goal (the failure we are guarding against)
Do NOT declare the pipeline "fixed" if every stage actually ran on Anthropic. The whole point is
distinct harnesses per stage. No proof of a real Gemini + real Codex stage = NOT done.
