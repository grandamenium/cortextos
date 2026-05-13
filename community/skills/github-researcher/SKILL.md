---
name: github-researcher
description: Strategic GitHub research — full repo search, similar-repo discovery, pattern detection across orgs. Not just issues/PRs. Uses gh CLI for authed work + public search API for unauthed exploration.
allowed_tools: [Bash, Read]
---

# github-researcher

Strategic-level GitHub research. Differs from gh-issues-skill in scope: this finds *patterns* (similar repos, ecosystem snapshots, language-trend cohorts), not single-repo state.

## Capabilities

| Tool | What it does |
|---|---|
| `bin/gh-search-repos.sh <query>` | Repo search w/ stars/lang/license/date filters. Returns top N + clusters by tag overlap. |
| `bin/gh-find-similar.sh <owner/repo>` | "More like this" — uses topic overlap + language + star tier to surface peer repos. |
| `bin/gh-patterns.sh <query>` | Pattern detection: scans top-K repos in a query for shared deps / file structures / commit cadence. |
| `bin/gh-issues.sh <owner/repo>` | (Convenience) recent issues + PR activity. Wrapper over `gh issue list`. |

## Setup

```bash
# Once, before first run — interactive browser auth (60s)
gh auth login --git-protocol https --hostname github.com --web
```

The skill works partially without auth (public-repo search via REST, rate-limited 60/hr). With auth: 5000/hr + private repo access.

## Quick recipes

```bash
# Find top Rust async libraries
./bin/gh-search-repos.sh 'language:rust topic:async stars:>1000'

# What's similar to pipecat-ai?
./bin/gh-find-similar.sh pipecat-ai/pipecat

# What deps do top 10 RAG frameworks all share?
./bin/gh-patterns.sh 'topic:retrieval-augmented-generation stars:>500'
```

## Output

JSON envelopes with: name, full_name, description, stars, language, topics, license, pushed_at, html_url, plus a `cluster` field where applicable (auto-tagged by topic-overlap).

## When to use

- Surveying an ecosystem before HARPAL adopts a dependency
- Finding precedent for an architecture you're considering
- Triaging a tool-class ("RAG frameworks" → which 3 are worth deeper dive?)
- Spotting strategic patterns (e.g. "every major OSS LLM tool released a TS SDK in May 2026")

## Limits

- gh API is rate-limited (5000/hr authed, 60/hr unauthed) — be parsimonious; cache locally for re-runs.
- Star count is a NOISY popularity signal (manipulation, age effects); use multiple signals in ranking.
- "Pattern detection" only inspects metadata (topics, language, license, dep manifests). Doesn't read code unless you call the gh-patterns.sh deep mode (slower; downloads manifest files).
