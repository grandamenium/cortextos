# P5 — Sidebar nav + build/verify + screenshot (gates the PR)

**Depends on:** P1-P4 complete.

## File to modify

### `dashboard/src/components/layout/sidebar.tsx`
- Add a single "HUD" nav item linking to `/hud`. Match the existing nav-item pattern/styling in that file (icon optional — reuse whatever icon convention the sidebar already uses). Do NOT restructure the sidebar; one item added.
- This is the ONLY file modified in the entire feature. `(dashboard)/layout.tsx` stays untouched (architecture fix).

## Verification (codexer runs, reports back to Larry)

1. `cd dashboard && npm run build` — MUST be clean, zero TypeScript errors (acceptance criterion 7).
2. Confirm grep: `--hud-` does NOT appear in `globals.css :root` (tokens scoped to `.hud-root`).
3. Confirm route group is `src/app/(hud)/hud/`, NOT `src/app/(dashboard)/hud/`.
4. Confirm `src/app/(dashboard)/layout.tsx` is unchanged (`git diff` shows no hunk for it).

## Screenshot (Larry runs before PR — NOT codexer)

After the diff passes Larry's adversarial build-review:
- Run the dashboard locally (`cd dashboard && npm run dev` or against the running `:3000`), navigate to `/hud` (authenticated), `browser-harness` `new_tab` → `wait_for_load` → `capture_screenshot`.
- Verify visually: full-screen, NO sidebar/topbar, 6 panels visible, dark glassmorphism, live clock, back button (acceptance criteria 1, 2, 8).
- Send the screenshot to Josh for review (acceptance criterion 9) BEFORE opening the PR.

## Acceptance
- All 9 of `01-spec.md` acceptance criteria met.
- Build clean, scope gates pass, screenshot delivered to Josh.

## Constraints
- No `any`, no `console.log`.
- This phase opens NOTHING — Larry opens the PR only after the screenshot + Josh's go-ahead. Josh approves the merge.
