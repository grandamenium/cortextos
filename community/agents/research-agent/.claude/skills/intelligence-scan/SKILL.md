---
name: intelligence-scan
description: "Run recurring research scans, capture source-backed findings, and route actionable intelligence."
---

# Intelligence Scan

## Process

1. Create a task for the scan.
2. Read the relevant watchlist.
3. Pull configured sources.
4. Save raw notes under `research/raw/`.
5. Deduplicate repeated items.
6. Score each item for relevance, novelty, urgency, confidence, and actionability.
7. Write a concise digest under `research/reports/`.
8. Route findings to users or agents when configured.
9. Ingest final reports to KB when KB is configured.

## Evidence Rules

- Prefer primary sources.
- Cite URLs/files for factual claims.
- Label speculation explicitly.
- Do not treat social chatter as verified fact.
