---
name: agent-proposal-curator
description: "Platform-director skill: periodically analyse the fleet's work pattern, identify capability gaps, and propose new specialized agents that would lift fleet velocity. User approves via Telegram. Per user directive 2026-04-25: 'soll cortextos vorschläge bringen ob es schlauer wäre noch weitere spezialisierte agenten zu implementieren'."
triggers: ["agent proposals", "capability gap", "specialist agent suggestion", "team expansion", "should we hire"]
---

# Agent Proposal Curator

> User directive 2026-04-25: cortextOS itself should suggest when a new
> specialist agent would help, not just respond to user requests. The user
> approves; cortextOS implements.
>
> This is org-design-as-self-improvement.

---

## When to run

- **Weekly cron** (Sunday 18:00) — main proposal cycle
- **On-demand** when user says "any agent suggestions?"
- **Triggered** when platform-director notices a recurring task type that
  the existing fleet doesn't cover well (e.g. legal, content, analytics)

---

## The 5-step proposal cycle

### Step 1 — Mine the data (10 min)

Look at what the fleet actually did the last 7 days:

```bash
# Tasks completed by category
cortextos bus list-tasks --status completed --since 7d --format json | jq '
  group_by(.title | match("\\[([A-Z-]+)").captures[0].string // "OTHER") |
  map({prefix: .[0].title, count: length, agents: [.[].assignee] | unique})
'

# Tasks reopened (signal of weak coverage)
cortextos bus list-tasks --reopened --since 7d --count

# HUMAN-tagged tasks (signal of automation gaps)
cortextos bus list-tasks --status pending | grep '\[HUMAN\]'

# Bug-Hunt findings by category (from systems-analyst hunt log)
cat orgs/$CTX_ORG/agents/systems-analyst/memory/hunt-log.md | tail -50

# Feature-suggestions wishlist (from bug-hunter cycles)
ls -la tests/e2e/reports/feature-suggestions/ | tail -7

# Greptile findings repeating same issue type
gh pr list --repo syntasticstudios/phytomedic-saas --state merged --limit 30 --json comments | jq '.[] | .comments[] | select(.author.login | startswith("greptile")) | .body' | grep -iE 'P0|P1' | sort | uniq -c | sort -rn | head -10
```

### Step 2 — Identify gaps (5 min)

Patterns that signal a missing specialist:

| Pattern | Signal | Possible Agent |
|---------|--------|----------------|
| Same agent gets 5+ task-types weekly that don't fit core role | Generalist overload | Specialist split |
| Recurring HUMAN-task category | User does work cortextOS could automate | Automation agent |
| 3+ tasks reopened with same Anti-Pattern | Quality gap | Reviewer agent |
| Domain knowledge needed that no agent has (legal, design, SEO) | Expertise gap | Domain agent |
| Cross-cutting concern dropping (framework upgrades, security audits) | Stewardship gap | Steward agent |
| Slow turnaround on specific task type | Throughput bottleneck | Worker agent |
| User repeatedly providing same kind of input | Missed automation | Sensor agent |

### Step 3 — Score candidates (5 min)

For each candidate agent, score 1-5:

- **Volume** — how many tasks per week would they get?
- **Specialization** — how poorly do existing agents cover this?
- **ROI** — token cost vs work-saved-by-user/other-agents?
- **User-friction** — how often does user manually intervene in this domain?

Total score 16-20 = strong proposal. 10-15 = consider. <10 = skip.

### Step 4 — Draft proposal

Use this template:

```markdown
## Proposal: <agent-name>

**Why:** <pattern observed in fleet data>

**Mission (1 sentence):** <what they do that no one else does>

**Core responsibilities:**
1. <responsibility>
2. <responsibility>
3. <responsibility>

**Crons (proposed):**
- <name> @ <interval>: <prompt summary>

**Skills (proposed):**
- <skill-name> — <what it codifies>
- <skill-name> — ...

**Success metrics:**
- <measurable thing per week>

**Cost estimate:** ~$<X> per day in tokens (sonnet) / $<Y> (opus if reasoning-heavy)

**Risk:**
- <risk> → mitigation: <how>

**Alternative considered:** <why this is better than just adding crons to existing agent>

**Open question for user:** <if any>
```

### Step 5 — Send + track

