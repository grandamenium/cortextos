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
| `state/<src>/` | `state/<target>/` | `.onboarded`, crash/ctx-circuit markers, handoffs/ carried; heartbeat and delivery/scheduling state (`heartbeat.json`, `pending-reminders.json`, `.telegram-offset`, dedup hashes, `cron-state.json`) stay with the live source; codex thread files excluded; `.force-fresh` marker written |
| identity/soul/memory/goals/workspaces | same | 1:1; >100 MB items (and their sqlite -wal/-shm sidecars) and virtualenvs listed, not copied. Carried history dirs (memory/, handoffs/, logs/, docs/, ...) are left as written — only instructions, skills and scripts get path rewrites |

Detail: `references/hooks-disposition.md`, `references/mcp-json-keys.md`,
`references/leakage-tokens.txt`, `references/claude-bundled-skills.txt`.

## How to run this: walk the USER through it

### STEP 1 — DETECT + plain-language summary (no changes)

```bash
# use ABSOLUTE paths throughout
SKILL_DIR="<absolute path to the dir containing this SKILL.md>"
FRAMEWORK="<absolute path to your cortextOS checkout>"     # holds orgs/ and templates/
SRC_AGENT="<source codex agent>"; ORG="<org>"; INSTANCE="default"
SRC_DIR="$FRAMEWORK/orgs/$ORG/agents/$SRC_AGENT"
CTX_ROOT="$(grep -E '^CTX_ROOT=' "$SRC_DIR/.cortextos-env" | cut -d= -f2-)"
TARGET="${TARGET_NAME:-${SRC_AGENT%-codex}-claude}"
WORK="$(mktemp -d)"                                          # manifest + logs
python3 "$SKILL_DIR/scripts/detect.py" --src-dir "$SRC_DIR" --ctx-root "$CTX_ROOT" \
  --agent "$SRC_AGENT" > "$WORK/manifest.json"
```

detect.py is read-only. It refuses (exit 2, `hard_stops`) if the source is not
`codex-app-server` or has no AGENTS.md. Tell the user, in plain language: current
model, skills (bundled / custom / needs-human), crons (`config.cron_union_count`,
including `registry_only_crons`), files still naming the source
(`instructions.source_self_refs`), MCP servers (migrating vs
skipped and why), the inline-secret FINDINGS, items not carried (>100 MB,
virtualenvs), and what needs them.

### STEP 2 — DRY-RUN convert, show the full plan

