# P4 — Comms (Panel 4) + Content Queue (Panel 5) + Quick Actions (Panel 6)

**Depends on:** P1 (`PanelShell`), P2 (polling pattern). Independent of P3 (disjoint files).

## Files to create

### `dashboard/src/components/hud/CommsPanel.tsx`  (Panel 4 — left, row 3)
Client component, `<PanelShell eyebrow="Comms Triage">`.
- Fetch `GET /api/comms/feed` on mount + every 10s. Optionally subscribe to `GET /api/events/stream` (SSE) for live updates — but SSE is OPTIONAL; 10s polling satisfies acceptance. If SSE is wired, use `EventSource` with cleanup on unmount.
- Show last 5 inbound messages (agent messages + Telegram): sender, snippet ≤80 chars, time ago, read/unread indicator dot.
- Fetch `GET /api/approvals?status=pending` and show the pending approvals COUNT (acceptance criterion 5).

### `dashboard/src/components/hud/ContentQueuePanel.tsx`  (Panel 5 — center, row 3)
Client component, `<PanelShell eyebrow="Content Queue">`.
- Fetch `GET /api/tasks?assignee=muse` and `GET /api/tasks?assignee=larry` on mount + every 10s.
- Show active muse tasks (LinkedIn/content in_progress) and active larry/codexer engineering tasks.
- Show last activity event per agent (derive from events feed if available; omit gracefully otherwise).

### `dashboard/src/components/hud/QuickActionsPanel.tsx`  (Panel 6 — right, row 3)
Client component, `<PanelShell eyebrow="Quick Actions">`.
- Render exactly 5 quick-action buttons: morning-review, evening-review, check-comms (comms), heartbeat, approvals (acceptance criterion 6). Optionally fetch `GET /api/skills` to confirm availability, but the 5 buttons are fixed.
- On click, fire the skill via `POST /api/home/dispatch` (send the skill/action identifier in the body matching whatever shape that route expects — inspect the route handler). Show a brief inline "dispatched" / error state; do NOT block the UI.
- Calendar section: a placeholder card with a "connect Google Calendar" empty state (Phase 2 — no real calendar fetch in P1).

## Acceptance
- Comms panel shows the pending approvals count (criterion 5).
- Quick Actions renders the 5 named buttons and each POSTs to `/api/home/dispatch` (criterion 6).
- Calendar shows the placeholder state.
- `npm run build` clean.

## Constraints
- No `any`, no `console.log`. Type all API responses and the dispatch body.
- `setInterval`/`EventSource` cleaned up on unmount.
- Do NOT add a Google Calendar integration in P1 — placeholder only.
