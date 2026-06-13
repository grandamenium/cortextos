# Knowledge Base Librarian

Community agent template for users who want cortextOS to ingest, organize, retrieve, and maintain knowledge from local files, exports, and approved connectors.

The template is private by default. A source is not shared unless `kb/sources/source-registry.json` explicitly marks it `shared` and the privacy policy allows it.

## First Run

1. Install the template as an agent.
2. Start it and say `/setup`.
3. Review the generated `USER.md`, `TOOLS.md`, `TUNING_KNOBS.md`, `GOALS.md`, `SYSTEM.md`, and `MEMORY.md`.
4. Configure source registry, privacy policy, taxonomy, and ingestion policy under `kb/sources`.
5. Let the agent create ingestion tasks, heartbeat, setup events, and maintenance crons.

## Local Smoke Path

1. Drop a small owner-approved file into `kb/raw/manual`.
2. Ensure `kb/sources/source-registry.json` contains a private source for the file.
3. Run `.claude/skills/ingestion-pipeline/SKILL.md`.
4. Normalize to `kb/normalized/manual` with hash, provenance, tags, owner, and privacy metadata.
5. Ingest with `cortextos bus kb-ingest` into a private collection.
6. Verify with `cortextos bus kb-query`.
7. Write an ingestion report under `kb/reports` and complete the task.

## Bundled Assets

- `AGENTS.md`: production operating contract.
- `.claude/skills/setup/SKILL.md`: `/setup` wrapper.
- `.claude/skills/knowledge-base-librarian-setup/SKILL.md`: setup workflow.
- `.claude/skills/ingestion-pipeline/SKILL.md`: manual and source-driven ingestion workflow.
- `.claude/skills/kb-maintenance-review/SKILL.md`: weekly health review.
- `kb/schemas`: JSON schemas for registry, privacy, taxonomy, policy, raw docs, normalized docs, and reports.
- `kb/examples`: valid private-by-default examples.
- `kb/sources`: seed runtime registry and policies.
- `kb/raw/manual`, `kb/normalized/manual`, `kb/reports`: local-first working directories.

## Crons

- `heartbeat`: every 4 hours.
- `weekly-kb-maintenance-review`: Mondays at 10:00.
- `weekly-source-registry-review`: Mondays at 11:00.

## Modular Pairings

- `research-agent`: investigate missing or uncertain facts.
- `automation-builder-agent`: automate recurring ingestion.
- `customer-support-agent`: turn support docs into FAQ/source-of-truth.
- `learning-coach-agent`: turn KB material into curricula.
- `project-manager-agent`: maintain project docs and status sources.