```bash
# 1. Save proposal as deliverable
cat > orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/proposals/agent-$(date +%Y-%m-%d)-$AGENT_NAME.md << EOF
$PROPOSAL
EOF

# 2. Send to user via Telegram (compact summary, link to full doc)
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "🧑‍💻 Agent-Vorschlag: <name>

<2-line why + mission>

Score: X/20
Estimated daily cost: \$Y
Read full proposal: <dashboard URL or path>

Approve? Reply 'approve <agent-name>' to spawn, 'reject <agent-name> <reason>' to file the proposal."

# 3. Log
cortextos bus log-event action agent_proposal info --meta '{"name":"$AGENT_NAME","score":X}'
```

### Step 6 — On approval

When user replies `approve <name>`:

```bash
# 1. Spawn via existing agent-management skill
# (see .claude/skills/agent-management/SKILL.md for full flow)

# 2. Bot setup: ask user for BOT_TOKEN + CHAT_ID
# 3. cortextos add-agent <name> --template agent --org $CTX_ORG
# 4. Write IDENTITY.md, GOALS.md, GUARDRAILS.md, config.json with the proposal
# 5. Copy referenced skills to .claude/skills/
# 6. cortextos start <name>
# 7. Hand off to new agent for /onboarding
```

---

## Standing proposals (auto-considered weekly)

These are obvious enough to evaluate every week. Don't re-propose if user
already rejected within 30 days (memory/proposal-rejections.md).

### 1. cortextos-improver
**Mission:** continuously find improvements to cortextOS itself (the framework, not the product). Watch upstream commits, suggest skill upgrades, identify token-waste in agent behavior, audit prompt patterns.

### 2. seo-optimizer
**Mission:** dedicated to SEO + AI-search optimization across all 35 public pages. Schema.org markup, meta-description curation, sitemap maintenance, Core Web Vitals, AI-crawler-friendly structure.

### 3. legal-compliance-officer
**Mission:** AGB/Datenschutz/Impressum + GDPR + medical-device-regulation watch. Reads regulatory news, flags new laws (Cannabis Gesetz updates, eHealth Gesetz), tracks legal-content freshness.

### 4. content-strategist
**Mission:** /wissen + /krankheiten content production at scale. SEO topic research, German cannabis-medicine writing, schema markup, content-calendar.

### 5. growth-analyst
**Mission:** funnel-conversion analysis, cohort analytics, A/B-test design, retention metrics. Currently distributed across systems-analyst + cannametrics-data without clear ownership.

### 6. partnership-coordinator
**Mission:** Pharmacy + Doctor + Manufacturer onboarding workflows. Currently HUMAN-blocked. Could automate Cannaleo, HiGreen, Yousign provider relationships.

### 7. customer-support-agent
**Mission:** Handle Telegram/Email user-support inquiries (FAQs, order-status, dispute-routing). Use Claude with RAG over /wissen + order-DB.

### 8. devops-monitor
**Mission:** Production health 24/7. Vercel deploy status, Convex query performance, Stripe webhook reliability, error-budget tracking. Currently spread across systems-analyst + deployment-guard skill.

---

## Anti-patterns

- ❌ **Proposing without data** — every proposal must cite specific tasks/patterns from last 7 days
- ❌ **Specialist that overlaps existing role 80%+** — enhance existing agent's skills instead
- ❌ **Marketing-driven naming** — "AI-Powered Insights Agent" is fluff; describe job-to-be-done plainly
- ❌ **No sunset path** — every proposed agent should have a deprecation criterion (e.g. "if Cannabis Cannabis-Gesetz stabilizes, legal-compliance-officer can be archived")
- ❌ **Proposing during firefight** — wait for fleet stability. Don't add agents during a crash-loop or rate-limit storm.

---

## When NOT to propose

- Less than 7 days of data (post-init)
- Active rate-limit / quota crunch
- More than 3 unaddressed proposals in user's queue (don't pile on)
- User just rejected a similar proposal within 30 days

---

## Memory

- `memory/proposals.md` — running log of proposals + outcomes
- `memory/proposal-rejections.md` — what user rejected + why (avoid re-proposing)
- `proposals/agent-YYYY-MM-DD-name.md` — full proposal docs

---

## Cron

```json
{
  "name": "agent-proposal-curator",
  "type": "recurring",
  "cron": "0 18 * * 0",
  "prompt": "Read .claude/skills/agent-proposal-curator/SKILL.md and execute one full proposal cycle. Mine fleet data from last 7 days, score 8 standing candidates + any new ones surfaced by patterns. Send 1-3 proposals to user via Telegram (top-scored). Skip if conditions for 'When NOT to propose' apply."
}
```

---

*Org-design-as-self-improvement. Curate the team like a thoughtful CTO.*
