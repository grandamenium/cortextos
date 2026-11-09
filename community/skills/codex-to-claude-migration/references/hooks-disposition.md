# Hooks disposition — codex -> `.claude/settings.json`

Codex has NO per-agent hook file: the `codex-app-server` adapter
(`src/pty/codex-app-server-pty.ts`) does the agent-lifecycle work natively in code,
and the only hook-like codex setting (`notify` in `~/.codex/config.toml`) is
host-global, not per agent. So there is nothing to translate FROM. The target gets
its hooks from the claude skeleton: `cortextos add-agent --template agent` lays down
`templates/agent/.claude/settings.json`, which convert.py leaves in place (it only
adds `enableAllProjectMcpServers: true` when MCP servers migrate).

| Behavior on codex (where it lived) | On claude (settings.json) | Disposition |
|---|---|---|
| autonomy: `approvalPolicy:'never'` + `danger-full-access` (adapter) | `--dangerously-skip-permissions` (daemon default) + `permissions.defaultMode: bypassPermissions` | equivalent |
| idle flag: adapter `writeIdleFlag()` | `Stop` -> `cortextos bus hook-idle-flag` | equivalent |
| context status: adapter `writeContextStatus()` | `statusLine` -> `cortextos bus hook-context-status` | equivalent |
| crash alert: daemon `handleExit` | `SessionEnd` -> `cortextos crash-alert` (daemon handling also stays) | equivalent |
| boot notification: daemon `maybeSendCodexBootNotification` | the agent's own boot step in AGENTS.md | equivalent |
| — (no codex equivalent) | `PermissionRequest[ExitPlanMode]` -> `hook-planmode-telegram` | **GAINED** |
| — | `PreToolUse[AskUserQuestion]` -> `hook-ask-telegram` | **GAINED** |
| — | `PreCompact` -> `hook-compact-telegram` | **GAINED** |
| — | `PreToolUse` -> `hook-loop-detector`, `PermissionRequest` -> `hook-permission-telegram` | **GAINED** |

Nothing is dropped in this direction. The three in-turn Telegram behaviors that the
claude->codex migration loses come back. Report them as gained, not as work.

Per-host codex `notify` (if set) is not migrated: it is host-global and stays with
the codex install.
