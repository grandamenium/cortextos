# P1 — Route group + auth-gated full-screen shell + HUD tokens

**Gates:** everything (P2-P5 render inside this shell).

## Files to create

### `dashboard/src/app/(hud)/hud/layout.tsx`
Server component. Repeat the auth gate from `(dashboard)/layout.tsx` EXACTLY (do not weaken it):
- `hasBearerDashboardAccess()`: read `authorization` header; if it starts with `Bearer `, verify the token with `jwtVerify` (from `jose`) against `new TextEncoder().encode(process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET)`; return true on success, false on any failure/missing secret.
- In the layout: `const bearerAccess = await hasBearerDashboardAccess(); if (!bearerAccess) { const session = await auth(); if (!session) redirect('/login'); }`
- Render `{children}` full-screen with NO `DashboardShell`, NO sidebar, NO topbar. Wrap in a `<div className="hud-root">` that sets the `--hud-*` CSS custom properties (scoped, NOT global `:root`) and `min-height: 100vh; overflow: hidden; background: var(--hud-bg); color: var(--hud-text); font-family: Inter`.
- Scope the tokens via a CSS module (`hud.module.css`) OR an inline `<style>` block on `.hud-root`. Do NOT add `--hud-*` to `globals.css :root`.

Imports mirror `(dashboard)/layout.tsx`: `auth` from `@/lib/auth`, `headers` from `next/headers`, `jwtVerify` from `jose`, `redirect` from `next/navigation`. Do NOT import `DashboardShell`, `getOrgs`, or `getAgentsList` (not needed — no shell).

### `dashboard/src/app/(hud)/hud/page.tsx`
Server component. Minimal — renders `<HUDLayout />` (client component from P2). No data fetching here (panels self-fetch client-side for 10s polling).

### `dashboard/src/components/hud/PanelShell.tsx`
Client or server component (shared wrapper). Props: `{ eyebrow: string; className?: string; children: React.ReactNode }`. Renders a glassmorphism panel: `background: var(--hud-panel)`, `border: 1px solid var(--hud-border)`, `border-radius: 12px`, `backdrop-filter: blur(12px)`, padding. Header = `eyebrow` in `var(--hud-accent-2)` (coral), 11px, uppercase, letter-spacing wide. `className` allows grid-span overrides (e.g. Panel 1 spans 2 cols).

### `dashboard/src/components/hud/LiveClock.tsx`
Client component (`'use client'`). Renders HH:MM:SS, updates every second via `setInterval`, cleans up on unmount. Styled in `var(--hud-muted)`. No `any` — type the interval ref properly (`ReturnType<typeof setInterval>`).

## Acceptance
- `npm run build` clean in `dashboard/`.
- Navigating to `/hud` while authenticated renders a full-screen dark background with NO sidebar/topbar.
- Navigating to `/hud` while unauthenticated redirects to `/login`.
- `--hud-*` tokens are NOT present on global `:root` (grep `globals.css`).

## Constraints
- No `any`, no `console.log`.
- Route group MUST be `(hud)`, a sibling to `(dashboard)` — NOT `(dashboard)/hud`.
- Do NOT modify `(dashboard)/layout.tsx`.
