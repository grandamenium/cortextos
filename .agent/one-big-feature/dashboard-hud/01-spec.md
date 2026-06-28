# Spec — Dashboard HUD (`/hud` full-screen Jarvis-style ops HUD)

**Slug:** `dashboard-hud` · **Framework:** one-big-feature · **Repo:** `/Users/joshweiss/code/cortextos` (dashboard at `dashboard/`)
**Date:** 2026-06-15 · **Source of truth:** frank2's `dashboard-hud-spec.md` (Josh approved the concept) + Larry's adversarial review (PASS, one load-bearing architectural fix folded in — see §Architecture fix).

## Goal

Add a `/hud` route to the existing cortextos `:3000` Next.js 14 dashboard that renders a full-screen, 6-panel, Jarvis-style dark-glassmorphism operations HUD. **All data comes from existing `:3000` API routes** — no new services, no new ports, no data-layer changes, no Jarvis fork.

## Architecture fix (load-bearing — folded in during Larry review, confirmed with frank2)

frank2's draft put `/hud` inside `src/app/(dashboard)/hud/` and tried to hide the sidebar via a nested `hud/layout.tsx`. **This does not work in Next.js App Router:** `src/app/(dashboard)/layout.tsx` wraps every child in `DashboardShell` (sidebar + topbar) AND enforces auth. A nested `hud/layout.tsx` renders *inside* the parent layout — it cannot remove the parent shell, so HUD would ship with the sidebar still visible.

**Correct approach — separate route group:**
- Create `src/app/(hud)/hud/page.tsx` + `src/app/(hud)/hud/layout.tsx`.
- `(hud)/layout.tsx` repeats the SAME auth gate from `(dashboard)/layout.tsx` (Bearer-JWT via `hasBearerDashboardAccess()` OR `auth()` session, else `redirect('/login')`) but renders `{children}` **full-screen with NO `DashboardShell`**.
- Because `(hud)` is a sibling route group to `(dashboard)`, it does NOT inherit the dashboard shell. No path-detection hack in `(dashboard)/layout.tsx` is needed — that file is NOT modified.
- The sidebar nav item in `src/components/layout/sidebar.tsx` still links to `/hud`.

**Net change vs frank2's "Files to Modify":** `(dashboard)/layout.tsx` is NO LONGER modified. Everything else in frank2's spec is preserved verbatim.

## Existing surface (verified 2026-06-15)

- **All 8 API routes exist:** `/api/tasks`, `/api/agents`, `/api/comms/feed`, `/api/events/stream`, `/api/approvals`, `/api/skills`, `/api/home/dispatch`, `/api/home/fleet-pulse`.
- **Data layer exists** in `src/lib/data/`: agents.ts, heartbeats.ts, tasks.ts, approvals.ts, events.ts, goals.ts, analytics.ts, reports.ts, organization.ts.
- **Layout/components exist** in `src/components/layout/`: dashboard-shell.tsx, sidebar.tsx, topbar.tsx, bottom-nav.tsx.
- **Auth** in `src/lib/auth.ts` (`auth()`), Bearer-JWT verified with `jose` against `AUTH_SECRET ?? NEXTAUTH_SECRET`.
- **Visual reference** (read-only, do NOT fork/copy): `~/code/jarvis-hud/components/HUD.tsx`.

## Panels (6, faithful to frank2 spec — no scope compression)

1. **Daily Ops Hub** (center, spans 2 cols, row 1) — `GET /api/tasks?status=in_progress&status=pending` + `GET /api/home/fleet-pulse`. Active task count, today's pending-for-human items (assignee=human), last comms-check timestamp (events feed), quick stats (tasks completed today, events fired today).
2. **Fleet Status** (left, row 2) — `GET /api/agents` + `src/lib/data/heartbeats.ts`. One tile per active agent (frank2, larry, crm, muse, codexer, ophir, scout, maven). Color: green online <3h / amber idle 3-12h / red halted-stale >12h. Tile: name, status dot, current_task (≤60 chars), time since last heartbeat. EXCLUDE disabled agents (sage, auditos, auditos2, sre, capital, academy, codexer-v2).
3. **Sales & Pipeline** (right, row 2) — `GET /api/tasks?assignee=crm`. Active CRM tasks grouped by stage (keyword match on title/desc: prospect/qualified/proposal/active), count per stage, most recent CRM task title + age, "Marcos/Alloi" deal status (latest crm task containing "marcos" or "alloi").
4. **Comms Triage** (left, row 3) — `GET /api/comms/feed` + `GET /api/events/stream` (SSE). Last 5 inbound messages (agent + Telegram): sender, snippet (≤80 chars), time ago, read/unread. Pending approvals count from `GET /api/approvals?status=pending`.
5. **Content Queue** (center, row 3) — `GET /api/tasks?assignee=muse` + `GET /api/tasks?assignee=larry`. Active muse tasks, active larry/codexer tasks, last activity event per agent (events feed).
6. **Calendar + Quick Actions** (right, row 3) — `GET /api/skills` + `POST /api/home/dispatch`. Row of quick-action buttons firing skills: morning-review, evening-review, comms (check comms), heartbeat, approvals. Calendar section = placeholder "connect Google Calendar" state (Phase 2).

