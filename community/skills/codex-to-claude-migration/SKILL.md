---
name: codex-to-claude-migration
description: >-
  Migrate ANY cortextOS agent from the codex-app-server runtime back to the
  claude-code runtime. Use this whenever a user wants to convert, port, move or
  switch a Codex-cortextOS agent to Claude / Claude Code / Opus / Sonnet, "make
  agent X run on claude", "move my codex agent back to claude", or asks how a
  codex agent's AGENTS.md / plugins skills / ~/.codex/config.toml MCP servers map
  onto a Claude agent. Takes a source agent and produces a SEPARATE claude-code
  agent (non-destructive, dry-run by default, the source is never modified or
  stopped). Partner of claude-to-codex-migration. Do NOT use for creating a new
  claude agent from scratch (use `cortextos add-agent`) or for hermes/opencode.
---

# Codex -> Claude Agent Migration

Convert a `runtime: codex-app-server` cortextOS agent into a separate
`runtime: claude-code` agent. This is the reverse of `claude-to-codex-migration`:
same contract (general, dry-run by default, nothing silently dropped), reversed
mapping, and one stricter rule — there is NO cutover mode. The source agent is
never modified, disabled or stopped; the result is always a second agent.

## The mapping at a glance

| Codex artifact | Claude artifact | How |
|---|---|---|
| `AGENTS.md` | `AGENTS.md` + `CLAUDE.md` = `@AGENTS.md` | shared-instructions pattern: AGENTS.md stays the single source, CLAUDE.md is a one-line import; codex skill paths rewritten |
| `plugins/cortextos-agent-skills/skills/<x>`, `.agents/skills/<x>` | `.claude/skills/<x>` | bundled skills come from the claude skeleton; custom skills leakage-grepped then copied |
| (no per-agent hooks; adapter does it natively) | `.claude/settings.json` hooks | from the skeleton; plan-mode / AskUserQuestion / PreCompact Telegram hooks are GAINED |
| `~/.codex/config.toml [mcp_servers.*]` (host-global) | target `.mcp.json` | `${VAR}` references ONLY; secrets never copied; env vars to set are listed |
| `config.json` runtime/model | `runtime: claude-code`, Claude model id | Opus by default: the `claude-opus-*` id from `cortextos bus list-models claude-code` |
| crons (config.json + live registry) | `config.json` crons[] | UNION, paths translated, emitted in the daemon's config schema only (`name,type,interval,cron,fire_at,prompt`; a disabled cron is `type: "disabled"` — an `enabled` key makes the daemon REFUSE the cron) |
| `.env` | `.env` (0600) | BOT_TOKEN NOT carried by default (source still polls the bot); the copy is marked bus-only with `telegram_polling: false`, without which `cortextos enable` refuses it |
| `state/<src>/` | `state/<target>/` | `.onboarded` + continuity markers carried; codex thread files excluded; `.force-fresh` |
| identity/soul/memory/goals/workspaces | same | 1:1; >100 MB items and virtualenvs listed, not copied |

Detail: `references/hooks-disposition.md`, `references/mcp-json-keys.md`,
`references/leakage-tokens.txt`, `references/claude-bundled-skills.txt`.

## How to run this: walk the USER through it

### STEP 1 — DETECT + plain-language summary (no changes)

```bash
SKILL_DIR="<absolute path to the dir containing this SKILL.md>"
SRC_AGENT="<source codex agent>"; ORG="<org>"; INSTANCE="default"
CTX_ROOT="$(grep -E '^CTX_ROOT=' orgs/$ORG/agents/$SRC_AGENT/.cortextos-env | cut -d= -f2-)"
SRC_DIR="orgs/$ORG/agents/$SRC_AGENT"
TARGET="${TARGET_NAME:-${SRC_AGENT%-codex}-claude}"
python3 "$SKILL_DIR/scripts/detect.py" --src-dir "$SRC_DIR" --ctx-root "$CTX_ROOT" \
  --agent "$SRC_AGENT" > /tmp/c2c-$SRC_AGENT.json
```

detect.py is read-only. It refuses (exit 2, `hard_stops`) if the source is not
`codex-app-server` or has no AGENTS.md. Tell the user, in plain language: current
model, skills (bundled / custom / needs-human), crons, MCP servers (migrating vs
skipped and why), the inline-secret FINDINGS, items not carried (>100 MB,
virtualenvs), and what needs them.

### STEP 2 — DRY-RUN convert, show the full plan

```bash
python3 "$SKILL_DIR/scripts/convert.py" --manifest /tmp/c2c-$SRC_AGENT.json \
  --src-dir "$SRC_DIR" --target-dir "orgs/$ORG/agents/$TARGET" \
  --target-agent "$TARGET" --ctx-root "$CTX_ROOT"
```

