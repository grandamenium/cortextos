---
name: kb-maintenance-review
description: "Review knowledge base health: stale docs, missing sources, duplicate content, failed ingests, and high-value gaps."
---

# KB Maintenance Review

Run on the configured cadence.

Create or update a cortextOS task before starting, update heartbeat while running, and log a workflow completion event when the review is done.

## Review Areas

- stale documents
- duplicate or conflicting docs
- source connectors failing
- new files not ingested
- high-search/no-answer topics
- docs without owners
- docs with unclear privacy
- sources marked shared without explicit approval
- normalized documents missing hashes, owner, tags, or source IDs
- failed or missing `kb-query` verification records
- agent workflows missing source material

## Inputs

- `kb/sources/source-registry.json`
- `kb/sources/privacy-policy.json`
- `kb/sources/taxonomy.json`
- `kb/sources/ingestion-policy.json`
- `kb/normalized`
- `kb/reports`

## Source Registry Review

For each source, verify:

- Owner is named.
- Scope is `private` or explicitly approved `shared`.
- Collection target matches the scope.
- Connector status is current.
- Next review date is present.
- Excluded content and privacy notes are clear.

Unknown, stale, or ambiguous sources must remain private and get follow-up tasks.

## Output

```markdown
# Knowledge Base Maintenance Review

## Healthy
## Needs Attention
## Failed Sources
## Stale or Conflicting Docs
## Privacy and Sharing Concerns
## Retrieval Verification
## Recommended Handoffs
## Next Tasks
```

Write the report under `kb/reports/<date>-kb-maintenance-review.md`, update memory with durable policy or source changes, and complete the task with links to the report and follow-up tasks.
