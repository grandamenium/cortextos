# Spec — Morning Brief (`/brief` tab in the cortextOS dashboard)

**Slug:** `morning-brief-tab` · **Framework:** one-big-feature · **Repo:** `/Users/joshweiss/code/cortextos` (dashboard at `dashboard/`)
**Date:** 2026-06-22 · **Owner:** larry (spec + review) → codexer (impl) · **Coordinator:** frank2 (briefs owner)
**Source of truth:** frank2-assigned task `task_1782146619385_95656775` (larry tracking task `task_1782146723435_99657727`) + memories `feedback_brief_sections`, `feedback_morning_brief_is_dashboard_tab`, `feedback_briefs_to_website_not_telegram`.

## Goal

Add a `/brief` route to the existing cortextOS `:3000` Next.js 14 dashboard that renders Josh's **morning brief as a tab** — Your Tasks (HUMAN kanban), CRM Pipeline (from `crm/crm/interactions.jsonl`), and AI Today (analysis). The brief pulls the **same live data the other tabs already use** so it never lags or duplicates a hand-assembled snapshot. Telegram sends only the tab URL; the content lives in the dashboard. This is the regression fix for the standalone-Telegraph-page behavior Josh rejected (`feedback_morning_brief_is_dashboard_tab`, 2026-06-09).

## Destination decision (resolved — flag at PR)

The 2026-06-09 memory named the standalone **briefs app** (`clearworks-ai/briefs`, briefs-production-b399) as the brief's home. The **resolved target is the cortextOS dashboard** (`~/code/cortextos/dashboard`) — consolidating into the live fleet dashboard rather than maintaining a second app. This was confirmed by frank2 (briefs owner) twice on 2026-06-22 ("new route in the same Next.js dashboard app is right. Proceed.") and is the established pattern: every other view (Tasks/CRM-via-tasks/Comms) already lives here with live data. **PR description must call out this consolidation so Josh can confirm** — it is the only deviation from a prior stated preference. `publish-brief.py` → briefs-production stays as fallback until the tab ships.

## Architecture (no new service, no new port)

- **Route lives INSIDE `(dashboard)`** — `src/app/(dashboard)/brief/page.tsx`. Unlike `/hud` (which needed its own `(hud)` route group to escape the shell), the brief WANTS the dashboard shell + sidebar + auth, so it inherits `(dashboard)/layout.tsx` automatically. **`(dashboard)/layout.tsx` is NOT modified.**
- **Server component**, mirroring `src/app/(dashboard)/page.tsx` (HomePage): `export const dynamic = 'force-dynamic'`, data gathered server-side via `Promise.all`, no client fetch waterfall.
- **Two of three data sources already exist**; CRM pipeline needs ONE small read-only data lib + route (see below). "No new backend" = no new service/port/DB — adding a read-only route in the same Next app is the established per-tab pattern.

## Existing surface (verified 2026-06-22)

- `getTasks({ agent: 'human' })` in `src/lib/data/tasks.ts` already resolves HUMAN tasks: `assignee IN ('human','user') OR title LIKE '[HUMAN]%' OR project = 'human-tasks'`. **Your Tasks reuses this verbatim — zero new task code.**
- `/api/tasks` route supports the same filters; `KanbanBoard` (`src/components/tasks/kanban-board.tsx`) renders task columns.
- Home page (`(dashboard)/page.tsx`) is the canonical server-component data-aggregation pattern to copy.
- Sidebar nav: `src/components/layout/sidebar.tsx` — `navItems` array, `section: 'core'`, badge wiring via `getBadge()`.
- CRM source on disk: `~/code/cortextos/orgs/clearworksai/agents/crm/crm/interactions.jsonl` (JSONL; keys: `ts`, `contact_id`, `type`, `summary`, `sentiment`, `commitments`, `followups_created`, `source_ref`). **No dashboard data lib reads it yet — this is the one new read.**

## Brief sections (per `feedback_brief_sections` — verbatim, no compression)

1. **## 📋 Your Tasks** — HUMAN kanban. Source: `getTasks({ agent: 'human' })`. Render a compact 3-column board (pending / in_progress / blocked) reusing `KanbanBoard` or a read-only compact variant. Completed-today HUMAN tasks shown as a collapsed count.
2. **## 📊 CRM Pipeline** — Source: NEW `getCrmPipeline()` reading `interactions.jsonl`. Show: total interactions, last-7d count, 5 most-recent contacts (`contact_id`, `type`, relative date, truncated `summary` ≤80 chars). NO write path. Read-only.
3. **## 🧠 AI Today** — analysis-only, 3 lenses (build impact, client impact, one action). Source: **OPEN ITEM — confirm with frank2** which file the AI-news cron writes (publish-brief.py grep found no AI-Today generator; the content is produced upstream, not live dashboard data). Spec renders from a single markdown/JSON artifact path; the exact path is the only blocker before codexer dispatch.

Header: date + greeting (`format(new Date(), 'EEEE, MMMM d')`), matching HeroStrip tone. No Telegram-style summary blocks — this is the dashboard view.

## Files to CREATE
- `src/app/(dashboard)/brief/page.tsx` — server component, the brief view.
- `src/lib/data/crm.ts` — `getCrmPipeline(): { total, last7d, recent: {contactId, type, date, summary}[] }`, reads `interactions.jsonl` from the resolved framework/org root (use `getFrameworkRoot()`/`getCTXRoot()` like `api/tasks/route.ts`; path = `<root>/orgs/clearworksai/agents/crm/crm/interactions.jsonl`). Tolerate missing file → empty pipeline.
- `src/app/api/crm/pipeline/route.ts` — thin GET wrapper over `getCrmPipeline()` (`dynamic = 'force-dynamic'`), for parity/testability with other tabs.
- `src/components/brief/your-tasks.tsx`, `crm-pipeline.tsx`, `ai-today.tsx` — section components.
- `src/lib/data/__tests__/crm.test.ts` — unit test for JSONL parse (happy path, missing file, malformed line skipped).

## Files to MODIFY
- `src/components/layout/sidebar.tsx` — add `{ label: 'Brief', href: '/brief', icon: <IconSunHigh or IconNotes>, section: 'core' }` after Overview. No badge.

## Constraints (coding-standards + CLAUDE.md)
- TypeScript strict, no `any`, no `console.log` in committed code (match existing `console.error`-only pattern).
- Org-scoping: brief is fleet-personal (Josh), single-tenant view; respect existing `getHomeOrg(params.org)` org param like HomePage.
- Atomic/read-only for CRM — never write `interactions.jsonl` from the dashboard.
- Tests required for the new `getCrmPipeline` parser.

## Out of scope
- No changes to `publish-brief.py` (frank2 owns; stays as fallback).
- No AI-Today content generation — the tab renders an existing artifact only.
- No Calendar/email-triage panels (those were Telegram-brief sections; not in the 3 confirmed dashboard sections). Revisit post-ship if Josh asks.

## Open items (resolve with frank2 BEFORE codexer dispatch)
1. **AI Today source path** — which file does the AI-news cron write, and in what format (md/json)?
2. Confirm "Your Tasks" should be the compact KanbanBoard reuse vs. a simpler list — frank2's call on density.
3. Confirm sidebar placement/label/icon.
