# Spec 01 — sendwork-cli.js (WS1, codexer)

**Goal:** A thin, stateless CLI so Larry can execute one non-Anthropic pipeline stage from Bash and
receive schema-valid JSON on stdout. Zero new logic — a wrapper over the existing `sendWork()`.

**Target file (NEW):** `.claude/workflows/lib/sendwork-cli.js` (CommonJS, dependency-free `.js`).
**Reuse (do NOT modify):** `.claude/workflows/lib/runtime-bridge.js` (`sendWork`), `.claude/workflows/routing-config.json`.

## Contract
```
node .claude/workflows/lib/sendwork-cli.js \
  --stage <name> \                # required; key into routing-config.json .stages
  --prompt-file <path> \          # required; UTF-8 file with the stage prompt
  --schema-file <path> \          # required; JSON file with the stage's JSON schema
  [--cwd <dir>] \                 # optional; execution dir (default process.cwd())
  [--allow-write]                 # optional; pass allowWrite:true (Codex file edits)
```
- Success: prints the parsed, schema-validated JSON object to **stdout**, exit 0.
- Failure: descriptive message to **stderr**, exit 1. NEVER print partial/invalid JSON to stdout.

## Behavior
1. Parse argv (hand-rolled; no new deps like yargs). Validate all required flags present → else exit 1 with usage.
2. Read `routing-config.json` from `.claude/workflows/routing-config.json` (resolve relative to __dirname/..).
3. Look up `stages[<stage>]`. If missing → exit 1 "no route for stage '<stage>'". Extract `{provider, model, effort}`.
   - If `provider === 'anthropic'` → exit 1 "stage '<stage>' is anthropic — run it in a Larry subagent, not sendwork-cli"
     (this CLI is only for openrouter/codex; fail loud rather than silently mis-handle).
4. Read prompt-file (utf8) and schema-file (parse JSON; on parse error exit 1).
5. `const { sendWork } = require('./runtime-bridge.js')`. `await sendWork({ provider, model, effort, prompt, schema, cwd, allowWrite })`.
6. On resolve: `process.stdout.write(JSON.stringify(result))` + newline, exit 0.
7. On reject: `process.stderr.write(err.message)`, exit 1. (sendWork already fails loud on missing OPENROUTER_API_KEY.)

## Guardrails
- No `console.log`. Use `process.stdout.write` / `process.stderr.write` explicitly.
- No silent Anthropic fallback — an anthropic-provider stage is a usage error here (step 3).
- No new dependencies. CommonJS `require`, matches runtime-bridge.js style.
- Do not modify runtime-bridge.js or routing-config.json.

## Acceptance
- `--stage explore` with a trivial prompt + minimal schema → prints a Gemini-produced JSON object matching the schema, exit 0.
- Missing `OPENROUTER_API_KEY` → stderr error, exit 1, nothing on stdout.
- `--stage review` (anthropic) → exit 1 with the "run in a Larry subagent" message.
- Malformed schema-file → exit 1, clear message.
