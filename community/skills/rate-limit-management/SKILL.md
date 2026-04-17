---
name: rate-limit-management
effort: low
description: "Framework protocol for responding to Claude Max API usage thresholds. Three-tier wind-down and recovery. Agent-specific behavior belongs in deployment config, not here."
triggers: ["rate limit", "usage check", "usage high", "wind down", "resume after rate limit", "check usage"]
---

# Rate Limit Management Protocol

> Framework-level protocol. Defines tiers and check mechanism only.
> Agent-specific behavior at each tier belongs in your deployment's CLAUDE.md or config.json.

---

## Usage Check Command

```bash
cortextos bus check-usage-api [--warn-7day N] [--warn-5h N] [--chat-id ID] [--force]
```

Reads Claude Max utilization from the Anthropic OAuth usage API. Outputs JSON with `five_hour` and `seven_day` utilization fields.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--warn-7day N` | 80 | Send Telegram alert if 7-day utilization >= N% |
| `--warn-5h N` | 90 | Send Telegram alert if 5-hour utilization >= N% |
| `--chat-id ID` | `$CTX_TELEGRAM_CHAT_ID` | Telegram chat ID for alerts |
| `--force` | false | Bypass 3-minute result cache |

**Cache:** Results are cached for 3 minutes at `$CTX_ROOT/state/usage/api-cache.json` to avoid hitting the API hard limit (~5 requests per token before 429).

**Requirements:** macOS Keychain with Claude Code credentials. The script reads the OAuth access token from the `Claude Code-credentials` Keychain entry.

---

## Three-Tier Protocol

### Tier 1 — Wind-Down (>= 85% utilization)

**Signal:** Usage is high but work can still complete safely.

**Agent behavior:**
- Finish the current task or message response
- Do not accept new autonomous tasks
- Do not initiate new research, builds, or multi-step work
- Respond to direct user messages normally
- Check usage every 5 minutes until dropping below 85% or escalating to Tier 2

**Cron behavior:** Suspend scheduled/proactive cron work. Keep inbox-check and heartbeat crons running.

---

### Tier 2 — Minimal (85-95% utilization)

**Signal:** Usage is critically high. New work risks hitting the hard limit mid-task.

**Agent behavior:**
- Suspend all proactive and scheduled work
- Respond only to direct messages from the user
- Keep responses short; do not start multi-step work
- Do not fire background tasks, KB queries, or large LLM calls
- Report status to user via Telegram if transitioning into this tier from normal operations

**Cron behavior:** Suspend all crons except heartbeat.

---

### Tier 3 — Dark (>= 95% utilization)

**Signal:** Approaching or at hard limit. Further work risks broken mid-task state.

**Agent behavior:**
- Send user a Telegram status message:
  ```
  Rate limit at [N]%. Going dark until reset. Will notify when back online. Resets at [time].
  ```
- Stop processing. Do not respond to new messages.
- Update heartbeat to "paused — rate limit"
- Wait for reset signal (see Recovery below)

---

## Recovery

**Reset condition:** Utilization drops below 20% (confirmed via usage check).

**On recovery:**
- Resume normal operations
- Restore all suspended crons
- Notify user via Telegram:
  ```
  Rate limit reset. Back online. Resuming normal operations.
  ```
- Update heartbeat to "online"

---

## Recommended Cron: Usage Check

Check usage every 15 minutes and apply tier logic:

```json
{
  "name": "usage-check",
  "interval": "15m",
  "prompt": "Run cortextos bus check-usage-api and apply the rate limit protocol from .claude/skills/rate-limit-management/SKILL.md based on current utilization."
}
```

**Configurable thresholds:** The `--warn-7day` and `--warn-5h` flags on `check-usage-api` are independent early-warning alerts sent to Telegram. They fire below the tier thresholds defined above and serve as a heads-up before tier behavior kicks in.

Recommended warn thresholds:
- `--warn-7day 75` — early warning at 75% (10 points before Tier 1)
- `--warn-5h 85` — 5-hour window warning at 85%

---

## What Belongs Here vs. Deployment Config

**This skill defines:**
- The tier thresholds (85 / 95 / 20%)
- The check mechanism (`check-usage-api`)
- The generic behavior description for each tier
- The cron pattern

**Your deployment config should define:**
- Which specific crons to suspend at each tier
- Whether to notify Dane, the user, or other agents on tier transitions
- Whether to pause only the rate-limited agent or also send signals to other agents
- Any org-specific escalation steps

---

## Quick Reference

| Utilization | Tier | Behavior |
|-------------|------|---------|
| < 85% | Normal | Full operations |
| 85-94% | Wind-Down | Finish current task; no new autonomous work |
| 85-95% | Minimal | Direct messages only; no scheduled work |
| >= 95% | Dark | Go silent; notify user; wait for reset |
| < 20% (after reset) | Recovery | Resume all operations; notify user |

---

*Framework protocol — no AscendOps-specific content. Agent behavior at each tier is deployment-defined.*
