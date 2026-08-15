# fleet-health-check.sh — Skip Agents With enabled=false

**Status:** Design — not yet implemented
**Priority:** Medium (noise reduction, no functional bug)
**Owner:** develop (implementation), analyst (design), capitan (approval)
**Last updated:** 2026-08-15
**Related:** theta 65, `project_fb_communicator_disabled`, `feedback_stale_heartbeat_not_crash`

---

## Problem

`scripts/fleet-health-check.sh` classifies fb-communicator as `stale_verified` on every run (currently ~163h stale, heartbeat + process both dead). fb-communicator is **intentionally disabled** — its `config.json` has `enabled: false`. Analyst has to filter it out mentally on every heartbeat cycle.

Same script emits a `stale_verified` warning event each time it runs → noise in the analytics stream and false-positive stale entries that must be re-explained in memory (`project_fb_communicator_disabled`).

## Root cause

Line 46-101 in `scripts/fleet-health-check.sh` iterates every agent returned by `cortextos bus list-agents`. It checks `.running` and `last_heartbeat` but has no notion of "intentionally disabled." An agent with `config.json` `enabled: false` looks identical to a crashed one from the script's perspective.

Note also: `list-agents` returns `enabled: true` for fb-communicator (probably from an in-memory roster), while `config.json` `enabled: false` is the ground truth for intent-to-run. The script should trust `config.json`, not `list-agents`.

## Proposed fix

Add a **pre-loop skip** on `config.json` `enabled: false`:

```bash
# Once, near the other path vars (after EVENTS_DIR):
# config.json is in the REPO tree, not under CTX_ROOT (state/analytics only).
REPO_ROOT="${CTX_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Inside the while-loop, immediately after NAME is extracted:
CONFIG_PATH="${REPO_ROOT}/orgs/${ORG}/agents/${NAME}/config.json"
if [[ -f "$CONFIG_PATH" ]]; then
  CONFIG_ENABLED=$(jq -r '.enabled' "$CONFIG_PATH" 2>/dev/null)
  [[ "$CONFIG_ENABLED" == "false" ]] && continue  # intentionally disabled
fi
```

Placement: right after the `NAME=` extraction, before `RUNNING=`/`LAST_HB=`/the
age check and — crucially — before the `CHECKED=` increment, so disabled agents
don't count toward `.checked` in the JSON summary.

**Two corrections vs the original draft (both verified empirically, 2026-08-15):**

- **Path base is `CTX_PROJECT_ROOT`, not `CTX_ROOT`.** `CTX_ROOT`
  (`~/.cortextos/<instance>`) holds only runtime state (`state/`) and analytics
  (`orgs/<org>/analytics/events`) — it has no `orgs/<org>/agents` tree. The
  agent `config.json` (ground truth for enable/disable intent) lives in the repo
  checkout at `${CTX_PROJECT_ROOT}/orgs/<org>/agents/<name>/config.json`. We fall
  back to deriving the repo root from `BASH_SOURCE` so the script also works when
  `CTX_PROJECT_ROOT` is unset.
- **Use plain `jq -r '.enabled'`, NOT `.enabled // true`.** jq's `//` is the
  *alternative* operator: it treats `false` **and** `null` as "absent", so
  `false // true` evaluates to `true` and the skip would never fire. Plain
  `.enabled` yields `"false"` (skip), `"true"` (proceed), `"null"` when the field
  is missing (proceed → default-enabled), and empty on malformed JSON
  (proceed → fail-open). All four cases fall out of a single `== "false"` test.

## Blast radius

- **Reduces noise:** fb-communicator (and any future intentionally-disabled agent) no longer surfaces as stale.
- **No false negatives:** disabled agents by definition should not be flagged as unhealthy. They are supposed to be dead.
- **No behavior change on running agents:** all other paths untouched.
- **Cost:** 6 bash lines, 1 file read per agent per invocation.

## Edge cases

