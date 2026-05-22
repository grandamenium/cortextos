# Migrating to External Persistent Crons

Crons used to die on every agent restart. They now survive indefinitely. This guide explains what changed, what you need to do (nothing), and how to verify.

---

## What Changed

- **Before:** Crons were session-local (CronCreate via Claude API). Each agent restart meant crons were gone and had to be manually re-created.
- **After:** Crons live in `${CTX_ROOT}/state/{agent}/crons.json` and are daemon-managed. The scheduler reads this file on every agent start and re-schedules all entries automatically.
- **Migration:** The daemon auto-migrates `config.json` crons to `crons.json` on first boot per agent. A marker file `.crons-migrated` prevents re-runs. The source `config.json` is left untouched — non-destructive.

---

## What You Need to Do

Nothing. Migration runs automatically on the next daemon start.

---

## Verification

After the daemon starts, confirm migration ran and crons are scheduled:

```bash
# Shows all crons with next_fire_at
cortextos bus list-crons <agent>

# Execution history once crons start firing
cortextos bus get-cron-log <agent>

# Marker confirming migration ran (exists = done)
ls "${CTX_ROOT}/state/{agent}/.crons-migrated"

# Populated cron definitions
cat "${CTX_ROOT}/state/{agent}/crons.json"
```

---

## Manual Migration (if needed)

If auto-migration did not run, or you need to re-run it for a specific agent:

```bash
# Re-run for one agent
cortextos bus migrate-crons <agent>

# Re-run for all enabled agents
cortextos bus migrate-crons

# Bypass the marker and re-run regardless
cortextos bus migrate-crons <agent> --force
```

---

## Upgrading Existing Agent Skill/Bootstrap Files

The auto-migration handles cron *data* (`config.json` -> `crons.json`). It does not touch the cron *teaching* in your agent's bootstrap, skill, and onboarding files. Pre-migration workspaces frequently still tell the agent to use `CronCreate`, `/loop`, or hand-edit `config.json` to register a cron. After the switch to external persistent crons, every one of those instructions is wrong: `CronCreate` and `/loop` are session-only and evaporate on restart, and `config.json` is no longer the cron source of truth (the daemon owns `crons.json` directly).

The repo-shipped templates were swept clean in `0ccb3c98`, `b10711a4`, and `836f4759`. End-user agent workspaces created before that sweep need their own pass. The `cortextos bus upgrade-cron-teaching` command exists to find and (where safe) fix those leftovers.

### What Gets Detected

The scanner walks `CLAUDE.md`, `AGENTS.md`, `ONBOARDING.md`, and every `.claude/skills/**/SKILL.md` under the agent dir. It flags any line matching one of these patterns:

| Pattern | What it catches | Why it's wrong |
|---|---|---|
| `\bCronCreate\b` | Bare references to the `CronCreate` tool | `CronCreate` is for one-shot in-session reminders only. Persistent crons must use `cortextos bus add-cron`. |
| `/loop create cron` | The legacy "create cron via /loop" form | `/loop` is session-only and dies on restart. |
| `/loop <interval>` (e.g. `/loop 4h`, `/loop 30m`) | The "/loop your-prompt" cron-registration form | Same: session-only. |
| `(configured in config.json)` | Stale parenthetical about cron source-of-truth | Cron source of truth is now `crons.json`, written by `cortextos bus add-cron`. |
| `edit config.json` paired with `cron` on the same line | Operator instructions to hand-edit cron entries | The daemon owns `crons.json`. Hand-editing `config.json` no longer registers a cron. |

The canonical replacement teaching lives at:

- `templates/agent/CLAUDE.md` line 27 (session-start cron note) and line 120 (Crons section)
- `templates/agent/AGENTS.md` line 33 (session-start cron note) and line 419 (runtime add-cron instruction)

One-line replacement examples:

| Old | New |
|---|---|
| `Use CronCreate to schedule a 4h heartbeat` | `cortextos bus add-cron $CTX_AGENT_NAME heartbeat 4h '<prompt>'` |
| `/loop 4h heartbeat` | `cortextos bus add-cron $CTX_AGENT_NAME heartbeat 4h heartbeat` |
| `/loop create cron name=heartbeat ...` | `cortextos bus add-cron <agent> <name> <interval> <prompt>` |
| `(configured in config.json)` | `(configured via cortextos bus add-cron)` |
| `Edit config.json to add the cron entry` | `Run cortextos bus add-cron <agent> <name> <interval> <prompt>` |

