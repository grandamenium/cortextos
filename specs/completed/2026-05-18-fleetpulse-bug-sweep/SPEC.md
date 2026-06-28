# FleetPulse Dashboard Bug Sweep — 2026-05-18

**Status**: DRAFT_SPEC
**Repo**: /Users/joshweiss/code/cortextos
**Branch**: feature/dashboard-bug-sweep-2026-05-18 (to be created by Codexer off main)
**Task**: task #1 (larry, in_progress)

## Problem

Josh reported eight dashboard bugs (`state/current-mission.txt`). Four are code defects in the FleetPulse dashboard at `dashboard/src/`. The other four are non-code: noise audit (frank2 workstream), Anthropic admin key env var (Larry direct fix via railway-agent), stale Marcos approval (already resolved by frank2), and Tailscale Funnel (separate workstream).

This spec covers the four code defects.

### Bug 1 — Background black, not white

`dashboard/src/app/layout.tsx:43`: `<ThemeProvider attribute="class" defaultTheme="light" enableSystem>`. `enableSystem` makes `next-themes` follow the OS color scheme. Josh's macOS is in dark mode, so the dashboard renders with `.dark` applied → `globals.css:213-214` `--background: oklch(0.145 0 0)` → black background. Design calls for light/white.

### Bug 4 — `.DS_Store` appears as an agent in the launcher

`dashboard/src/lib/agents.ts:206`: `for (const entryName of fs.readdirSync(agentsDir))` reads every directory entry including dotfiles. `safeReadDir` (same file, lines 231-238) already filters dotfiles + non-directories with `{withFileTypes:true}` — the agents loop just doesn't use it.

### Bug 5 — Skills source wrong + "+18 more" link does nothing

Two distinct defects:

1. `dashboard/src/lib/skills.ts:60-77` only reads from `cortextos bus list-skills --format json`. That source surfaces 27 bus-registered admin/background skills. Josh's actual user-facing skills (220 of them, including `/invoicing`, `/gws-meta-workflows`, `/cold-email`, `/seo`, `/sales-enablement`, `/content-strategy`) live at `~/.claude/skills/<name>/SKILL.md` and never reach the launcher.

2. `dashboard/src/components/home/claude-code-launcher.tsx:119-126`: the "+ N more" element is a non-interactive `<span>` (`data-testid="launcher-skill-more"`). There is no onClick, no modal, no overflow surface. Josh cannot reach any skill past the first ten.

### Bug 7 — Today velocity always 0

`dashboard/src/lib/data/tasks.ts:127-138`: `getTasksCompletedToday` builds `todayStart` via `setUTCHours(0,0,0,0)`. For Josh in PST/PDT (America/Los_Angeles, UTC-7/UTC-8), the UTC midnight boundary corresponds to 17:00 local in the afternoon. Tasks completed between 00:00 PT and 17:00 PT today are excluded — so the velocity card reads "0 tasks" for most of the working day even when tasks were completed.

## Solution

### Fix 1 — Force light theme

`dashboard/src/app/layout.tsx:43`: remove `enableSystem` from `<ThemeProvider>`. `next-themes` then pins to `defaultTheme="light"` regardless of OS preference. The existing topbar/appearance settings (`topbar.tsx`, `appearance-tab.tsx`) that read `useTheme()` continue to function for explicit user toggle.

### Fix 4 — Filter dotfiles in agents loop

`dashboard/src/lib/agents.ts:202-211`: replace the `agentsDir` loop body with a call to the existing `safeReadDir(agentsDir)` helper (lines 231-238), which already does `withFileTypes: true` + `.isDirectory()` + `!entry.name.startsWith('.')`. Single-source-of-truth fix.

### Fix 5 — Multi-source skills + working overflow modal

Two coordinated changes:

1. `dashboard/src/lib/skills.ts`:
   - New helper `readUserSkillsFromDisk()` that scans `~/.claude/skills/*/SKILL.md` (path: `path.join(os.homedir(), '.claude', 'skills')`). For each child directory containing `SKILL.md`, parse the YAML frontmatter (or fall back to first heading) to extract `name` + `description`. Each skill becomes a `SkillRecord` with `source: 'user'`.
   - `getSkillsList()` merges user-disk skills + bus skills, dedupes by `name` (user wins on collision), sorts alphabetically.
   - New constant `LAUNCHER_FEATURED` (in skills.ts): an explicit allowlist surfaced in the launcher's first row. Initial set: `graphify`, `invoicing`, `gws-meta-workflows`, `browser`, `cold-email`, `content-strategy`, `seo`, `m2c1-worker`. `getLauncherSkills(limit)` returns `visible = LAUNCHER_FEATURED ∩ all` (preserving featured order, dropping any not installed), and `overflow = all.length - visible.length`. The `FEATURED_GRAPHIFY` fallback is removed (graphify is in the featured set; if it's missing on disk, that's a real install issue, not a UI fallback).

