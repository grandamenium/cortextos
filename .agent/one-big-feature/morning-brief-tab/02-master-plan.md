# Master Plan — Morning Brief Tab

**Slug:** `morning-brief-tab` · **Repo:** `/Users/joshweiss/code/cortextos` (dashboard) · **Date:** 2026-06-22
**Verify command:** `cd dashboard && npm run build && npm test` (TypeScript clean + unit tests).

## Phasing

Three phases, each a single cohesive codexer hand-off. P1 and P2 are independent (route/nav vs. data lib) and could be built in parallel; P3 depends on both. Recommended order P2 → P1 → P3 (data first, so the page has something real to render).

| Phase | File | Depends on | Deliverable |
|-------|------|-----------|-------------|
| **P1** | `03-specs/P1-route-and-nav.md` | — | `(dashboard)/brief/page.tsx` scaffold (server component, header, 3 empty section slots) + sidebar nav item. Builds and renders an empty brief. |
| **P2** | `03-specs/P2-crm-data-source.md` | — | `src/lib/data/crm.ts` `getCrmPipeline()` + `/api/crm/pipeline` route + unit test. Reads `interactions.jsonl`, tolerant of missing/malformed. |
| **P3** | `03-specs/P3-brief-sections-ui.md` | P1, P2, + AI-Today path | Three section components wired into the page: Your Tasks (`getTasks({agent:'human'})`), CRM Pipeline (P2), AI Today (artifact render). |

## Gate before dispatch

- **BLOCKER:** AI Today source path (Open Item #1 in 01-spec) must be resolved with frank2 before P3 dispatches. P1 + P2 can dispatch immediately once frank2 signs off the spec.
- frank2 spec review BEFORE codexer (frank2's explicit ask). Larry adversarial review of each returned diff BEFORE PR.

## Acceptance

1. `/brief` reachable from sidebar, behind dashboard auth, renders inside the shell.
2. Your Tasks shows real HUMAN tasks (pending/in_progress/blocked) matching `/api/tasks?agent=human`.
3. CRM Pipeline shows real totals + last-7d + 5 recent contacts from `interactions.jsonl`.
4. AI Today renders the upstream artifact (or a graceful "no brief yet today" empty state).
5. `npm run build` clean, `npm test` green (incl. new crm parser test). No `any`, no `console.log`.
6. Playwright screenshot of `/brief` attached to PR. PR body flags the briefs-app → cortextOS-dashboard consolidation for Josh.
