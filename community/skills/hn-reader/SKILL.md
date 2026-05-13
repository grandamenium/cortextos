---
name: hn-reader
description: Read Hacker News via the public Firebase API. No auth, no rate limits. Use to surface community discussion around a topic, find primary-source threads, and triage signal-vs-noise quickly.
allowed_tools: [Bash, Read]
---

# hn-reader

Fetch + summarize Hacker News threads, top stories, and comment trees. Public Firebase API, no auth required.

## Capabilities

| Tool | What it does |
|---|---|
| `bin/hn.sh top [N]` | Latest N top-stories with score, comments, age, URL (default N=30) |
| `bin/hn.sh new [N]` | N newest stories |
| `bin/hn.sh ask [N]` | N latest Ask HN |
| `bin/hn.sh show [N]` | N latest Show HN |
| `bin/hn.sh story <id>` | Single story full text + comment tree (depth-limited) |
| `bin/hn.sh search <query>` | Algolia HN search (community-hosted; the only non-Firebase endpoint) — returns hits sorted by relevance |

## Output format

All commands emit structured JSON to stdout. Wrap in jq / Read in agent prompts.

```bash
./bin/hn.sh top 5 | jq '.[] | {title, score, descendants, url, hn_url}'
./bin/hn.sh search "rust async" | jq '.hits[:3] | .[] | {title, points, num_comments, url}'
```

## When to use

- Researching a topic to find primary-source community discussion
- Surfacing dissent / counter-arguments around a popular tech narrative
- Reading the comment tree on a specific HN thread someone linked
- Finding adjacent discussions ("what else has HN said about X?")

## Limits

- Firebase API: no rate limit in practice, but be a good citizen — cache locally if pulling >100 items
- Algolia search: returns ~30 hits max per page; for deep search use multiple paginated calls
- Comment trees can be deep (5000+ comments on a top story) — depth-limited to 2 levels by default
