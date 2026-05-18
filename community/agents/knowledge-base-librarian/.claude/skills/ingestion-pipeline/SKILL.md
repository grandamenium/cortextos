---
name: ingestion-pipeline
description: "Normalize and ingest documents, videos, transcripts, repo notes, and source exports into a searchable knowledge base."
---

# Ingestion Pipeline

## Flow

1. Create a cortextOS task for the ingestion batch.
2. Read `kb/sources/source-registry.json`.
3. Pull or receive source files using configured tools.
4. Preserve a raw copy or source reference.
5. Normalize to markdown or JSONL under `kb/normalized/`.
6. Add metadata: source, author, created date, permissions, confidence, freshness, tags, and owner.
7. Run privacy checks before shared ingestion.
8. Ingest into the configured KB collection.
9. Write an ingestion report under `kb/reports/`.
10. Create follow-up tasks for failed, ambiguous, or sensitive items.

## Quality Rules

- Never flatten private and shared sources into the same collection unless setup explicitly allows it.
- Prefer source links and stable IDs over copied blobs.
- Mark generated summaries as summaries.
- Preserve enough metadata to answer "where did this come from?"
