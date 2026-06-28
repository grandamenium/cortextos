# P3 — Tasks Hub (Panel 1) + Pipeline (Panel 3)

**Depends on:** P1 (`PanelShell`), P2 (polling pattern). Independent of P4 (disjoint files).

## Files to create

### `dashboard/src/components/hud/TasksHubPanel.tsx`  (Panel 1 — center, spans 2 cols, row 1)
Client component, `<PanelShell eyebrow="Daily Ops Hub" className="<span-2-cols>">`.
- Fetch `GET /api/tasks?status=in_progress&status=pending` and `GET /api/home/fleet-pulse`, both on mount + every 10s.
- Show: active task count (in_progress across all agents); today's pending items for human (filter `assignee=human`); last comms-check timestamp (derive from the events feed / fleet-pulse — whichever exposes it; if neither, omit gracefully); quick stats — tasks completed today, events fired today (from `/api/home/fleet-pulse` if present).
- Large light-weight Inter numbers for the headline counts.

### `dashboard/src/components/hud/PipelinePanel.tsx`  (Panel 3 — right, row 2)
Client component, `<PanelShell eyebrow="Sales & Pipeline">`.
- Fetch `GET /api/tasks?assignee=crm` on mount + every 10s.
- Group active CRM tasks by stage via keyword match on title/description: `prospect`, `qualified`, `proposal`, `active`. Show count per stage.
- Show most recent CRM task title + age.
- Show "Marcos/Alloi" deal status: the latest crm task whose title/desc contains "marcos" or "alloi" (case-insensitive). If none, show a muted "no Marcos/Alloi task".

## Acceptance
- Tasks Hub shows a live in_progress count updating every 10s (acceptance criterion 3).
- Pipeline shows at least the latest CRM task (acceptance criterion 4).
- `npm run build` clean.

## Constraints
- No `any`, no `console.log`. Type the `/api/tasks` and `/api/home/fleet-pulse` responses.
- Reuse the exact 10s polling + cleanup pattern from P2's FleetStatusPanel.
- Keyword stage grouping is a display heuristic only — do NOT mutate task data or call any write endpoint.
