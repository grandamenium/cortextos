# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
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
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules

## Fork sync hygiene (saurav-yirifi/sb-cortextos-fork)

**Only the merged items matter when bringing them in.** When syncing from `upstream/main` or auditing branches, the canonical question is "did this work get merged?" — not "does this branch have unique commits?"

- A branch with unique commits whose upstream PR was **MERGED** is dead workshop. The work flows to us via `upstream/main` sync — the original branch is just a stale workshop copy. Delete it.
- A branch with unique commits whose upstream PR was **CLOSED without merge** is rejected/abandoned work. Delete it (unless you want a local-only patch, in which case PR it to `saurav-yirifi/sb-cortextos-fork:main` directly — see `docs_sb/upstream-sync.md`).
- A branch with unique commits and an **OPEN upstream PR** is live work. Keep it.
- A branch with unique commits and **no PR ever opened** is abandoned WIP. Delete it (or open the PR if it's still relevant).

Don't preserve branches solely because `git rev-list main..branch` returns commits — that signal can't tell merged-via-squash from never-merged. Always cross-reference upstream PR state.

Procedural audit (one-liner):
```bash
gh pr list --repo grandamenium/cortextos --state all --head <branch-name> --json number,state,title
```
