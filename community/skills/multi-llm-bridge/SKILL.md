---
name: multi-llm-bridge
effort: medium
description: "Delegate a well-scoped coding subtask from the Claude orchestrator to an alternative LLM (Codex via API, Gemini, etc.) for cost or capability reasons, capture the output, return structured. Use when: greenfield single-file code generation, test generation, format-strict schema work, high-volume parallel coding subtasks, OR when a second-opinion review is wanted (Codex's challenge/review modes). Use when asked to 'ask codex', 'codex review', 'codex challenge', 'second opinion', 'consult codex', 'parallel coding'. Built per the dual-source pattern: oh-my-claudecode /ask codex + /ccg AND gstack /codex (independent validation, both MIT, both May 2026). See research-output/2026-05-12-codex-multi-llm-strategy.md §5 + research-output/2026-05-12-gstack-adoption-roadmap.md §1.1."
triggers: ["ask codex", "codex review", "codex challenge", "second opinion", "consult codex", "parallel coding", "multi-llm", "delegate to codex", "ccg"]
---

# multi-llm-bridge

A bridge that lets a Claude-based cortextOS agent delegate a single well-scoped subtask to an alternative LLM (Codex via API, Gemini, or both in parallel), capturing the output and returning a structured envelope to the caller. The Claude orchestrator handles planning, review, and integration; the alternative LLM does the narrow task where it's actually stronger or cheaper.

This is **multi-LLM as TOOL USE**, NOT runtime replacement. The Claude reasoning loop stays in charge. Codex / Gemini are invoked as black-box workers.

## 3 invocation modes

| Mode | Trigger | What it does |
|---|---|---|
| **ask-codex** | "ask codex <prompt>" | One-shot prompt to Codex CLI via API. Captures structured output. Returns to caller. |
| **ask-codex-resume** | "ask codex (resume)" | Continues an existing Codex thread for the cwd. Uses `codex exec resume --last`. |
| **ccg** (Claude+Codex+Gemini) | "ccg <prompt>" or "parallel coding <prompt>" | Parallel-dispatch to Codex + Gemini. Claude arbitrates which result to return. Use when high-confidence is needed and the task is well-scoped enough for both providers. |

Optional gstack-derived sub-modes (review / challenge / consult) layer on top of ask-codex with structured diff-review or adversarial-attack prompts.

## When to invoke

