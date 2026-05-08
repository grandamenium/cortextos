---
name: status-pulse
description: "Every-10-minute fleet status pulse — sends a compact Telegram briefing: what each agent is doing right now, open PRs, task progress, CI/deploy health. High-signal, low-noise."
triggers: ["status pulse", "10-min status", "pulse check", "fleet pulse"]
---

# Status Pulse (10-min)

> A fast, compact status update every 10 minutes so the user knows
> the system is alive and producing.

---

## When to run

On the `status-pulse` cron (every 10 min). Also on-demand when user
says "status", "was läuft", "was machen die agents", "pulse".

**Skip conditions** (don't spam):
- If nothing has changed since the last pulse AND no open blockers,
  send a compact 1-liner like: "Pulse 14:10 — fleet idle, all clear"
- Never send more than one full pulse in 10 min
- Suppress between 22:00–07:00 unless there's an active emergency

---

## Step 1: Gather data (≤20 seconds)

Run these in parallel:

```bash
# Fleet heartbeats
cortextos bus read-all-heartbeats --format text

# Open tasks in progress
cortextos bus list-tasks --status in_progress

# Recently completed (last 10 min)
cortextos bus list-tasks --status completed | head -20

# Open PRs on the main product repo
gh pr list --repo syntasticstudios/phytomedic-saas --state open --json number,title,headRefName,statusCheckRollup,isDraft

# Recent merged PRs (last hour)
gh pr list --repo syntasticstudios/phytomedic-saas --state merged --limit 5 \
  --json number,title,mergedAt

# CI status on main
gh run list --repo syntasticstudios/phytomedic-saas --branch main --limit 3 \
  --json conclusion,name,createdAt

# Greptile unresolved findings across open PRs
for pr in $(gh pr list --repo syntasticstudios/phytomedic-saas --state open \
              --json number --jq '.[].number'); do
  gh pr view $pr --repo syntasticstudios/phytomedic-saas --json comments \
    --jq "{pr: $pr, greptile: [.comments[] | select(.author.login | startswith(\"greptile\"))] | length}"
done
```

---

## Step 2: Format the pulse

Telegram message template (keep under 800 chars when possible):

```
⚡️ Pulse HH:MM

Agents
• backend-architect: <current task from heartbeat, 60 chars max>
• frontend-dev: <current task>
• integrations-routing: <current task>
• cannametrics-data: <current task>
• systems-analyst: <current task>

Tasks
✅ <N> completed since last pulse: <titles, truncated>
🔄 <N> in progress
⏸ <N> pending

PRs (phytomedic-saas)
🟢 <N> open, <N> green, <N> with P0/P1
🚀 <N> merged last hour

CI main: <green|yellow|red>
Preview: <URL if new deploy>

<Escalations or blockers go here, or "All clear ✓">
```

### Example pulse (good)

```
⚡️ Pulse 14:20

Agents
• backend-architect: feat/strains-schema — adding strains table
• frontend-dev: waiting on strains-schema merge
• integrations-routing: idle, no open tasks
• cannametrics-data: reviewing catalog coverage
• systems-analyst: deployment-guard cycle, no issues

Tasks
✅ 2 completed: CBD cleanup, cart persistence
🔄 1 in progress: strains schema (backend)
⏸ 2 pending: rezeptkosten, slug backfill batched

PRs
🟢 3 open, 2 green, 1 with Greptile P1 (PR #92)
🚀 4 merged in last hour (#87 #88 #89 #91)

CI main: green ✓
Preview: deploy successful

All clear ✓
```

### Example pulse (quiet)

```
⚡️ Pulse 14:30 — no changes. Fleet idle, main green.
```

---

## Step 3: Send

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<pulse>"
cortextos bus log-event action status_pulse info --meta '{"merged":N,"in_progress":N,"open_prs":N}'
cortextos bus update-heartbeat "status-pulse HH:MM — N active, N blocked"
```

---

## Escalation triggers

Highlight in **bold** inside the pulse if any of these trip:

| Trigger | Why it matters |
|---------|----------------|
| A PR has been open >4h with unresolved P0/P1 | Stuck review loop |
| Main branch CI red for >30 min | Production broken |
| An agent heartbeat >30 min stale | Agent frozen |
| Same task `in_progress` in 3 consecutive pulses with no commit | Agent stuck |
| Vercel production deploy failed | Live site may be broken |
| Any error event with severity=critical in last 10 min | Needs immediate attention |

If triggered, also send a separate follow-up Telegram **immediately**
(don't wait for the next pulse) with detail and recommended action.

---

## Muting

If the user says "mute pulse" or "quiet": set a flag in memory and
skip pulses until they say "resume pulse" or "status on".

```bash
# Check mute state on every run
PULSE_MUTED=$(grep "^pulse_muted: true" memory/state.md 2>/dev/null && echo "yes" || echo "no")
[ "$PULSE_MUTED" = "yes" ] && exit 0
```

---

*This skill is the single source of truth for the 10-min status pulse.*