```bash
python3 "$SKILL_DIR/scripts/convert.py" --manifest "$WORK/manifest.json" \
  --src-dir "$SRC_DIR" --target-dir "$FRAMEWORK/orgs/$ORG/agents/$TARGET" \
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
- **Crons**: carried OFF by default (every cron `type: "disabled"`), because the
  codex source keeps running and live crons on the copy would fire every job twice.
  `--enable-crons` keeps the source's enabled-state — use it only if the source is
  already stopped. Otherwise turn crons on at cutover (below).
- **Boot**: leave disabled (default) or `--boot now`.
- **Large items**: `--include-large` to also copy >100 MB items.

### STEP 4 — APPLY

```bash
cortextos add-agent "$TARGET" --template agent --org "$ORG" --instance "$INSTANCE"
python3 "$SKILL_DIR/scripts/convert.py" ...same args... --apply [STEP 3 flags]
```

To build the copy in a different instance than the source (e.g. an isolated test
instance), pass `--target-ctx-root <that instance's CTX_ROOT>`: source state and the
source cron registry are read from `--ctx-root`; target state and the target's
enabled-agents entry are written to `--target-ctx-root` (the daemon creates the
target's cron registry from config.json on first boot). verify.py takes the matching `--source-ctx-root`.

`add-agent` first is mandatory: convert.py overlays onto the claude skeleton and
refuses `--apply` without `.claude/settings.json` in the target. add-agent registers
the target `enabled:true`; convert.py flips the REGISTRY entry to `enabled:false`
(the daemon's off switch) unless `--boot now`, and leaves `config.json` enabled — so
`cortextos enable <target> --instance <id>` alone boots it later, and
`cortextos disable` stops it.

### Flags reference

| script | flag | meaning |
|---|---|---|
| detect.py | `--codex-config` | codex host config (default `~/.codex/config.toml`) |
| detect.py | `--framework-root` | checkout whose `templates/` the bundled-skill comparison uses (default: derived from `--src-dir`) |
| convert.py | `--apply` | write (default is dry-run) |
| convert.py | `--model` | Claude id; default Opus from list-models |
| convert.py | `--bot-mode none\|new`, `--new-bot-token` | bot handling (see STEP 3) |
| convert.py | `--enable-crons` | keep source cron enabled-state (default: all carried disabled); `--disable-crons` is an accepted no-op |
| convert.py | `--include-large` | also copy >100 MB items |
| convert.py | `--boot now\|no`, `--org`, `--instance` | `--boot now` runs `cortextos enable <target> --instance <instance> [--org <org>]` |
| convert.py | `--target-ctx-root` | target instance CTX_ROOT when it differs from the source's `--ctx-root` |
| verify.py | `--ctx-root` | the TARGET instance CTX_ROOT |
| verify.py | `--source-ctx-root` | the source instance CTX_ROOT, when different |
| cutover_crons.py | `--names` or `--from-source`, `--apply` | cutover: turn crons on in config.json and the registry together |
| verify.py | `--expect-boot`, `--bot-mode`, `--codex-config`, `--expect-crons-enabled` | match what convert was run with (by default verify FAILS if any carried cron is live) |

### Test copy in an isolated instance (recommended before a real migration)

Run the copy where it cannot touch the live fleet: a separate framework root and
instance. Example with `T` = a scratch checkout of cortextOS (built) and instance `c2c-test`:

```bash
# save as a script and run it (`zsh test-copy.sh` or `bash test-copy.sh`); do not
# paste into an interactive shell — `set -e` would close it on the first error.
# `set -e` stops at the first failed step; if a wait loop
# below runs longer than ~5 minutes, Ctrl-C and check $WORK/daemon.log.
set -e
# `tenv` runs a command against the TEST instance only:
# it drops any agent-session paths you may be running inside and points at T.
TEST_CTX="$HOME/.cortextos/c2c-test"
tenv() { env -u CTX_AGENT_NAME -u CTX_AGENT_DIR -u CTX_PROJECT_ROOT \
  CTX_INSTANCE_ID=c2c-test CTX_ROOT="$TEST_CTX" CTX_FRAMEWORK_ROOT="$T" CTX_ORG="$ORG" "$@"; }

# 1. org files the agent reads; symlinks so nothing is copied or edited
mkdir -p "$T/orgs/$ORG/agents"
for f in secrets.env knowledge.md context.json; do
  if [ -e "$FRAMEWORK/orgs/$ORG/$f" ] && [ ! -e "$T/orgs/$ORG/$f" ]; then
    ln -s "$FRAMEWORK/orgs/$ORG/$f" "$T/orgs/$ORG/$f"; fi; done

# 2. detect, comparing bundled skills against the templates the skeleton comes from
python3 "$SKILL_DIR/scripts/detect.py" --src-dir "$SRC_DIR" --ctx-root "$CTX_ROOT" \
  --agent "$SRC_AGENT" --framework-root "$T" > "$WORK/manifest.json"

# 3. dry-run, then review the plan (nothing is written; its "no .claude/settings.json
#    — run add-agent first" NOTE is expected here, add-agent is the next step)
CONVERT=(python3 "$SKILL_DIR/scripts/convert.py" --manifest "$WORK/manifest.json"
  --src-dir "$SRC_DIR" --target-dir "$T/orgs/$ORG/agents/$TARGET" --target-agent "$TARGET"
  --ctx-root "$CTX_ROOT" --target-ctx-root "$TEST_CTX" --org "$ORG" --instance c2c-test)
"${CONVERT[@]}"

# 4. skeleton from T's own CLI, then apply and verify. add-agent ends with "edit .env
#    with your Telegram settings" and "cortextos start" hints — ignore both: the copy
#    is bus-only on purpose and "start" targets the default instance.
tenv node "$T/dist/cli.js" add-agent "$TARGET" --template agent --org "$ORG" --instance c2c-test
"${CONVERT[@]}" --apply
python3 "$SKILL_DIR/scripts/verify.py" --target-dir "$T/orgs/$ORG/agents/$TARGET" \
  --target-agent "$TARGET" --ctx-root "$TEST_CTX" \
  --source-ctx-root "$CTX_ROOT" --source-dir "$SRC_DIR" --source-agent "$SRC_AGENT"

# 5. register a probe sender so the copy's bus replies have an inbox to land in
python3 -c 'import json,sys; p=sys.argv[1]; r=json.load(open(p)); r["c2c-probe"]={"enabled":False,"org":sys.argv[2]}; json.dump(r,open(p,"w"),indent=2)' \
  "$TEST_CTX/config/enabled-agents.json" "$ORG"

# 6. start a daemon for the test instance, then enable the copy on it
tenv node "$T/dist/daemon.js" --instance c2c-test > "$WORK/daemon.log" 2>&1 &
# the daemon records its own pid ($! would be a subshell, since tenv is a function)
until [ -S "$TEST_CTX/daemon.sock" ]; do sleep 1; done
tenv node "$T/dist/cli.js" enable "$TARGET" --instance c2c-test --org "$ORG"
# ready = the first turn finished (the Stop hook wrote the idle flag)
until [ -f "$TEST_CTX/state/$TARGET/last_idle.flag" ]; do sleep 3; done

# 7. read-only probe; the reply lands in $TEST_CTX/inbox/c2c-probe/
tenv env CTX_AGENT_NAME=c2c-probe node "$T/dist/cli.js" bus send-message "$TARGET" normal \
  'Read-only probe: reply with your runtime and model id. Take no other action.'
until [ -n "$(ls -A "$TEST_CTX/inbox/c2c-probe" 2>/dev/null)" ]; do sleep 3; done
cat "$TEST_CTX/inbox/c2c-probe/"*

# 8. stop: disable the copy (so a later test daemon does not auto-boot it), then
#    stop ONLY the test daemon via its own pid file (it stops the claude session too)
tenv node "$T/dist/cli.js" disable "$TARGET" --instance c2c-test
DAEMON_PID="$(cat "$TEST_CTX/daemon.pid")"
kill "$DAEMON_PID"
while kill -0 "$DAEMON_PID" 2>/dev/null; do sleep 1; done; echo "test daemon stopped"
```

When you are done with the test copy, delete it and its instance
(`$T/orgs/$ORG/agents/$TARGET` and `$TEST_CTX`): it holds the source's credentials.

On boot the daemon may log "cron-teaching upgrade recommended ... Run cortextos bus
upgrade-cron-teaching <target>". That is the daemon's generic scan of any agent's
instruction files for old cron advice (the source has the same text); review it
separately, it is not a migration issue.

The copy's own `cortextos` calls run the host's installed CLI (whatever `cortextos`
resolves to on PATH), pointed at the test instance through its env — not `T`'s build.

convert.py can run in any shell: it queries `cortextos bus list-models` host-wide.

What isolation does and does not cover:
- The copy is bus-only (empty `BOT_TOKEN`, `telegram_polling: false`), all crons are
  disabled, and it is registered only in the test instance — so it cannot reach
  Telegram or fire scheduled work.
- It DOES keep the source's other credentials (the agent `.env` and org
  `secrets.env`: e.g. mail, iMessage, Notion). A booted copy can reach those
  services. Probe it with read-only requests only, and say so in the probe.
- To get bus replies from the copy, send probes as an agent name registered in the
  test instance; delivery to an unregistered sender name is refused.

### STEP 5 — VERIFY (the gate)

```bash
python3 "$SKILL_DIR/scripts/verify.py" --target-dir "$FRAMEWORK/orgs/$ORG/agents/$TARGET" \
  --target-agent "$TARGET" --ctx-root "$CTX_ROOT" \
  --source-dir "$SRC_DIR" --source-agent "$SRC_AGENT" [--expect-boot]
```

Not done until it exits 0. It asserts: claude runtime + Claude model id, codex-only
keys gone, enabled-state matches the chosen end state in config.json AND registry,
CLAUDE.md is exactly `@AGENTS.md`, settings.json hooks present, no `plugins/` /
`.agents/` left, no codex skill-path refs left, every portable source skill present,
the cron union carried in the daemon cron schema, the source config still codex, `.mcp.json` values are all
`${VAR}` refs, **the migration copied no inline secret from `~/.codex/config.toml`
into any target file** (reported by location, value never printed; a secret that
already sat in plain text in a SOURCE file and was carried 1:1 is printed as a
`[FINDING]` to redact, not a failure), `.env` 0600 without BOT_TOKEN and `telegram_polling: false`
(bot-mode none), `.onboarded` carried, no codex thread file.

Tier 2 boot probe (explicit go only; costs tokens): enable the target, wait for
`state/<target>/last_idle.flag` (the first turn finished), send a read-only bus probe
from a registered sender, confirm the reply, then disable it (see the test-copy
recipe for exact commands). Label it a boot probe, not a soak.

### CUTOVER — only when the Claude copy should REPLACE the codex agent

The copy and the source must never both be live on the same work. In this order:

1. Stop the codex source: `cortextos disable <source> --instance <id>`, and confirm its
   process is gone (`cortextos status`).
2. If the copy should take over the source's Telegram bot, put that `BOT_TOKEN` in the
   copy's `.env` and set `telegram_polling` back to true in its `config.json` (only now
   — one poller per bot).
