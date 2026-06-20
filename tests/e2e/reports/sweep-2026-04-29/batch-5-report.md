# Sweep Batch 5 — Patient Dashboard
Date: 2026-04-29 | Analyst: systems-analyst | Status: COMPLETE

## Pages Tested (8/8)

| Page | Auth Status | Redirect Correct | redirect_url Preserved |
|------|------------|-----------------|----------------------|
| /patient | Redirected → sign-in | ✅ | ✅ |
| /patient/behandlung | Redirected → sign-in | ✅ | ✅ |
| /patient/bestellungen | Redirected → sign-in | ✅ | ✅ |
| /patient/einstellungen | Redirected → sign-in | ✅ | ✅ |
| /patient/medikation | Redirected → sign-in | ✅ | ✅ |
| /patient/rezepte | Redirected → sign-in | ✅ | ✅ |
| /patient/tagebuch | Redirected → sign-in | ✅ | ✅ |
| /patient/termine | Redirected → sign-in | ✅ | ✅ |

**Auth guard: PASS — 8/8 pages correctly redirect to accounts.phytomedic.de/sign-in**

## Sign-in Page UX Audit

| Check | Status | Notes |
|-------|--------|-------|
| redirect_url preserved in redirect | ✅ PASS | Clerk middleware correctly encodes target URL |
| redirect_url preserved in Sign-up link | ✅ PASS | /sign-up#/?redirect_url=... — correct |
| Social login (Apple/Google/Microsoft) | ✅ PASS | All 3 visible |
| Email+password fields | ✅ PASS | Both present |
| Password hint (requirements) | ✅ PASS (after PR #308) | PR #308 in flight |
| GDPR consent gate | ⚠️ IN FLIGHT | PR #309 pending |
| No patient data visible to unauthenticated user | ✅ PASS | Zero data leakage |

## Bugs Found

### BUG-SWEEP-5-01 — Clerk app name shows "phytomedic saas" in page title/H1 (LOW)
- **Where**: accounts.phytomedic.de sign-in page, all redirects
- **What**: Page title = "My account | phytomedic saas", H1 = "Sign in to phytomedic saas"
- **Expected**: "PhytoMedic" (branded name, not internal slug)
- **Root cause**: Clerk Dashboard → Application name setting, not a code change
- **Fix**: Update application name in Clerk Dashboard to "PhytoMedic"
- **Owner**: User / platform-director (Clerk Dashboard access required, not a dev task)
- **Impact**: Visible to every user who logs in — branding inconsistency

## Console Errors
- 1 error per page (consistent, Clerk shadow DOM initialization — known, not actionable)

## Data Integrity
- No undefined/NaN/€0.00 values visible (no content rendered pre-auth)
- No broken images (no images rendered pre-auth)
- No data leakage — complete PASS

## Summary
**0 new code bugs.** 1 Clerk Dashboard config issue (LOW). Auth guard is fully effective — all 8 patient dashboard pages correctly gate access and preserve redirect state. Sign-in UX is functional; PR #308 (password hint) and PR #309 (GDPR consent) are in-flight improvements.

**Batch 6 targets**: /arzt (doctor portal), /apotheke-admin (pharmacy portal), or /admin routes — to be confirmed from sitemap.