- Greenfield single-file code generation (Codex's Aider Polyglot +15-27pts win)
- Test generation (Codex's HumanEval strength)
- Format-strict tasks (JSON, well-defined schemas)
- High-volume parallel coding subtasks where cost matters (~1.5-3× cheaper than Claude on isolated code-completion)
- Need a second opinion / independent diff review (gstack `/codex review` pattern)
- Adversarial review — "try to break my code" (gstack `/codex challenge` pattern)
- Open-ended consult with session continuity for follow-ups (gstack `/codex` consult mode)

## When NOT to invoke

- Multi-file refactors spanning >5 files (Claude's TAU-bench + SWE-bench Pro lead)
- Tasks requiring 1M+ context (Codex CLI ceiling 256K)
- Tasks requiring multi-turn tool chains (Codex is task-at-a-time)
- Architecture decisions / debugging unfamiliar systems (Claude's MCP-Atlas + METR strengths)
- Anything daemon-style or orchestration-heavy (Claude wins)

## Boundaries

1. **Does NOT replace Claude's reasoning.** The orchestrator chooses when to call this skill. The skill is a tool, not a substitute.
2. **Does NOT bypass approval.** Any file-touching that goes through cortextOS's approval workflow still does — the skill returns Codex's proposed output to Claude, Claude decides what to do with it.
3. **Token budget enforced per invocation.** Default 20k input / 5k output. Configurable per call.
4. **Structured output ONLY.** Raw long output is staged to `/tmp/multi-llm-bridge/<task-id>/codex-out.txt`; only a summary (verdict + key claims + path-to-full) returns to the caller. Mirrors the deep-research-workflow pattern.

## Setup

### Required env

- `OPENAI_API_KEY` (for Codex) — should live in `orgs/<org>/secrets.env` for fleet-wide access. NOT in personal .env files.
- `GEMINI_API_KEY` (for Gemini, used by ccg mode) — same.

### Required CLI tools

- `codex` (OpenAI Codex CLI, install via `npm install -g @openai/codex`)
- `gemini-cli` (if using ccg mode; install per Google's gemini-cli docs)

### Test that auth works

```bash
echo "echo hello" | codex exec --json --sandbox read-only --skip-git-repo-check
# Should return a JSON envelope with turn.completed
```

## Invocation: `ask-codex <prompt>`

```bash
/Users/subbu_ai_assistant/cortextos/community/skills/multi-llm-bridge/bin/ask-codex.sh "<prompt>"
```

### Variant: `ask-codex-remote <prompt>` (recommended when Codex auth lives on MacBook)

```bash
/Users/subbu_ai_assistant/cortextos/community/skills/multi-llm-bridge/bin/ask-codex-remote.sh "<prompt>"
```

Tries local codex first (~10s for short prompts); falls back to SSH-into-MacBook (~6s for the same after the first ssh-multiplex). Uses ChatGPT Pro device-auth (no API quota). Returned envelope has `backend: "local"` or `backend: "ssh-remote:macbook-m4"` so callers can attribute.

Override via env: `CODEX_REMOTE_HOST=macbook-m4`, `CODEX_REMOTE_SSH_CONFIG=$HOME/.ssh/config_macbook`.

The script:
1. Validates `$OPENAI_API_KEY` set (errors out if missing)
2. Stages a task dir at `/tmp/multi-llm-bridge/<task-id>/`
3. Runs `codex exec --json --sandbox workspace-write --skip-git-repo-check <<<"<prompt>"`
4. Captures JSONL stream
5. Parses for `turn.completed` event
6. Returns structured envelope:
   ```json
   {
     "provider": "codex",
     "task_id": "<id>",
     "elapsed_s": <int>,
     "tokens_in": <int>,
     "tokens_out": <int>,
     "output_summary": "<first 500 chars of generated content>",
     "output_path": "/tmp/multi-llm-bridge/<task-id>/codex-out.txt",
     "verdict": "ok|error",
     "error": "<msg if error>"
   }
   ```
7. The caller (Claude orchestrator) reads `output_path` if it wants the full output.

## Invocation: `ask-codex-resume <prompt>`

Same as above but adds `--resume --last` to the codex exec call. Use when iterating on a Codex thread (debugging a generated file, requesting refinements).

## Invocation: `ccg <prompt>`

```bash
/Users/subbu_ai_assistant/cortextos/community/skills/multi-llm-bridge/bin/ccg.sh "<prompt>"
```

Parallel-dispatch to Codex + Gemini, captures both, returns BOTH envelopes plus a synthesis stub:

```json
{
  "task_id": "<id>",
  "codex": { ... envelope as above ... },
  "gemini": { ... envelope as above ... },
  "synthesis_instruction": "Caller (Claude) reviews both outputs and picks/synthesizes."
}
```

Claude orchestrator reviews both, picks the better answer or synthesizes (using its own reasoning), and proceeds.

## Sub-mode: `codex review`

A specialization of `ask-codex` with a structured-review prompt template. Pass the diff (git diff HEAD or git diff <base>...<head>) and a review prompt that instructs Codex to produce:

```
VERDICT: <PASS|FAIL>
ISSUES: <numbered list of concrete issues with file:line>
RECOMMENDATIONS: <numbered list>
```

Useful as a pre-merge gate alongside the cortextOS `reviewer` agent (Claude Opus). Codex review = independent second opinion; not a replacement for the Claude reviewer.

## Sub-mode: `codex challenge`

Adversarial mode. Same shell-out, different prompt template:

```
You are reviewing the following code as if you were trying to BREAK it. List
edge cases the author missed, attack vectors, off-by-one bugs, race conditions,
SQL injection, prompt injection, and any way you can think of to make this fail.
Be ruthless and specific.

<DIFF or FILE CONTENT>
```

Use when the agent wants stress-testing beyond what the reviewer agent does. Useful for security-sensitive code.

## Sub-mode: `codex consult`

Free-form Q&A. Maintains session continuity per-cwd via `codex exec resume --last`. The agent says "ask codex what about X" → ask-codex-resume runs → next "ask codex" continues the thread.

## Telemetry

Each invocation appends one JSONL line to `~/.cortextos/default/state/<agent>/multi-llm-bridge-usage.jsonl`:

```json
{
  "ts": "<ISO8601>",
  "mode": "ask-codex|ask-codex-resume|ccg|review|challenge|consult",
  "task_id": "<id>",
  "elapsed_s": <int>,
  "tokens_in": <int>,
  "tokens_out": <int>,
  "verdict": "ok|error",
  "agent": "<calling-agent>"
}
```

After 2-4 weeks of production use, KPI: (a) cost savings vs equivalent Claude work; (b) quality of Codex outputs vs Claude; (c) which subtask types most benefit. This data point gates whether to build a Layer 3 smart-router (auto-pick provider per task).

## Adoption notes (for the registrar)

- Invocable by: dev, m2c1-worker, builder, analyst (for greenfield code in research scripts), redteam (for adversarial code-review).
- NOT for: orchestrator (chief, sam) — they delegate, they don't generate code directly.
- Requires fleet-wide `OPENAI_API_KEY` in `orgs/<org>/secrets.env` BEFORE deployment to non-dev agents.

## Provenance

- Codex dossier: research-output/2026-05-12-codex-multi-llm-strategy.md §5 (design spec)
- gstack adoption roadmap: research-output/2026-05-12-gstack-adoption-roadmap.md §1.1 (cross-validation)
- gstack source: https://github.com/garrytan/gstack/tree/main/codex (MIT)
- oh-my-claudecode reference: 33.5k stars, `/ask codex` + `/ccg` pattern (also MIT)
- Chief approval: msg 1778617954499

## Two cross-validating sources

Both Garry Tan / gstack AND oh-my-claudecode independently arrived at the same architectural pattern in May 2026: Claude orchestrator with Codex as a delegated-task worker. This is now an established pattern, not a speculative one. Saves the design phase; effort drops from 2-3 days (designing) to 0.5 day (implementation per a settled blueprint).
