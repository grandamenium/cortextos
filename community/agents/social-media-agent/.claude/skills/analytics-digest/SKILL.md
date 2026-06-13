---
name: analytics-digest
description: "Produce daily or weekly social analytics digests from configured exports, dashboards, APIs, or local records."
---

# Analytics Digest

Use this for recurring analytics reviews and post-performance analysis.

## Workflow

1. Create or update an analytics task.
2. Read `config/platform-config.json`, `content/published/`, and any configured platform exports or dashboards.
3. Normalize metrics by platform and post format. Use `schemas/analytics-report.schema.json`.
4. Identify:
   - top performers
   - underperformers
   - repeated audience questions
   - format or hook patterns
   - content worth repurposing
   - missing data or tracking gaps
5. Save JSON to `content/analytics/daily/` or `content/analytics/weekly/`.
6. Write a short `.md` digest next to the JSON.
7. Add durable learnings to `MEMORY.md`.
8. Create human tasks for missing exports, broken dashboards, or unavailable credentials.

Never fabricate metrics. If only qualitative data exists, label it as qualitative.
