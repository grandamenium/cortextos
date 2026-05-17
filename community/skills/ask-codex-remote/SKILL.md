---
name: ask-codex-remote
description: "Dispatch a Codex prompt to the remote Codex CLI (MacBook), capturing output and returning structured result. Use when: greenfield code generation, test generation, high-volume parallel coding subtasks, or second-opinion code review. Triggered by: 'ask codex <prompt>', 'codex <prompt>', 'second opinion on code'."
triggers: ["ask codex", "codex", "second opinion", "codex review", "code review"]
effort: medium
external_calls: ["codex", "ssh", "base64"]
---

# ask-codex-remote — Codex CLI Dispatcher

Dispatch a single well-scoped coding task to **Codex via remote CLI** (optimized for when Codex auth lives on MacBook). Captures structured output and returns to caller.

## When to Use

- **Greenfield code generation:** Single-file new code (Codex outperforms Claude on Aider Polyglot by +15-27pts)
- **Test generation:** HumanEval-style test cases
- **Format-strict work:** JSON, well-defined schemas, config generation
- **High-volume parallel tasks:** When cost matters (~1.5-3× cheaper than Claude per task)
- **Second opinion:** Independent code review (not a replacement for Claude reviewer agent)

## When NOT to Use

- Multi-file refactors (>5 files) — Claude's SWE-bench Pro lead
- Context >256K — Codex CLI ceiling
- Multi-turn tool chains — Codex is single-turn
- Architecture decisions / debugging unfamiliar systems — Claude wins
- Daemon-style or orchestration-heavy work — Claude wins

## Invocation

```bash
ask-codex-remote "<prompt>" [--resume] [--timeout <seconds>]
```

**Flags:**
- `--resume` — Continue an existing Codex thread (uses `codex exec resume --last`)
- `--timeout <seconds>` — Timeout for Codex execution (default: 30 seconds, env override: `CODEX_TIMEOUT`)

## Example Usage

```
Agent Message: "ask codex: write a Python function that validates email addresses using regex"

Response (JSON):
{
  "verdict": "ok",
  "backend": "ssh-remote:macbook-m4",
  "elapsed_s": 12,
  "tokens_used": 342,
  "body": "<generated code excerpt>",
  "output_path": "/tmp/codex-<task-id>/codex-out.txt"
}
```

## How It Works

1. **Prompt validation:** Check that prompt is provided and non-empty
2. **Backend selection:** Try local `codex` first (~10s); fall back to SSH-to-MacBook (~6s after first multiplex)
3. **Execution:** Run `codex exec --json --sandbox workspace-write <prompt>` and capture JSONL stream
4. **Parsing:** Extract `turn.completed` event and parse assistant's response
5. **Return:** Structured envelope with verdict, elapsed time, token count, output summary, and full-output path

## Setup

### Required

- **Local Codex CLI:** `npm install -g @openai/codex` OR
- **MacBook Codex:** Configured via ssh config (see below)
- **SSH config:** `~/.ssh/config_macbook` with entry for `macbook-m4`

### Env Variables (optional)

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_REMOTE_HOST` | `macbook-m4` | SSH host alias |
| `CODEX_REMOTE_SSH_CONFIG` | `~/.ssh/config_macbook` | SSH config file path |
| `MAX_OUTPUT_TOKENS` | `5000` | Codex output limit |

## Output Format

```json
{
  "verdict": "ok|error",
  "backend": "local|ssh-remote:macbook-m4",
  "task_id": "codex-<timestamp>-<pid>",
  "elapsed_s": <seconds>,
  "tokens_used": <count>,
  "body": "<first 4000 chars of output>",
  "body_truncated": <bool>,
  "output_path": "/tmp/codex-<task-id>/codex-out.txt",
  "error": "<error message if verdict=error>"
}
```

**Read full output** by loading `output_path` if `body_truncated` is true.

## Error Handling

If Codex fails (timeout, auth error, process crash):

```json
{
  "verdict": "error",
  "backend": "ssh-remote:macbook-m4",
  "task_id": "codex-<timestamp>-<pid>",
  "rc": <exit_code>,
  "stderr_excerpt": "<first 500 chars of error>"
}
```

Caller should handle error gracefully (e.g., fall back to Claude, retry, or escalate to dev).

## Cost & Performance

| Backend | Speed | Cost | Auth |
|---|---|---|---|
| **Local codex** | ~10s | Device (free) | ~/.codex/auth.json (device-auth) |
| **SSH-to-MacBook** | ~6s (after multiplex) | Device (free) | ChatGPT Pro device-auth on MacBook |

No API quota — uses device-auth, not API keys.

## Security

- **Prompt encoding:** Base64 for safe SSH transport (no shell quoting issues)
- **Output staging:** Temp dir with task ID (cleaned up by caller or next invocation)
- **Sandbox mode:** `--sandbox workspace-write` prevents filesystem access outside task dir

## Limits

- **Input:** Max 256K tokens (Codex CLI ceiling)
- **Output:** Capped at 5000 tokens (env override: `MAX_OUTPUT_TOKENS`)
- **Timeout:** 30s per invocation (configurable in bin wrapper)

## Related Skills

- **multi-llm-bridge** — parent framework (includes ccg parallel dispatch, codex review sub-modes)
- **reviewer** (agent) — Use Claude Opus for final code review (not Codex)

## References

- Codex API: https://platform.openai.com/docs/guides/code
- Aider benchmarks: https://aider.chat/docs/benchmarks.html (Codex Polyglot +15-27pts on greenfield)
- SWE-bench: https://www.swebench.com/ (Claude leads on multi-file, architecture)
