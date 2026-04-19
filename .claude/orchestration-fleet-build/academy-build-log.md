# Academy Agent Build Log

**Built:** 2026-04-16
**Builder:** orchestration-fleet-build
**Status:** Complete — awaiting BOT_TOKEN from @BotFather before enabling

---

## What Was Built

`/Users/joshweiss/cortextos/orgs/clearworksai/agents/academy/`

### Purpose
ClearPath Academy curriculum research and maintenance agent. Pulls daily AI/Claude trend signals via web search, audits Academy content for staleness, and proposes curriculum updates for Josh's review. Never modifies course content without explicit approval.

---

## Files Created

### Core Config
| File | Notes |
|------|-------|
| `config.json` | model: claude-sonnet-4-6, enabled: false (awaits BOT_TOKEN), 5 crons defined |
| `.env` | BOT_TOKEN=PLACEHOLDER — must replace with @BotFather token before enabling |
| `goals.json` | Initial goals set by build orchestrator |

### Bootstrap Files
| File | Notes |
|------|-------|
| `CLAUDE.md` | Full session start protocol, identity, Clearpath API patterns, content pipeline, guardrail |
| `IDENTITY.md` | Academy, curriculum research, emoji 📚 |
| `SOUL.md` | Research discipline, content integrity, memory, autonomy rules |
| `GUARDRAILS.md` | Red flag table including Academy-specific content change guardrail |
| `GOALS.md` | Daily/weekly/long-term goals with 2-week staleness target |
| `HEARTBEAT.md` | 4h heartbeat checklist with research queue check |
| `USER.md` | Josh preferences: scannable digests, approval required for content |
| `SYSTEM.md` | Org context, Clearpath KB config, content paths |
| `MEMORY.md` | Empty, ready to populate |
| `ONBOARDING.md` | Copied from hunter (standard onboarding flow) |
| `TOOLS.md` | Copied from hunter (full bus reference) |

### Crons (5 total)
| Name | Schedule | Purpose |
|------|----------|---------|
| `heartbeat` | every 4h | Health, inbox, task queue |
| `daily-research` | 7 AM weekdays | Pull 3-5 AI trend signals, flag stale content, send digest to Josh |
| `content-audit` | Mon 9 AM | Full Academy module review vs KB research signals |
| `trend-synthesis` | Fri 2 PM | Weekly curriculum gap analysis and next-quarter proposals |
| `theta-research` | 2 AM nightly | Deep overnight research on one AI topic, ingest to KB |

### Skills
| Skill | Source |
|-------|--------|
| `ai-trend-research` | Custom — written for this agent |
| `theta-wave` | community/skills/theta-wave |
| `autoresearch` | community/skills/autoresearch |
| `morning-review` | community/skills/morning-review |
| `weekly-review` | community/skills/weekly-review |
| `knowledge-base` | community/skills/knowledge-base |
| `activity-channel` | community/skills/activity-channel |
| `tasks` | community/skills/tasks |
| `comms` | community/skills/comms |
| `onboarding` | community/skills/onboarding |
| `memory` | community/skills/memory |
| `heartbeat` | community/skills/heartbeat |
| `event-logging` | community/skills/event-logging |

---

## Approval Rules

| Category | Rule |
|----------|------|
| `external-comms` | always_ask |
| `financial` | always_ask |
| `data-deletion` | always_ask |
| `research` | never_ask |
| `kb-ingest` | never_ask |
| `drafts` | never_ask |

Course content changes are governed by a GUARDRAIL in CLAUDE.md, not just config — any content update requires creating an approval record and waiting for Josh.

---

## Before Enabling

1. Create a new Telegram bot via @BotFather
2. Replace `BOT_TOKEN=PLACEHOLDER_ADD_FROM_BOTFATHER` in `.env` with the real token
3. Message the new bot to confirm it's working
4. Set `"enabled": true` in `config.json`
5. Run: `cortextos start academy`
6. Agent will detect NEEDS_ONBOARDING and walk through setup via Telegram

Note: CHAT_ID is already set to 6690120787. The `.env` note mentions the old `@dev_clearpath_academy_bot` is on legacy CRM and needs migration — use a fresh bot name.

---

## KB Integration

Academy uses the Clearpath intelligence API (not cortextOS built-in KB):
- **Ingest:** `POST https://clrpath.ai/api/intelligence/ingest`
- **Query:** `POST https://clrpath.ai/api/intelligence/ask`
- **Auth:** `X-Api-Key: $CLEARPATH_API_KEY` (from `../../secrets.env`)
- **Org ID:** `0ce7b73b-9161-47a6-a800-a0c8f15a4ae4`

All research findings are ingested with `sourceType: "research"` and dated titles for recency filtering.

---

## Content Paths

Academy content in knowledge-sync:
- `~/code/knowledge-sync/areas/clearworks/` — scan for Academy/course/curriculum files
- `~/code/knowledge-sync/areas/clearworks/academy/` — primary directory (create if absent on first audit)
- Weekly synthesis docs: `~/code/knowledge-sync/areas/clearworks/academy/weekly-synthesis-YYYY-MM-DD.md`
