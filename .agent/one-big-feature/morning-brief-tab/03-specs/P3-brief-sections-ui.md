# P3 — Brief section components (depends on P1, P2, + AI-Today path)

**Goal:** Fill the three section slots with real data. Page becomes a live morning brief.

## Wire data in `(dashboard)/brief/page.tsx`
Gather server-side via `Promise.all`, mirroring HomePage:
- `getTasks({ agent: 'human', org })` → split into pending / in_progress / blocked + completed-today count (`getTasksCompletedToday` filtered to human, or filter `completed_at >= todayStart`).
- `getCrmPipeline()` (P2).
- AI Today artifact (see below).

## Create `src/components/brief/your-tasks.tsx`
- Props: the human tasks. **frank2 decision (2026-06-22): simple read-only list sorted by priority — NOT KanbanBoard.** The brief tab is read-only context; a compact priority-ordered list is the right mental model (less DOM, faster render, no interactivity). Group by status only if it reads cleanly (open vs blocked); otherwise one list sorted urgent→high→normal→low. Show completed-today as a collapsed `N done today` chip. Empty state: "No tasks waiting on you."

## Create `src/components/brief/crm-pipeline.tsx`
- Props: `CrmPipeline`. Show stat row (total · last 7d) + a list of the 5 recent contacts (`contactId`, `type` badge, relative date via `date-fns formatDistanceToNow`, truncated summary). Empty state: "No recent CRM activity."

## Create `src/components/brief/ai-today.tsx`
- **BLOCKED until frank2 confirms the AI-Today artifact path + format** (Open Item #1). Once known: read the artifact server-side (markdown → render with the existing markdown renderer used by `/wiki`, or JSON → 3 lens cards: Build impact / Client impact / One action). Empty state: "No AI brief generated today."

## Acceptance
- `/brief` shows real HUMAN tasks, real CRM totals/contacts, and the AI-Today analysis.
- Matches `feedback_brief_sections`: the three `##` sections present, no standalone Telegram duplication.
- `npm run build` clean, `npm test` green. Playwright screenshot of populated `/brief` for the PR.
