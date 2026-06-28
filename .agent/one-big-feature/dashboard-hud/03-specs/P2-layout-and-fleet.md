# P2 — HUDLayout grid + AgentTile + Fleet Status (Panel 2)

**Depends on:** P1 (`PanelShell`, `LiveClock`, `.hud-root` tokens).
**Establishes:** the 10s polling pattern every panel reuses.

## Files to create

### `dashboard/src/components/hud/HUDLayout.tsx`
Client component (`'use client'`). The 6-panel orchestrator.
- Top bar: "← Dashboard" back button top-left (`<Link href="/">` or `/dashboard` home — link to the dashboard root, styled in `--hud-muted`), `<LiveClock />` top-right.
- Grid: CSS grid, 2 columns × 3 rows on desktop, responsive single-column stack on narrow viewports. Full viewport height, no page scroll (panels scroll internally if needed).
- Panel placement (per spec): Panel 1 (TasksHubPanel) row 1 spanning both columns; row 2 = Panel 2 (FleetStatusPanel) left, Panel 3 (PipelinePanel) right; row 3 = Panel 4 (CommsPanel) left, Panel 5 (ContentQueuePanel) center, Panel 6 (QuickActionsPanel) right. (Row 3 is a 3-up; row 2 is 2-up; row 1 is full-width — implement with grid-template-areas or explicit column spans.)
- Renders all 6 panel components. In P2, only `FleetStatusPanel` is real; the other 5 may be stub `<PanelShell>` placeholders that P3/P4 fill in (so the build stays green between phases).

### `dashboard/src/components/hud/AgentTile.tsx`
Presentational. Props: `{ name: string; status: 'online'|'idle'|'halted'; currentTask?: string; lastHeartbeatAgo: string }`. 80×80px tile, agent name, `current_task` truncated to 60 chars, time-since-heartbeat, status dot bottom-right colored `--hud-online` / `--hud-idle` / `--hud-halted`.

### `dashboard/src/components/hud/FleetStatusPanel.tsx`
Client component. Wrapped in `<PanelShell eyebrow="Fleet Status">`.
- Fetches `GET /api/agents` on mount and every 10s (`setInterval`, cleanup on unmount).
- One `<AgentTile>` per ACTIVE agent: frank2, larry, crm, muse, codexer, ophir, scout, maven.
- EXCLUDE disabled: sage, auditos, auditos2, sre, capital, academy, codexer-v2.
- Status mapping from heartbeat age: green online <3h, amber idle 3-12h, red halted/stale >12h. Compute age from the heartbeat timestamp returned by `/api/agents` (the route includes heartbeat data; if a field is missing, treat as halted).
- Type the API response with a proper interface (no `any`). Handle fetch errors gracefully (show a muted "—" state, do not crash the panel).

## Acceptance
- `/hud` renders the 6-panel grid; Fleet Status shows tiles for the 8 active agents with correct color by heartbeat age, updating every 10s.
- Disabled agents do not appear.
- `npm run build` clean.

## Constraints
- No `any`, no `console.log`. Define interfaces for the `/api/agents` shape.
- `setInterval` cleared on unmount (no leaks).
