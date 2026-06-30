# Starter Agent Handoff Example

## Agent

`kb-librarian` from `knowledge-base-librarian`

## Why This Agent Exists

The user wants feedback notes to become searchable and summarized before adding more automation.

## First Task

Register the selected local notes folder as a private source, ingest a small sample, verify three searches, and write `kb/reports/first-ingestion.md`.

## Relevant Files

- `concierge/onboarding-profile.json`
- `concierge/starter-team-recommendation.json`
- `concierge/day-one-workflow.json`

## Boundaries

- Do not publish or share notes externally.
- Do not delete source files.
- Ask approval before creating new agents or writing to third-party systems.

## Success Criteria

- Source registry exists.
- Notes are queryable.
- First themes report exists.
- Any blocker is represented as a task, approval, or human task.