- **Config file missing:** treat as enabled (current behavior). Don't fail the whole script on a missing config; log-only in a future iteration if noise persists.
- **Malformed JSON:** `jq` returns empty; the `[[ ... == "false" ]]` check fails; agent proceeds through normal stale detection. Fail-open.
- **Agent enabled but PM2 process dead:** correctly flagged as `stale_verified` (unchanged).
- **Agent disabled and later re-enabled mid-day:** next fleet-health-check run reads fresh `config.json` and re-includes it. No cache.

## Test spec (for develop)

Implemented as `tests/scripts/fleet-health-check.test.ts` — a vitest suite that
shells out to the real script with a stub `cortextos` (canned `bus list-agents`,
no-op `bus log-event`) and temp `CTX_PROJECT_ROOT` config fixtures.

**Darwin-gated (`describe.skipIf(process.platform !== 'darwin')`).** The script
parses timestamps with BSD `date -u -j -f`, absent on GNU/Linux; CI runs on
ubuntu-latest, where the age computation fails for every agent (`HB_TS=0` → early
`continue`) and the non-skip cases can't be exercised. The suite runs on the
fleet Mac (where the script actually executes) and is skipped, not failed, on CI.
Same `skipIf` pattern already used elsewhere in the repo.

### Test 1 — enabled: false is skipped
```
given: fixture agent with config.json {enabled: false}, last_heartbeat 200h ago, running: false
when:  fleet-health-check runs
then:  agent NOT in verified/suspect/dismissed
       checked count does NOT include this agent
       no log-event emitted for this agent
```

### Test 2 — enabled: true still classified normally
```
given: fixture agent config.json {enabled: true}, last_heartbeat 200h ago, running: false
when:  fleet-health-check runs
then:  agent in verified list
       stale_verified event emitted
```

### Test 3 — missing enabled field treated as enabled
```
given: fixture agent config.json without enabled field, last_heartbeat 200h ago, running: false
when:  fleet-health-check runs
then:  agent in verified list (default-enabled)
```

### Test 4 — malformed config.json fails open
```
given: fixture agent config.json is invalid JSON, last_heartbeat 200h ago, running: false
when:  fleet-health-check runs
then:  agent in verified list (safe default)
       no script crash
```

### Test 5 — fresh agent (heartbeat recent) with enabled: false still skipped
```
given: fixture agent config.json {enabled: false}, last_heartbeat 10min ago
when:  fleet-health-check runs
then:  agent NOT counted in checked (skipped before the age-check)
```

---

## Rollout

1. develop implements + tests. Simple bash change; no daemon-side compile.
2. Design doc `git add -f` in the same PR (past `docs/.gitignore:47`).
3. capitan reviews, merges.
4. **Deploy note — the script is currently UNTRACKED.** `scripts/fleet-health-check.sh`
   was never committed to any branch (local working-tree file only), so this PR
   *adds* the whole script (with the fix baked in) rather than diffing 6 lines.
   Consequence: merging upstream does **not** by itself make the fix live on the
   fleet Mac — the running copy is the untracked working-tree file, and a `git
   pull` of the merged branch would even conflict with it ("untracked working
   tree files would be overwritten"). Going live is a separate step: apply the
   same skip to the working-tree copy (live on the next cron, no restart) and
   then reconcile the working tree with the now-tracked file. Ownership of that
   working-tree/prod step is capitan's call (see Out of scope).
5. Live-verify: run fleet-health-check.sh, confirm fb-communicator is absent from all three lists AND `.checked` count drops by 1 (from 11 to 10).
6. Remove `project_fb_communicator_disabled` from analyst memory as obsolete after verify (or condense to «was noise-suppressed 2026-08-15 in fleet-health-check.sh»).

## Out of scope

- Fixing the `list-agents` inconsistency (returns `enabled: true` for an agent whose config says `false`). Separate concern — the daemon's in-memory roster is not the source of truth for intent.
- Cleaning up fb-communicator's `runtime: codex-app-server` leftover from decommissioned codex (theta 65-candidate: codex code removal is separately deferred).
- Auto-disabling agents based on crash counts.

## Non-goals

- Perfect fidelity between config and roster. This fix trusts `config.json` for intent; other tools may still show the roster state.