## Visual tokens (verbatim)

```css
--hud-bg: #0a0a0f;            /* near-black background */
--hud-panel: rgba(255,255,255,0.04);   /* glassmorphism fill */
--hud-border: rgba(255,255,255,0.08);  /* subtle border */
--hud-accent: #7c6af7;       /* purple (cortextos brand) */
--hud-accent-2: #f3815e;     /* coral */
--hud-text: #e8e8f0;
--hud-muted: #6b6b7b;
--hud-online: #22c55e;
--hud-idle: #f59e0b;
--hud-halted: #ef4444;
```

Panel styling: `backdrop-filter: blur(12px)`, `border: 1px solid var(--hud-border)`, `border-radius: 12px`. Panel header eyebrow = coral, 11px uppercase, tracking-wide. Numbers large, Inter, light weight. Fleet tiles 80×80px, status dot bottom-right. Layout: full viewport height, no scroll, "← Dashboard" back button top-left, live clock top-right (HH:MM:SS, updates every second). Each panel polls its source every 10s (`setInterval` in client components).

## Files to Create (11)

```
src/app/(hud)/hud/page.tsx              # server component, auth-gated render of HUDLayout  [Architecture fix: (hud) group, NOT (dashboard)/hud]
src/app/(hud)/hud/layout.tsx            # full-screen layout, repeats auth gate, NO DashboardShell
src/components/hud/HUDLayout.tsx        # 6-panel grid, client component, orchestrates panels + clock + back button
src/components/hud/PanelShell.tsx       # shared glassmorphism wrapper (border/bg/header eyebrow)
src/components/hud/LiveClock.tsx        # top-right HH:MM:SS clock
src/components/hud/AgentTile.tsx        # fleet status per-agent tile (80×80, status dot)
src/components/hud/FleetStatusPanel.tsx # Panel 2
src/components/hud/TasksHubPanel.tsx    # Panel 1
src/components/hud/PipelinePanel.tsx    # Panel 3
src/components/hud/CommsPanel.tsx       # Panel 4
src/components/hud/ContentQueuePanel.tsx# Panel 5
src/components/hud/QuickActionsPanel.tsx# Panel 6
```

(Count note: 12 files listed — frank2's draft said "11" but enumerated 12 in its own Files-to-Create block. All 12 are required; the "11" was a miscount. No scope dropped.)

## Files to Modify (1)

- `src/components/layout/sidebar.tsx` — add "HUD" nav item linking to `/hud`.
- **NOT** `src/app/(dashboard)/layout.tsx` (architecture fix removes the need).

## HUD CSS tokens placement

Add the `--hud-*` custom properties scoped to the HUD (e.g. a `.hud-root` class on the `(hud)/hud/layout.tsx` wrapper or an inline `<style>`/CSS module), NOT to global `:root`, so they don't leak into the main dashboard theme.

## Non-Goals

No Jarvis fork/copy; no new port/new Next app; no Google Calendar API in P1 (placeholder only); no redesign of existing dashboard pages (additive only); no voice/STT/TTS; no new API routes; no bus data-layer rebuild.

## Acceptance Criteria (frank2's 1-9, verbatim)

1. `/hud` loads at `:3000/hud` with no sidebar/topbar.
2. Fleet Status panel shows all active agents with correct heartbeat age.
3. Task Hub panel shows live in_progress task count updating every 10s.
4. Pipeline panel shows at least the latest CRM task.
5. Comms panel shows pending approvals count.
6. Quick Actions panel renders 5 buttons (morning-review, evening-review, check-comms, heartbeat, approvals).
7. No TypeScript errors — `npm run build` clean (run in `dashboard/`).
8. Visual: dark glassmorphism panels match the spec colors.
9. Screenshot sent to Josh for review BEFORE PR opened.

Plus (Larry build-review gates): no `any` types, no `console.log`, route group is `(hud)` not `(dashboard)/hud`, `(dashboard)/layout.tsx` untouched, HUD tokens not leaked to global `:root`.

## Phase 2 (deferred — after Josh approves P1)

Wire Google Calendar to Panel 6; add more skill buttons; animated canvas background; Monarch/Finance panel if ophir exposes an endpoint.