### Running the Scanner

```bash
# Scan one agent (exits 1 if any matches remain)
cortextos bus upgrade-cron-teaching <agent>

# Scan every enabled agent under orgs/*/agents/*
cortextos bus upgrade-cron-teaching

# Machine-readable output for scripting / CI
cortextos bus upgrade-cron-teaching <agent> --json

# Apply the safe literal substitutions in-place
cortextos bus upgrade-cron-teaching <agent> --apply
```

The non-zero exit on any match makes this safe to wire into a pre-commit hook or CI gate.

### Whitelist Mechanics

Two opt-outs prevent false positives on lines that intentionally talk about the old patterns:

- **Per-line negation tokens.** If a line contains `do NOT`, `Never use`, `won't survive`, `session-only`, `evaporate`, `recurring: false`, or `deprecated`, the scanner skips it. This covers teaching-by-deprecation prose like *"Do NOT use CronCreate for persistent scheduling."*
- **Per-file sentinel marker.** A file containing the literal string `/loop is intentionally used` is skipped wholesale. This is the m2c1-worker carve-out: m2c1 worker agents legitimately use short-lived `/loop` for in-session task queueing, not for persistent crons.

### What `--apply` Will and Won't Touch

`--apply` performs only the safe literal substitution `(configured in config.json)` -> `(configured via cortextos bus add-cron)`. Everything else is reported but not rewritten. `CronCreate` and `/loop` matches in particular need a manual edit, because the surrounding sentence almost always has to change with them: a sentence like *"Use CronCreate to schedule X"* cannot be mechanically repaired without rewriting the verb and operand. Read the scanner report, then edit by hand using the canonical replacements above.

---

## Troubleshooting

**Cron not firing:**
1. `cortextos bus list-crons <agent>` — confirm the cron is registered and has a `next_fire_at`
2. `cortextos bus get-cron-log <agent>` — check execution history for `status: retried` or `status: failed`
3. If PTY injection is failing, check the daemon log: `~/.cortextos/$CTX_INSTANCE_ID/logs/<agent>/`

**Migration did not run:**
- No marker file? Run `cortextos bus migrate-crons <agent>` manually.
- Check that `config.json` has a `crons` array — migration only imports from it if the array exists.

**Cron fires but agent does not react:**
- Check daemon log; PTY injection may have failed (three attempts: 1s, 4s, 16s backoff).
- `get-cron-log` will show `status: retried` entries.

**Malformed or empty crons.json:**
- If `crons.json` is corrupt (parse error), `readCrons()` automatically falls back to `crons.json.bak` — the previous good copy written by `writeCrons()`. A warning is logged to stderr; no operator action is required for a single corruption event.
- If both the primary file and the `.bak` are unparseable, `readCrons()` returns `[]` and the scheduler starts with an empty schedule. Fix: write a valid `crons.json` using `cortextos bus add-cron`, or restore from a known-good backup.
- **Reload-to-empty protection (`lastGoodSchedule`):** if a `reload()` produces an empty schedule on a running scheduler (e.g. transient file corruption mid-tick), the scheduler retains the last successfully loaded schedule in memory and logs a warning. Crons keep firing until the file is repaired. This protection applies to reloads only — an empty file at initial `start()` produces an empty schedule normally.
- You can verify the file is valid JSON: `cat "${CTX_ROOT}/state/{agent}/crons.json" | python3 -m json.tool`

**Disk full (ENOSPC / EACCES) during tick:**
- If `updateCron()` fails when persisting `last_fired_at` after a successful fire (e.g. disk full or read-only filesystem), the error is caught and logged to stderr. The in-memory schedule is kept intact and crons continue firing. State (`last_fired_at`, `fire_count`) will not be persisted until the write succeeds, so it may be lost if the daemon restarts before disk space is recovered.

**Need to revert:**
- Delete `${CTX_ROOT}/state/{agent}/crons.json` and `${CTX_ROOT}/state/{agent}/.crons-migrated`.
- The daemon will re-migrate from `config.json` on next start.
- Adding crons back via CronCreate is not recommended — session-local crons are unreliable.

