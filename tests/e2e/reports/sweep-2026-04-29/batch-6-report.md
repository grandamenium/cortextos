# Sweep Batch 6 — Portal Auth Audit
Date: 2026-04-29 | Analyst: systems-analyst | Status: COMPLETE

## Route Discovery
Source: /robots.txt revealed all protected routes:
- /admin/, /patient/, /doctor/, /apotheke/, /hersteller/, /onboarding

## Portal Root Auth Gates

| Route | Auth Status | Result |
|-------|------------|--------|
| /doctor | → accounts.phytomedic.de/sign-in | ✅ PASS |
| /apotheke | → accounts.phytomedic.de/sign-in | ✅ PASS |
| /hersteller | → accounts.phytomedic.de/sign-in | ✅ PASS |
| /admin | → accounts.phytomedic.de/sign-in | ✅ PASS |
| /onboarding | Renders role hub (intentionally public) | ✅ EXPECTED |

## Portal Sub-Route Auth Gates

| Route | Auth Status | Result |
|-------|------------|--------|
| /doctor/patienten | → sign-in | ✅ PASS |
| /doctor/rezepte | → sign-in | ✅ PASS |
| /apotheke/bestellungen | → sign-in | ✅ PASS |
| /admin/users | → sign-in | ✅ PASS |
| /hersteller/produkte | → sign-in | ✅ PASS |

## Onboarding Sub-Routes

| Route | Auth Status | Result |
|-------|------------|--------|
| /onboarding/arzt | Renders full form (no auth) | 🔴 BYPASS |
| /onboarding/apotheke | Renders full form (no auth) | 🔴 BYPASS |
| /onboarding/patient | 404 | ✅ N/A |
| /onboarding/hersteller | 404 | ✅ N/A |

## Security Bugs (HIGH)

### BUG-SWEEP-6-01 — /onboarding/arzt accessible without authentication
- **Form fields**: Praxis-Name, Fachrichtung, Kassenart + "Profil erstellen" button
- **Risk**: Unauthenticated users can view and interact with doctor profile creation form
- **Data risk**: Convex mutations likely gate server-side, but not verified
- **Fix**: Add Clerk auth middleware protection to /onboarding/arzt → redirect to sign-in with redirect_url preserved
- **Owner**: frontend-dev (routed via platform-director — immediate action)

### BUG-SWEEP-6-02 — /onboarding/apotheke accessible without authentication
- **Form fields**: Apotheken-Name, Stadt, PLZ + "Weiter" button
- **Risk**: Same as above — pharmacy profile creation form exposed
- **Fix**: Same middleware fix — protect /onboarding/apotheke route
- **Owner**: frontend-dev (same PR as BUG-SWEEP-6-01)

## Onboarding Flow — Functional Verification (PASS)

All 4 role cards on /onboarding verified working (PR #292 fix confirmed):
- Patient → /registrieren?redirect_url=%2Fpatient ✅
- Arzt/Ärztin → /registrieren?redirect_url=%2Fonboarding%2Farzt ✅
- Apotheke → /registrieren?redirect_url=%2Fonboarding%2Fapotheke ✅
- Hersteller → /registrieren?redirect_url=%2Fhersteller ✅

## GDPR Consent Gate Status
/registrieren: `hasConsentCheckbox: false` — PR #309 not yet merged. HUNT-06 open.

## Summary
**2 HIGH security bugs** (auth bypass on /onboarding/arzt + /onboarding/apotheke).
All other portal routes (4 roots + 5 sub-routes tested) correctly auth-gated.
Bugs escalated to platform-director → frontend-dev for immediate fix.

**Batch 7 targets**: Public marketing pages — /medizin/online-rezept, /eignungstest, /thc-rechner, /standorte (Batch 5 originally planned — these are now the remaining untested public pages).
