# Invocation Guide

## Quick Start

```bash
# From your agent session:
/Users/subbu_ai_assistant/cortextos/community/skills/ask-codex-remote/bin/ask-codex-remote.sh "<your prompt>"
```

## In Claude Code

When a user asks you to "ask codex" or "get a second opinion from codex":

1. **Load the skill:** Refer to SKILL.md above for capability and when to use
2. **Invoke the script:** Call the bin wrapper with the prompt
3. **Parse output:** Expect JSON envelope with verdict, body, output_path
4. **Handle errors:** If verdict="error", fall back to Claude or escalate

## Example

```bash
RESULT=$(/Users/subbu_ai_assistant/cortextos/community/skills/ask-codex-remote/bin/ask-codex-remote.sh "write a function that...")
VERDICT=$(echo "$RESULT" | jq -r '.verdict')

if [ "$VERDICT" = "ok" ]; then
  BODY=$(echo "$RESULT" | jq -r '.body')
  echo "Codex output: $BODY"
else
  ERROR=$(echo "$RESULT" | jq -r '.error')
  echo "Codex failed: $ERROR"
fi
```

## Flags & Options

Supports optional flags:

```bash
/path/to/ask-codex-remote.sh "<prompt>" [--resume] [--timeout 60]
```

- `--resume` — Continue an existing Codex thread (uses `codex exec resume --last`)
- `--timeout <seconds>` — Codex execution timeout (default: 30 seconds, max recommended: 120s)

## Environment

The script reads:

- `CODEX_REMOTE_HOST` — SSH host (default: `macbook-m4`)
- `CODEX_REMOTE_SSH_CONFIG` — SSH config path (default: `~/.ssh/config_macbook`)
- `MAX_OUTPUT_TOKENS` — Output limit (default: `5000`)
- `CODEX_TIMEOUT` — Execution timeout in seconds (default: `30`)

Override via env if needed:

```bash
CODEX_TIMEOUT=60 CODEX_REMOTE_HOST=my-macbook \
  /path/to/ask-codex-remote.sh "<prompt>"
```

## Troubleshooting

| Issue | Solution |
|---|---|
| **"no local codex auth AND no SSH config"** | Set up either local `codex` + `~/.codex/auth.json` OR configure SSH host in `~/.ssh/config` |
| **SSH timeout** | Reduce `ConnectTimeout` in script (line 56, currently 10s) or check Tailscale connectivity |
| **"tokens used" = 0** | Codex output parsing failed — check `output_path` manually for full transcript |
| **Stale output** | `/tmp/multi-llm-bridge/` accumulates task dirs — clean up old ones: `rm -rf /tmp/multi-llm-bridge/codex-* older than 7 days` |

## References

- **SKILL.md** — Full capability guide
- **multi-llm-bridge SKILL.md** — Parent framework (ask-codex, ccg, review modes)
- **ask-codex.sh** — Local variant (no SSH fallback)
