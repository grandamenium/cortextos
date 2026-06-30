# Knowledge Base Librarian Setup Report

## Privacy Defaults

- Default scope: private.
- Shared ingestion requires explicit source registry approval and an approval workflow when sensitive data may be involved.

## Source Registry

- Seed source: `manual-notes`.
- Raw drop path: `kb/raw/manual`.
- Normalized path: `kb/normalized/manual`.

## Tools

- Local files are available by default.
- Optional connectors should be recorded in `TOOLS.md` and activated only after the user confirms ownership and scope.

## First Ingestion Candidate

Use a small owner-approved markdown or text file in `kb/raw/manual` and ingest it into a private collection.

## Open Questions

- Which source should be ingested first?
- Which users or agents may retrieve private results?
- Which topics require stale-document review?
