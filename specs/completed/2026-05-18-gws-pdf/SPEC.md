# GWS-Security Server-Side PDF Export (option C) — AUDIT after BUILD

**Status**: POST_IMPL_AUDIT (state machine inverted — code at 1cf3922 was built before this spec)
**Repo**: /Users/joshweiss/code/gws-security
**Branch**: feature/pdf-server-side-export
**Head**: 1cf39226b7690444ee1ba1099703eefd9e850175
**Task**: task_1779147799785_10098973 (larry, in_progress)

## Problem
Chrome freezes when user clicks "Save as PDF" after viewing the report preview. Root cause: `templates/report.html:8` `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap')` — Chrome refetches Google Fonts during print-save → hang. Only external resource in the report.

## Solution: server-side WeasyPrint PDF
Replace Chrome print-to-PDF flow with a server-side WeasyPrint render. Direct download, no browser dialog.

## Scope (all delivered at 1cf3922)
1. `pyproject.toml`: add `weasyprint>=63.0`
2. `nixpacks.toml` (NEW at repo root): native deps via nixPkgs `["pango", "cairo", "gdk-pixbuf", "libffi", "shared-mime-info"]`
3. `app.py`: new `GET /assessment/<id>/report.pdf` route (mirrors lines 593-621 `assessment_report`, renders via WeasyPrint, returns `application/pdf`). Keep existing HTML route for backwards-compat.
4. `templates/report.html`: remove `@import` (line 8), add 4 `@font-face` rules for Inter 400/500/600/700 woff2. Delete auto-print script (lines 827-831).
5. `templates/dashboard.html`: switch Export button from `/assessment/<id>/report?print=1` (target=_blank) to `/assessment/<id>/report.pdf` (download link with tenant-based filename).
6. `static/fonts/`: bundle Inter WOFF2 (SIL OFL license) for 400/500/600/700.

## Acceptance
1. `curl -L /assessment/<id>/report.pdf` returns `application/pdf`, valid PDF (file(1) reports PDF magic bytes).
2. Visual diff: first page contains expected cover strings ("Google Workspace", "Security Assessment", tenant name) and renders Inter font (no serif substitution).
3. Zero `fonts.googleapis.com` hits during render (rendered HTML contains no such URL).
4. Dashboard Export button downloads directly (Content-Disposition: attachment).
5. Railway staging nixpacks build succeeds; staging URL serves /assessment/<id>/report.pdf.

## State-machine note
The proper state machine order is DRAFT_SPEC → LARRY_SPEC_REVIEW → SPEC_PASS → ARCH_REVIEW → CODEX_IMPL → LARRY_BUILD_REVIEW → STAGING_VALIDATE → PR_OPENED → JOSH_MERGES. This dispatch went out earlier with the home-redesign spec active (gap), so ACs are now being audited after implementation. The next deployable change to this branch must rewind to DRAFT_SPEC.

## Next phases
- POST_IMPL_AUDIT (this) → STAGING_VALIDATE (Railway staging deploy + visual diff) → PR_OPENED → JOSH_MERGES
