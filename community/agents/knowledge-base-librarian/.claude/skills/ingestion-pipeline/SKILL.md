---
name: ingestion-pipeline
description: "Normalize and ingest documents, videos, transcripts, repo notes, and source exports into a searchable knowledge base."
---

# Ingestion Pipeline

Run this when the user asks to ingest files, when a source export lands in `kb/raw/manual`, or when a scheduled review identifies approved new material.

## Flow

1. Create a cortextOS task for the ingestion batch and mark it `in_progress`.
2. Read `kb/sources/source-registry.json`, `kb/sources/privacy-policy.json`, `kb/sources/taxonomy.json`, and `kb/sources/ingestion-policy.json`.
3. Pull or receive source files using configured tools. The default manual drop location is `kb/raw/manual`.
4. Preserve a raw copy or source reference. Do not mutate source files in place.
5. Compute a content hash for each file, for example `shasum -a 256 <file>`.
6. Normalize to markdown or JSON records under `kb/normalized/` using `kb/schemas/normalized-doc.schema.json`.
7. Add metadata: source ID, source path or URL, hash, author, created date, ingested date, permissions, confidence, freshness, tags, owner, privacy scope, and transformation notes.
8. Default unknown or unregistered sources to `private`. Create a follow-up task rather than ingesting unknown sources into shared collections.
9. Run privacy checks before ingestion. Shared ingestion requires an explicit source registry `scope: "shared"` plus matching privacy policy approval.
10. Ingest into the configured KB collection with `cortextos bus kb-ingest`.
11. Verify with `cortextos bus kb-query` using at least one representative question from the batch.
12. Write JSON and markdown ingestion reports under `kb/reports/` using `kb/schemas/ingestion-report.schema.json`.
13. Complete the task, log `action/workflow_completed`, update memory, and create follow-up tasks for failed, ambiguous, stale, or sensitive items.

## Local Manual Happy Path

```bash
TASK_ID=$(cortextos bus create-task "Ingest manual KB drop" --desc "Normalize files from kb/raw/manual, apply private-by-default metadata and privacy policy, ingest, verify retrieval, and write an ingestion report.")
cortextos bus update-task "$TASK_ID" in_progress
mkdir -p kb/raw/manual kb/normalized/manual kb/reports
find kb/raw/manual -type f ! -name '.gitkeep' -print
```

For each input file:

- Use the matching source from `kb/sources/source-registry.json`, or create a pending private source entry before ingestion.
- Write normalized output to `kb/normalized/manual/<source-id>-<hash-prefix>.normalized.json`.
- Include `privacy.scope: "private"` unless the registry explicitly says `shared`.
- Ingest private files with a private collection, for example:

```bash
cortextos bus kb-ingest kb/normalized/manual --org "$CTX_ORG" --agent "$CTX_AGENT_NAME" --scope private
cortextos bus kb-query "What did the latest manual KB ingestion add?" --org "$CTX_ORG" --agent "$CTX_AGENT_NAME"
```

If the batch targets a shared collection, stop and create an approval request before `kb-ingest`.

## Quality Rules

- Never flatten private and shared sources into the same collection unless setup explicitly allows it.
- Prefer source links and stable IDs over copied blobs.
- Mark generated summaries as summaries.
- Preserve enough metadata to answer "where did this come from?"
- Do not ingest passwords, API keys, private keys, tokens, or credential files. Create a human task to remove or rotate exposed secrets if found.
