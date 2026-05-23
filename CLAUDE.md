# Contributing to cortextOS

## Development Setup

> **READ-ONLY UPSTREAM — `grandamenium/cortextos` is the public framework mirror.**
> Never push to it. Never open PRs against it. Pull upstream changes into your org fork
> (`RevOps-Global-GIT/cortextos`) via rebase, then propose upstream PRs only if Greg
> explicitly approves. See `[feedback_git_push_target]` in MEMORY.md.

```bash
git clone https://github.com/grandamenium/cortextos.git  # read-only reference clone
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 16 web dashboard
- `templates/` — Agent templates (agent, agent-codex, orchestrator, analyst, hermes, m2c1-worker, org, property-management, project-orchestrator-codex)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules

## Skill Catalog Notes

- Night/day behavior is configured through agent `config.json`
  (`day_mode_start` and `day_mode_end`), not a standalone `nighttime-mode`
  skill.
