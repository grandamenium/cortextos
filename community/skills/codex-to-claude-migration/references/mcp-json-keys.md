# MCP: `~/.codex/config.toml [mcp_servers.<id>]` -> target `.mcp.json`

Codex MCP servers are HOST-GLOBAL (every codex agent on the host sees all of them).
Claude MCP servers are per project: the target agent dir gets a `.mcp.json`, and
servers already defined at Claude user scope (`~/.claude.json` `mcpServers`) are
inherited, so they are skipped rather than duplicated.

## The secrets rule (non-negotiable)

No value from `config.toml` is ever written to `.mcp.json` or any other file.
detect.py builds each entry with `${VAR}` references only; convert.py writes those
entries; verify.py fails if any inline secret value from `config.toml` appears in any
target text file (it reports the config location, never the value).

Default-deny: EVERY inline `env` value becomes a reference, secret-looking or not.
The report labels each one `secret` or `config` and says whether it is already
defined in `orgs/<org>/secrets.env` / the agent `.env` (by name only). Secret-looking
inline values are additionally raised as a FINDING: they sit in plain text in
`~/.codex/config.toml` today.

Claude Code expands `${VAR}` in `.mcp.json` from its process environment. The daemon
builds that environment from `orgs/<org>/secrets.env`, then the agent `.env`
(`src/pty/agent-pty.ts`), so set the listed vars in `secrets.env`.

## Key mapping

| codex key | `.mcp.json` | notes |
|---|---|---|
| `command`, `args` | `command`, `args` | an arg after `--api-key`/`--token`/... or one that looks like a credential becomes `${<SERVER>_ARG<i>}` |
| `env.KEY = "v"` | `env.KEY = "${<SERVER>_KEY}"` | var namespaced by server (no double prefix) so two servers' `API_KEY` cannot collide |
| `env_vars = ["K"]` | `env.K = "${K}"` | forwarded by name |
| `url` | `type: "http"`, `url` | secret-looking query params (`?api_key=`) become refs |
| `bearer_token_env_var = "V"` | `headers.Authorization = "Bearer ${V}"` | |
| `http_headers.H = "v"` | `headers.H = "${<SERVER>_HEADER_H}"` | |
| `env_http_headers.H = "V"` | `headers.H = "${V}"` | |
| `cwd` | — | dropped; no `.mcp.json` equivalent (report line) |
| `startup_timeout_sec/_ms`, `tool_timeout_sec`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode` | — | dropped (report line) |
| `enabled = false` | — | server skipped |

## Servers that are skipped

- `enabled = false` in codex.
- Codex-desktop-internal servers (env has `CODEX_HOME`/`CODEX_CLI_PATH`, or the
  command/cwd lives in `Codex.app` / `~/.codex/`), e.g. `node_repl`. No Claude equivalent.
- Already defined at Claude user scope.

`.mcp.json` servers need approval before an unattended Claude session will start
them, so convert.py sets `enableAllProjectMcpServers: true` in the target
`.claude/settings.json` when it writes any server.
