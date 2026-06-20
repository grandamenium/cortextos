---
name: upstream-issue-tracker
description: "Track issues we've filed against grandamenium/cortextos (the upstream framework). Watch for status changes, related PRs, fixes that resolve our pain points. Surface in weekly digest. Run on every framework-upstream-check cycle."
triggers: ["upstream issues", "framework bugs", "track issue", "did our issue get fixed"]
---

# Upstream Issue Tracker

> When we file a bug against the cortextOS framework upstream, we don't want to
> forget it. This skill keeps the list visible, surfaces status changes, and
> automatically applies fixes when they land in upstream/main.

---

## What we track

```bash
gh issue list --repo grandamenium/cortextos \
  --search "author:syntasticstudios" \
  --state all --limit 30 \
  --json number,title,state,createdAt,closedAt,url
```

## Memory file

`memory/tracked-upstream-issues.md`

```markdown
# Tracked Upstream Issues

## Open

### #271 — Cron re-armament not idempotent (P1)
Filed 2026-04-29. Sleep-Scheduler-Crons drift after 7d, no daemon-side enforcement.
Workaround: cron-drift-watchdog skill (cortextos-improver agent runs this every 15m).
Status: open, no upstream response yet.
Last checked: 2026-04-29

### #<n> — <title>
...

## Closed (last 30 days)

### #<n> — <title>
Closed YYYY-MM-DD. Fix landed in upstream commit <sha>.
Status: merged to our origin/main on YYYY-MM-DD via auto-upstream sync.
Workaround removed: <yes|no, what>
```

## Cycle (run every 4h via framework-upstream-check)

```bash
# 1. Pull current state
gh issue list --repo grandamenium/cortextos --search "author:syntasticstudios" \
  --state all --limit 30 --json number,title,state,closedAt,url > /tmp/upstream-issues-now.json

# 2. Diff against memory
# - new comments → notify Telegram
# - state: open → closed → check if fix landed in upstream/main, surface for auto-merge
# - related PR opened → log in memory

# 3. Update memory/tracked-upstream-issues.md

# 4. If a tracked issue closed AND its fix is in upstream/main:
#    - Run framework-upstream-check (will auto-merge if fix(...) prefix)
#    - Alert user: "Upstream fixed our issue #X — applied to main"
#    - Mark our local workaround for review (e.g. cron-drift watchdog can be retired)
```

## Weekly digest line in Telegram

```
🔧 Upstream issues we filed:
  #271 cron-drift (open, 4d)
  #N something (closed → applied to main 2026-05-XX)
```

---

## Anti-patterns

- ❌ Filing an issue without recording it here → forgotten in 2 days
- ❌ Manually closing our local workaround when upstream fixes → check the issue tracker FIRST
- ❌ Spamming Telegram on every check → only on state changes

---

*Single source of truth for upstream issue follow-through.*