---

## Backward Compatibility

- Existing `config.json` crons are unchanged. The daemon reads from `crons.json` only after migration.
- Bus commands (`add-cron`, `list-crons`, `remove-cron`, etc.) operate on `crons.json` directly.
- If you delete `.crons-migrated` and re-run, migration re-imports from `config.json`.
- New crons should be added via `cortextos bus add-cron`, not edited in `config.json` directly.
- Syntax: `cortextos bus add-cron <agent> <name> <interval|cron-expr> <prompt...>`

---

---

## Dashboard (Phase 4)

The web dashboard exposes a dedicated Workflows section for managing and monitoring crons:

| Route | Purpose |
|-------|---------|
| `/workflows` | Fleet overview — health summary panel + read-only cron table (all agents) |
| `/workflows/health` | Dedicated fleet health page with gap detection across all crons |
| `/workflows/[agent]/[name]` | Cron detail page — edit form, execution history, test-fire button |
| `/workflows/new` | Create new cron for any agent |

**Test-Fire button:** Each cron detail page has a "Test Fire" button that injects the cron's prompt into the agent immediately. A confirmation dialog is shown before firing. A 30-second cooldown prevents accidental rapid-fire (enforced both client-side and server-side via IPC `fire-cron`). After a successful fire the execution history auto-refreshes after 6 seconds.

**`manualFireDisabled` flag:** Setting `manualFireDisabled: true` on a cron definition disables the test-fire button and returns HTTP 403 from the API. Use this for crons that must only fire on schedule (e.g. financial reports, external API calls with rate limits). Operators can set this field via `cortextos bus update-cron` or the cron edit form.

**Execution history:** The detail page shows paginated execution history (100 entries/page) with status filter (All / Success / Failure) and CSV/JSON export. Columns: Timestamp, Status (success/retried/failed), Duration, Error.

**Fleet health caching:** The `/api/workflows/health` endpoint caches results for 30 seconds to avoid hammering disk on rapid dashboard polls. The cache is invalidated after any cron mutation (add/update/remove/fire).

---

## Architecture Reference

| Concern | File |
|---------|------|
| Cron schema | `src/types/index.ts` (`CronDefinition`) |
| File I/O | `src/bus/crons.ts` (`readCrons` with `.bak` fallback, `writeCrons` with `keepBak: true`) |
| Atomic write + `.bak` | `src/utils/atomic.ts` (`atomicWriteSync(path, data, keepBak)`) |
| Daemon scheduler | `src/daemon/cron-scheduler.ts` (`lastGoodSchedule`, ENOSPC catch in `tick()`) |
| IPC mutation handlers | `src/daemon/ipc-server.ts` (`handleAddCron`, `handleUpdateCron`, `handleRemoveCron`, `handleFireCron`) |
| Fleet health | `src/daemon/ipc-server.ts` (`computeFleetHealth`, 30s cache + invalidation) |
| Bus commands | `src/cli/bus.ts` (search `add-cron`, `list-crons`) |
| Migration logic | `src/daemon/cron-migration.ts` |
| Execution logging | `src/daemon/cron-execution-log.ts` |
| Dashboard — fleet overview | `dashboard/src/app/(dashboard)/workflows/page.tsx` |
| Dashboard — cron detail | `dashboard/src/app/(dashboard)/workflows/[agent]/[name]/page.tsx` |
| Dashboard — health page | `dashboard/src/app/(dashboard)/workflows/health/page.tsx` |
| Dashboard — test-fire button | `dashboard/src/components/workflows/test-fire-button.tsx` |
| Dashboard — execution history | `dashboard/src/components/workflows/cron-history.tsx` |
| API — fleet list | `dashboard/src/app/api/workflows/crons/route.ts` (GET/POST) |
| API — cron detail | `dashboard/src/app/api/workflows/crons/[agent]/[name]/route.ts` (PATCH/DELETE) |
| API — execution log | `dashboard/src/app/api/workflows/crons/[agent]/[name]/executions/route.ts` |
| API — manual fire | `dashboard/src/app/api/workflows/crons/[agent]/[name]/fire/route.ts` |
| API — fleet health | `dashboard/src/app/api/workflows/health/route.ts` |
