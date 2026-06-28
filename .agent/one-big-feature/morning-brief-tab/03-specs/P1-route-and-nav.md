# P1 — Route scaffold + sidebar nav

**Goal:** A reachable, authed, empty `/brief` tab inside the dashboard shell.

## Create `src/app/(dashboard)/brief/page.tsx`
- Server component. `export const dynamic = 'force-dynamic';`
- Signature mirrors `(dashboard)/page.tsx`: `async function BriefPage({ searchParams }: { searchParams: Promise<{[k:string]: string|string[]|undefined}> })`.
- Resolve org via `getHomeOrg(params.org)` (import from `@/lib/agents`) for parity with HomePage.
- Header: `<h1>` greeting + date via `format(new Date(), 'EEEE, MMMM d')` (`date-fns`, already a dep).
- Render three placeholder section slots in order, each a labeled container that P3 fills:
  `## 📋 Your Tasks`, `## 📊 CRM Pipeline`, `## 🧠 AI Today`.
- Layout container matches HomePage: `<div className="space-y-6 pb-8">`.
- NO data fetching yet (P3 wires it). NO modification to `(dashboard)/layout.tsx` — auth + shell are inherited.

## Modify `src/components/layout/sidebar.tsx`
- Add to `navItems`, in the `core` section immediately after `Overview`:
  `{ label: 'Brief', href: '/brief', icon: IconSunHigh, section: 'core' }`.
- Import `IconSunHigh` from `@tabler/icons-react` (confirm export name; fallback `IconNotes` already imported). No badge wiring.

## Acceptance
- Sidebar shows "Brief" under Overview; clicking routes to `/brief`.
- `/brief` renders inside the shell (sidebar + topbar), redirects to `/login` when unauthed.
- `npm run build` clean.