2. `dashboard/src/components/home/claude-code-launcher.tsx`:
   - Replace the inert `<span data-testid="launcher-skill-more">` with a `<button>` that opens a modal (Radix Dialog via existing `@/components/ui/dialog`, same pattern as elsewhere in dashboard).
   - Modal contents: searchable input + scrollable list of all skills (rendered as `/<name>` chips, identical click handler to existing skill chips). Searching is case-insensitive substring over `name` and `description`. Selecting a skill calls `applySkill(name)` and closes the modal.
   - The launcher card receives `allSkills: SkillRecord[]` as a new prop (sourced from `getLauncherSkills().all` in `page.tsx`).

### Fix 7 — Velocity uses America/Los_Angeles "today"

`dashboard/src/lib/data/tasks.ts:127-138`:
- Replace UTC-midnight `todayStart` with a Los Angeles-local-midnight boundary. Use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' })` to derive the PT date string, then construct the ISO timestamp `${ptDateString}T00:00:00-07:00` (during PDT) / `-08:00` (during PST). The simplest correct construction: format the current PT date as `YYYY-MM-DD`, then `new Date(\`${ptDate}T00:00:00${ptOffset}\`).toISOString()`. Compute `ptOffset` by formatting `Date.now()` with `Intl.DateTimeFormat(..., { timeZoneName: 'longOffset' })` (returns `GMT-07:00` / `GMT-08:00`) and stripping the prefix.
- `completed_at >= ?` SQL stays unchanged — the bound just becomes "PT-local midnight expressed as UTC".

## Out of scope (handled separately)

- Bug 2 (agent noise) — frank2 owns `agent-routing-policy.md` Wave 2 draft.
- Bug 3 (Anthropic admin key) — Larry sets `ANTHROPIC_ADMIN_KEY` on Railway cortextos service via railway-agent + browser-harness. No code change.
- Bug 6 (Marcos) — already moved to `~/.cortextos/default/orgs/clearworksai/approvals/resolved/`, DB status=denied. Verified before this spec was drafted.
- Bug 8 (Tailscale Funnel) — separate workstream, deferred.

## Files Codexer touches

| Path | Change |
|---|---|
| `dashboard/src/app/layout.tsx` | Remove `enableSystem` prop |
| `dashboard/src/lib/agents.ts` | Replace `fs.readdirSync(agentsDir)` loop body with `safeReadDir(agentsDir)` |
| `dashboard/src/lib/skills.ts` | Add user-disk source, dedupe, replace `getLauncherSkills` body with featured-allowlist logic |
| `dashboard/src/components/home/claude-code-launcher.tsx` | Add `allSkills` prop, replace inert `<span>` overflow with Radix Dialog modal + search |
| `dashboard/src/app/(dashboard)/page.tsx` | Pass `allSkills` from `getLauncherSkills().all` to `<ClaudeCodeLauncher>` |
| `dashboard/src/lib/data/tasks.ts` | Replace UTC `todayStart` with PT-local `todayStart` in `getTasksCompletedToday` |

No new dependencies. No DB schema changes. No new API routes.

## Patterns Codexer must follow

- Server-side Node module conventions (`fs`, `path`, `os`) — existing `agents.ts` is the template.
- Radix Dialog usage — match the existing pattern in `dashboard/src/components/` (find an existing Dialog import for the right shape; do not invent a new Dialog wrapper).
- No `any` types. No `console.log`. No new error-swallowing `try { ... } catch {}` — failures in `readUserSkillsFromDisk` should log via `console.error` (consistent with `getTasks` error path).
- Tailwind class shapes match existing launcher styling (rounded-full pills, slate palette).

## Acceptance

See ACCEPTANCE_CRITERIA.yaml. Eight ACs total — six unit-style file/code assertions + one local-dev-server integration AC hitting real `~/.cortextos/default` data + one staging-equivalent AC running the full `next build` and serving the dashboard against real fixtures.

## State machine

DRAFT_SPEC → LARRY_SPEC_REVIEW → ARCH_REVIEW (architect-spec-review.sh) → SPEC_PASS → CODEX_IMPL → LARRY_BUILD_REVIEW → STAGING_VALIDATE → PR_OPENED → JOSH_MERGES.
