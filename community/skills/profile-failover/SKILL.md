---
name: profile-failover
description: "Boss runbook for handling `profile_quota_exhausted` bus events. When an agent's Claude account hits a quota limit, swap that agent to its configured `fallback_profile` and soft-restart it. Cold-boot semantics — Claude Code session state is per-config-dir, conversation history is lost across the swap. Use this skill when you observe a `profile_quota_exhausted` event on the bus or in an agent's heartbeat report."
triggers: ["profile_quota_exhausted", "rate limit", "quota exhausted", "fallback profile", "switch claude account", "agent quota", "credit balance too low", "HTTP 429"]
external_calls: ["cortextos profile-failover", "cortextos bus send-telegram"]
---

# Profile Failover (BL-003 phase 3)

When an agent's Claude account quota-exhausts, boss swaps that agent
to its `fallback_profile` and soft-restarts it. The mechanics are
deterministic (a CLI primitive); your job is the judgment — WHICH
agent, WHEN, and what to tell Saurav.

This runbook documents the decision tree. The atomic mechanic is
`cortextos profile-failover --agent X --trigger <event_id>`.

---

## Trigger

A `profile_quota_exhausted` event on the bus, emitted by the
SessionEnd hook (BL-003 phase 2) when stderr/stdout match an
Anthropic API quota error pattern. Event metadata:

```json
{
  "agent": "engineer",
  "profile": "personal",
  "error_pattern": "rate_limit_exceeded",
  "observed_at": "2026-05-08T20:30:00Z",
  "exit_code": null
}
```

cortextOS does not (yet) expose a `list-events` bus subcommand.
Read the analytics events tree directly. Each agent has a per-day
JSONL file at:

```
~/.cortextos/$CTX_INSTANCE_ID/orgs/$CTX_ORG/analytics/events/<agent>/<YYYY-MM-DD>.jsonl
```

Recent quota events across all agents (last hour):

```bash
EVENTS_ROOT=~/.cortextos/$CTX_INSTANCE_ID/orgs/$CTX_ORG/analytics/events
TODAY=$(date -u +%F)
CUTOFF=$(date -u -v-1H +%FT%TZ 2>/dev/null || date -u -d '1 hour ago' +%FT%TZ)
for f in "$EVENTS_ROOT"/*/"$TODAY".jsonl; do
  [ -f "$f" ] || continue
  jq -c --arg cutoff "$CUTOFF" \
    'select(.event == "profile_quota_exhausted" and .timestamp > $cutoff)' \
    "$f"
done
```

The event row's `id` field is what you pass as `--trigger` below.
Or monitor passively — the daemon delivers the event into your
session via inbox if it crosses a severity threshold.

---

## Decision tree

For each `profile_quota_exhausted` event:

### 1. Has this trigger already been handled?

The CLI is single-shot — calling it twice with the same trigger
event id is allowed but means two failover swaps fire. Maintain a
session-scoped set of trigger IDs you've already actioned. If
already handled, skip.

### 2. Read target's fallback_profile

```bash
cat orgs/$CTX_ORG/agents/<agent>/config.json | jq -r '.fallback_profile // empty'
```

- **Empty** → no fallback configured. Send Saurav a Telegram alert
  and stop. Do not auto-failover. Sample message:

  > ⚠️ Agent `<agent>` quota-exhausted on profile `<profile>`
  > (pattern: `<error_pattern>`). No fallback configured —
  > manual intervention needed. Set `fallback_profile` in the
  > agent's config.json or pause the agent until the window resets.

- **Set** → continue to step 3.

### 3. Run the failover

```bash
cortextos profile-failover --agent <agent> --trigger <event_id>
```

The CLI handles all the deterministic checks atomically:
- Validates `fallback_profile` exists in `orgs/<org>/profiles.json`
- Cascade-prevents: rejects if the target profile itself emitted a
  `profile_quota_exhausted` in the last 30 min
- Atomically swaps `claude_profile` → `fallback_profile` in
  config.json (write-temp-then-rename)
- Emits `profile_failover` audit event with full provenance
- Dispatches a `soft-restart: ...` message to the target on the bus

### 4. Map the exit code

The CLI exits with a reason-distinct code so you can branch
without parsing stderr:

| Exit | Reason | What to do |
|------|--------|------------|
| 0 | Failover dispatched | Tell Saurav (step 5). Done. |
| 2 | `agent_dir_missing` or `no_fallback_configured` | See step 2 / config error. Tell Saurav. |
| 3 | `registry_missing` / `fallback_profile_unknown` / `config_unreadable` | Config error in `orgs/<org>/profiles.json` or agent config. Run `cortextos doctor` for diagnostics; tell Saurav with the doctor output. |
| 4 | `cascade_window_active` | Target profile recently exhausted too — likely platform-wide incident. Do NOT retry. Tell Saurav: "<agent> quota-exhausted; can't auto-failover because target profile <fallback> also exhausted within 30min. Manual triage required." |
| 5 | `already_on_fallback` | Agent's `claude_profile` is already the fallback — a prior invocation already actioned this. Treat as success, no Saurav notification needed (avoid alert noise). Useful when boss restarts and re-processes a trigger; this exit code prevents flipping the agent back to its original profile. |
| 1 | Unexpected internal error | Tell Saurav, attach the stderr line. |

### 5. Notify Saurav (success path)

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "🔄 <agent> failed over: <from_profile> → <to_profile> (trigger: <error_pattern>). Soft-restart dispatched. Conversation history is lost — agent rebuilds from MEMORY.md."
```

Include the trigger pattern + that history is lost (Saurav has
explicitly accepted this trade-off, but reminding once per
incident is friendly).

### 6. Watch the restart

The target agent's existing restart skill picks up the
`soft-restart` message. Confirm it boots — `read-all-heartbeats`
is the only heartbeat-read CLI; filter to the target agent in jq:

```bash
sleep 30
cortextos bus read-all-heartbeats --format json \
  | jq --arg agent "<agent>" '.[] | select(.agent == $agent) | {agent, status, last_heartbeat}'
```

If `last_heartbeat` is older than 60s after the restart message,
escalate to Saurav.

---

## Edge cases

### Boss itself quota-exhausts

You won't be able to run this skill — your session has died. The
daemon's SessionEnd hook still emits the bus event; **analyst** has
the authority to edit `boss/config.json` and issue the soft-restart
on your behalf. See analyst's `HEARTBEAT.md` and `GUARDRAILS.md`
for the boss-failover routine. Last-resort manual notification to
Saurav if analyst is also down.

### Concurrent failover (two agents quota-exhaust the same minute)

The CLI is single-shot per call; running it twice in parallel for
two different agents is safe (each writes to its own config.json).
Run them sequentially via your loop — the bus events you've already
handled stay in your session-scoped set so you don't double-action.

### Target profile is also exhausted

Caught by the cascade-prevention check (exit 4). Don't retry; tell
Saurav with the cascade-window context.

### Mid-session swap

By design: failover requires the target to fully restart under the
new `CLAUDE_CONFIG_DIR`. `--continue` won't work across accounts
because session state is auth-coupled. The soft-restart message
triggers a clean exit + re-spawn under the new env.

---

## Fail-back policy (recovery)

Currently `failback_policy: manual` in `orgs/<org>/profiles.json`.
When the original profile's quota replenishes (~24h on Anthropic
Pro), Saurav can ask you to swap an agent back. Run the same
`profile-failover` command pointing the failed-over agent at its
ORIGINAL profile (now back online). No new event triggers fail-back —
it's user-initiated.

---

## Reference

- Spec: `orgs/<org>/backlog/BL-2026-05-08-003-multi-claude-account-profiles.md`
- CLI source: `src/cli/profile-failover.ts`
- Service: `src/services/profile-failover.ts`
- Hook (event emitter): `src/hooks/quota-detection.ts`
- Registry shape: `src/utils/profiles.ts`