3. Enable the copy: `cortextos enable <target> --instance <id>`.
4. Turn its crons on in BOTH config.json and the live registry (flipping only the
   registry is undone by any later re-migration, which rebuilds it from config.json):
   ```bash
   python3 "$SKILL_DIR/scripts/cutover_crons.py" --target-dir <target dir> \
     --target-agent <target> --instance <id> \
     --from-source --source-dir <source dir> --source-agent <source> \
     --source-ctx-root <source CTX_ROOT> --apply     # or --names a,b instead of --from-source
   ```
   Then `verify.py ... --expect-crons-enabled` asserts both files agree.
5. Watch the first cron fires (`cortextos bus get-cron-log <target>`).

Rollback: `cortextos disable <target>` then `cortextos enable <source>`.

### STEP 6 — REPORT

Fill `references/report-template.md`. Security findings and needs-human first, then
gained, transformed, 1:1. End with the exact enable command.

## Human steps no script does

1. **Codex wording.** AGENTS.md / IDENTITY.md / TOOLS.md often say "you are a codex
   agent (runtime: codex-app-server)". detect.py lists the lines; edit them. This wording
   is never auto-rewritten (only skill paths are).
2. **Env vars.** Add every `ENV VAR NEEDED ... NOT SET` to `orgs/<org>/secrets.env`.
   The skill never writes secrets.env or any secret value.
