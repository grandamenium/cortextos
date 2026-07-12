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

1. `npm run typecheck` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

> **Use `npm run typecheck`, not `npm run build`, to check that your code compiles.**
>
> `bin.cortextos` points at `dist/cli.js`. On any host where cortextOS is
> installed from a working checkout (`npm link` / `npm i -g .`), the global
> `cortextos` command resolves *into that checkout's `dist/`* — so **`npm run
> build` is a DEPLOY**: every agent, cron and hook on that box immediately
> starts executing whatever you just compiled, branch and all.
>
> `npm run typecheck` (`tsc --noEmit`) verifies the code and writes nothing.
> `npm run build` is guarded on live hosts (see `scripts/guard-live-build.mjs`);
> to deploy deliberately, use `npm run build:deploy`.

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst, agent-codex, agent-opencode)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules
