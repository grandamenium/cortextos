# Codex app-server opt-in

The `codex-app-server` runtime requires an explicit per-agent opt-in. Setting
only `"runtime": "codex-app-server"` is not enough: the daemon halts that
agent before constructing its runtime process unless
`"allow_codex_app_server"` is exactly `true`.

This guard makes copied and hand-edited configuration default to the safer
state. It does not change secret handling, sandboxing, or approval policy;
those are separate hardening concerns.

## New agents

Use either supported CLI form:

```bash
cortextos add-agent worker --runtime codex-app-server --org myorg
cortextos add-agent worker --template agent-codex --org myorg
```

Both are deliberate codex selections. The scaffolder writes the runtime and
opt-in together:

```json
{
  "runtime": "codex-app-server",
  "allow_codex_app_server": true
}
```

The checked-in `templates/agent-codex/config.json` carries the same setting.

## Existing agents

After upgrading, run:

```bash
cortextos doctor
```

Doctor warns for each legacy codex config where the opt-in is missing or is
not a boolean. Review each agent before choosing one of these states:

```json
"allow_codex_app_server": true
```

Use `true` to authorize that agent, then restart it. Use `false` to keep the
runtime disabled deliberately. An absent, malformed, or false value never
starts a codex app-server process.

## Hand-edited runtime changes

When changing an existing agent from another runtime, edit both fields in the
same review:

```json
{
  "runtime": "codex-app-server",
  "allow_codex_app_server": true
}
```

Changing the runtime field alone leaves the agent halted. The daemon log and
`cortextos doctor` both point to the required setting so the failure is
actionable rather than silent.