3. **Leaky custom skills** (codex tool semantics like `apply_patch`, `codex exec`) are
   not copied; rewrite them for Claude (skill-creator).
4. **Customized bundled skills.** The claude skeleton ships the stock copy; port any
   local change by hand.
5. **Not-carried items** (>100 MB, virtualenvs): copy or recreate if needed.
6. **Depth anchors.** `.claude/skills/<x>` is one level shallower than the codex
   layout; scripts flagged with depth-4 `__file__` anchors need a fix.
7. **Skill dirs without SKILL.md** are carried as data only; restore the SKILL.md if
   the skill was meant to work.
8. **Self-references.** Scripts/instructions that still name the source agent
   (`--agent <source>`, `${CTX_AGENT_NAME:-<source>}`) or read codex-only artifacts
   (`codex-tokens.jsonl`) are listed in `instructions.source_self_refs`; repoint them.
9. **`[FINDING]` lines from verify**: a secret already in plain text in the source
   (often an old handoff or memory note). Redact it in source and target.

## Safety invariants

- The source agent, its cron registry and its registry entry are never written.
  `--apply` with target == source is refused.
- Dry-run is the default; nothing writes without `--apply`.
- No MCP secret value is read into the manifest, written to `.mcp.json`, or written
  anywhere. verify.py is the independent gate for this.
- BOT_TOKEN is not carried by default (one poller per bot).
- `.cortextos-env` / `.playwright-mcp` are never copied; codex `plugins/` and
  `.agents/` never land in the target.
- The target is left DISABLED via its registry entry unless `--boot now`;
  `config.json` stays enabled so the standard `cortextos enable` boots it.

## Tests

`python3 tests/test_codex_to_claude.py` — synthetic fixtures with HOME and PATH
sandboxed (no real `~/.codex`, `~/.claude.json` or `cortextos` binary touched).
