# Agent file backup — 2026-05-11 pre-restructure

Snapshot of every per-agent startup file (`AGENTS.md`, `ONBOARDING.md`, `TOOLS.md`, `CLAUDE.md`, `HEARTBEAT.md`, `SOUL.md`, `GUARDRAILS.md`) and matching template files, taken **immediately before** PR-A's restructure (`docs_sb/issues/ok-so-we-want-snazzy-garden.md` PR-A A3+A4).

Captured for two reasons:
1. **Live fleet under `orgs/sb-personal/agents/<role>/`** is gitignored — without this snapshot the originals would be lost when the restructure deletes/trims them.
2. **Content sourcing** — new shared skills under `.claude/skills/{memory-discipline,dispatch-protocol,worktree-discipline}/` are extracted from these originals; future audits can compare extraction fidelity here.

## Layout

```
2026-05-11-pre-restructure/
  README.md                            ← this file
  live-fleet/                          ← snapshot of gitignored orgs/sb-personal/agents/*
    boss/
      AGENTS.md  CLAUDE.md  GUARDRAILS.md  HEARTBEAT.md  ONBOARDING.md  SOUL.md  TOOLS.md
    analyst/   (same set)
    engineer/  (same set)
    devops/    (same set)
    fullstack/ (same set)
  templates/                           ← framework starting points (tracked)
    agent/         (same set)
    analyst/       (same set)
    orchestrator/  (same set)
```

## Restore

Per-role, single file:

```bash
cp docs_sb/agent-file-backups/2026-05-11-pre-restructure/live-fleet/<role>/<FILE>.md \
   orgs/sb-personal/agents/<role>/<FILE>.md
```

Whole fleet:

```bash
for role in boss analyst engineer devops fullstack; do
  cp docs_sb/agent-file-backups/2026-05-11-pre-restructure/live-fleet/$role/*.md \
     orgs/sb-personal/agents/$role/
done
```

(The subdir is named `live-fleet/` rather than `orgs/` because `.gitignore` has an unanchored `orgs/` pattern that would skip a nested directory of that name.)

Templates restore the same way under `templates/<type>/`.

After restore, restart the daemon (`pm2 restart cortextos`).

## Lifecycle

This directory is an artifact, not a long-term reference. Once the restructure has been observed in production for ≥30 days and no rollback is needed, the snapshot can be removed in a follow-up housekeeping PR. Until then, keep it intact — it is the only copy of the pre-restructure `orgs/` content.
