# Master Plan — Dashboard HUD (`/hud`)

**Slug:** `dashboard-hud` · **Framework:** one-big-feature · **Repo:** `/Users/joshweiss/code/cortextos` (dashboard at `dashboard/`)
**Status:** SPEC_PASS (Larry adversarial review PASSED; one load-bearing architecture fix folded in; frank2 confirmed). Ready for codexer dispatch.
**Source of truth:** `01-spec.md` (faithful translation of frank2's `dashboard-hud-spec.md` + the `(hud)` route-group fix).

## Goal

Add a full-screen, 6-panel, Jarvis-style dark-glassmorphism `/hud` operations view to the existing `:3000` Next.js dashboard. Purely a new visual layer over the existing API routes and `src/lib/data/` — no new services, ports, API routes, or data-layer changes.

## Why one-big-feature (not M2C1)

Single cohesive feature, single repo (`cortextos`), single app surface (`dashboard/`), no schema migration, no new repo, no cross-repo coupling, no new API routes. All changes live under `dashboard/src/app/(hud)/`, `dashboard/src/components/hud/`, and one line in `dashboard/src/components/layout/sidebar.tsx`. Not M2C1-scale.

## The one required fix (load-bearing — see 01-spec §Architecture fix)

frank2's draft used `src/app/(dashboard)/hud/` with a nested layout to hide the sidebar. In Next.js App Router a nested layout renders INSIDE `(dashboard)/layout.tsx`'s `DashboardShell`, so the sidebar would NOT be removed. **Fix:** a sibling route group `src/app/(hud)/hud/` whose own `layout.tsx` repeats the auth gate (Bearer-JWT OR session, else `redirect('/login')`) and renders children full-screen with NO `DashboardShell`. Consequence: `(dashboard)/layout.tsx` is NOT modified.

## Phases

- **P1 — Route group + auth-gated full-screen shell + HUD tokens.** Create `(hud)/hud/layout.tsx` (auth gate mirrored from `(dashboard)/layout.tsx`, full-screen, no shell, scoped `--hud-*` tokens), `(hud)/hud/page.tsx`, and the shared `PanelShell.tsx` + `LiveClock.tsx`. Gates everything else. Spec: `03-specs/P1-route-group-shell.md`.
- **P2 — HUDLayout grid + AgentTile + Fleet Status (Panel 2).** 6-panel responsive grid client component, back button + clock wired, AgentTile, FleetStatusPanel against `/api/agents`. Establishes the polling pattern (10s `setInterval`) all panels reuse. Spec: `03-specs/P2-layout-and-fleet.md`.
- **P3 — Tasks Hub (Panel 1) + Pipeline (Panel 3).** Daily Ops Hub against `/api/tasks` + `/api/home/fleet-pulse`; CRM pipeline proxy against `/api/tasks?assignee=crm` with keyword stage grouping. Spec: `03-specs/P3-tasks-and-pipeline.md`.
- **P4 — Comms (Panel 4) + Content Queue (Panel 5) + Quick Actions (Panel 6).** Comms feed + approvals count; muse/larry content tasks; skill buttons firing `POST /api/home/dispatch` + calendar placeholder. Spec: `03-specs/P4-comms-content-actions.md`.
- **P5 — Sidebar nav + build/verify + screenshot.** Add HUD nav item to `sidebar.tsx`; `npm run build` clean in `dashboard/`; capture `/hud` screenshot for Josh before any PR. Spec: `03-specs/P5-nav-and-verify.md`.

## Critical path

P1 → P2 → (P3, P4 independent, can land in parallel) → P5 gates the PR. P3 and P4 both depend only on P1's `PanelShell` and P2's polling pattern; they touch disjoint files (separate panel components) so no merge conflict.

## Acceptance

`01-spec.md` §Acceptance Criteria (1-9) + Larry build-review gates: route group is `(hud)` not `(dashboard)/hud`; `(dashboard)/layout.tsx` untouched; no `any`; no `console.log`; HUD tokens scoped (not global `:root`); `npm run build` clean in `dashboard/`; screenshot before PR.

## Risks

- **Sidebar still visible** (the bug the architecture fix prevents) — verify in the P5 screenshot that no sidebar/topbar renders at `/hud`.
- **SSE in `/api/events/stream`** — Panel 4 may use polling instead of SSE if the SSE wiring is fragile; 10s polling of `/api/comms/feed` + `/api/approvals` satisfies acceptance criteria 5 regardless. SSE is nice-to-have, not blocking.
- **Token leakage** — `--hud-*` must be scoped to the HUD root, not global, or the main dashboard theme shifts. Build-review gate checks this.
- **Auth divergence** — `(hud)/layout.tsx` must keep the exact bearer-or-session gate; if it drifts, `/hud` is either unprotected or rejects valid sessions. P1 spec pins the exact code to mirror.

## Process gate

Codexer dispatch carries: `GATE: build framework=one-big-feature slug=dashboard-hud repo=/Users/joshweiss/code/cortextos`. Diff returns to Larry for adversarial build-review (scope match vs 6 panels + 12 files, architecture fix honored, no `any`/`console.log`, build clean) → screenshot → Josh approves PR before merge.