A dry-run works before the target exists and writes nothing. The action log (stderr)
plus the JSON (stdout: `model`, `env_vars`, `actions`) is the approval artifact.

### STEP 3 — ASK, then WAIT

- **Target name** (default `<source minus -codex>-claude`). Never the source's own dir.
- **Model** (default: Opus — the `claude-opus-*` id from `cortextos bus list-models
  claude-code`, best tier first; `--model` overrides).
- **Bot**: `none` (default — no BOT_TOKEN; bus-only until a token is added) or
  `new` with a fresh @BotFather token (`--bot-mode new --new-bot-token <t>`).
  Reusing the source's bot is out of scope: it would require stopping the source.
- **Crons**: carry as-is (default) or `--disable-crons` (every recurring cron carried as
  `type: "disabled"`; use for test copies so nothing fires twice alongside the
  still-running source).
- **Boot**: leave disabled (default) or `--boot now`.
- **Large items**: `--include-large` to also copy >100 MB items.

### STEP 4 — APPLY

```bash
cortextos add-agent "$TARGET" --template agent --org "$ORG" --instance "$INSTANCE"
python3 "$SKILL_DIR/scripts/convert.py" ...same args... --apply [STEP 3 flags]
```

To build the copy in a different instance than the source (e.g. an isolated test
instance), pass `--target-ctx-root <that instance's CTX_ROOT>`: source state and the
cron registry are read from `--ctx-root`, target state and registry are written to
`--target-ctx-root`. verify.py takes the matching `--source-ctx-root`.

`add-agent` first is mandatory: convert.py overlays onto the claude skeleton and
refuses `--apply` without `.claude/settings.json` in the target. add-agent registers
the target `enabled:true`; convert.py flips it to `enabled:false` in BOTH config.json
and the registry unless `--boot now`.

### STEP 5 — VERIFY (the gate)

```bash
python3 "$SKILL_DIR/scripts/verify.py" --target-dir "orgs/$ORG/agents/$TARGET" \
  --target-agent "$TARGET" --ctx-root "$CTX_ROOT" \
  --source-dir "$SRC_DIR" --source-agent "$SRC_AGENT" [--expect-boot]
```

Not done until it exits 0. It asserts: claude runtime + Claude model id, codex-only
keys gone, enabled-state matches the chosen end state in config.json AND registry,
CLAUDE.md is exactly `@AGENTS.md`, settings.json hooks present, no `plugins/` /
`.agents/` left, no codex skill-path refs left, every portable source skill present,
the cron union carried in the daemon cron schema, the source config still codex, `.mcp.json` values are all
`${VAR}` refs, **no inline secret from `~/.codex/config.toml` appears in any target
file** (reported by location, value never printed), `.env` 0600 without BOT_TOKEN and `telegram_polling: false`
(bot-mode none), `.onboarded` carried, no codex thread file.

Tier 2 boot probe (explicit go only; costs tokens): enable the target, wait for the
Claude status bar in `stdout.log` (bootstrap), send a bus probe, confirm the reply
and `last_idle.flag`, then disable it. Label it a boot probe, not a soak.

### STEP 6 — REPORT

Fill `references/report-template.md`. Security findings and needs-human first, then
gained, transformed, 1:1. End with the exact enable command.

## Human steps no script does

1. **Codex wording.** AGENTS.md / IDENTITY.md / TOOLS.md often say "you are a codex
   agent (runtime: codex-app-server)". detect.py lists the lines; edit them. Prose is
   never auto-rewritten.
2. **Env vars.** Add every `ENV VAR NEEDED ... NOT SET` to `orgs/<org>/secrets.env`.
   The skill never writes secrets.env or any secret value.
3. **Leaky custom skills** (codex tool semantics like `apply_patch`, `codex exec`) are
   not copied; rewrite them for Claude (skill-creator).
4. **Customized bundled skills.** The claude skeleton ships the stock copy; port any
   local change by hand.
5. **Not-carried items** (>100 MB, virtualenvs): copy or recreate if needed.
6. **Depth anchors.** `.claude/skills/<x>` is one level shallower than the codex
   layout; scripts flagged with depth-4 `__file__` anchors need a fix.

## Safety invariants

- The source agent, its cron registry and its registry entry are never written.
  `--apply` with target == source is refused.
- Dry-run is the default; nothing writes without `--apply`.
- No MCP secret value is read into the manifest, written to `.mcp.json`, or written
  anywhere. verify.py is the independent gate for this.
- BOT_TOKEN is not carried by default (one poller per bot).
- `.cortextos-env` / `.playwright-mcp` are never copied; codex `plugins/` and
  `.agents/` never land in the target.
- The target is left DISABLED in config.json AND the registry unless `--boot now`.

## Tests

`python3 tests/test_codex_to_claude.py` — synthetic fixtures with HOME and PATH
sandboxed (no real `~/.codex`, `~/.claude.json` or `cortextos` binary touched).
