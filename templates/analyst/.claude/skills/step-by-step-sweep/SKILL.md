---
name: step-by-step-sweep
description: "Systematic page-by-page sweep of PhytoMedic. Takes a checklist of ~108 pages (public + dashboards per role), tests each with Playwright Mode A, creates a bug-task per finding, routes to the right agent. Chunked in 10-page batches to keep context manageable."
triggers: ["step-by-step sweep", "systematic test", "full page sweep", "audit all pages", "sweep phytomedic"]
---

# Step-by-Step Sweep

> User said: "schritt für schritt das phytomedic projekt prüfen damit alles
> richtig funktioniert und dargestellt wird, auch layout optimiert für
> schnelle und hohe conversion".
>
> This is the systematic execution of that. No skipping, no batching
> past what fits in one context window.

---

## Master Checklist (108 pages)

### Batch 1: Public Landing + Legal (10 pages)
- [ ] / (landing) — Hero, 4-step explainer, testimonials (⚠️ generic names), CTAs
- [ ] /agb — Content completeness (>8k chars, >10 sections)
- [ ] /datenschutz — DSGVO completeness
- [ ] /impressum — Pflichtangaben, no [Platzhalter]
- [ ] /login — Clerk brand name, german, no "phytomedic saas"
- [ ] /registrieren — Clerk brand, deutsche Localization, consent checkbox
- [ ] /medizin (hub) — 10 Tools CTAs work
- [ ] /medizin/online-rezept — Anbieter-Liste nicht leer
- [ ] /medizin/eignungstest — Form läuft durch, validation
- [ ] /medizin/thc-rechner — Input-Validation, Output-Plausibilität

### Batch 2: Public Medizin + Krankheiten + Freizeit (10)
- [ ] /medizin/steuererstattung — Rechner funktioniert
- [ ] /medizin/bluetenfinder — Recommendation-Output sinnvoll
- [ ] /medizin/produkte — Pagination (BUG-QA-02 verify), Filter-Combinations
- [ ] /medizin/produkte/[slug] — Hero, Preisvergleich, Related
- [ ] /medizin/sorten — Liste nicht leer (BUG-QA-04)
- [ ] /medizin/sorten/[slug] — Lineage-Graph, Produkte
- [ ] /medizin/sorten/vergleich — Multi-Select + Compare-Table
- [ ] /medizin/standorte — Map funktioniert
- [ ] /medizin/arzt-finden — Ärzte nicht leer (BUG-QA-08)
- [ ] /medizin/apotheke-finden — 200 Apotheken, Filter work

### Batch 3: Checkout + Onboarding (8)
- [ ] /checkout Step 1 Warenkorb — Produkt, Apotheke-Dropdown, Qty
- [ ] /checkout Step 2 Registrierung — Clerk-Login einbettbar
- [ ] /checkout Step 3 Fragebogen — Multi-Step, 31 Beschwerden, Validation
- [ ] /checkout Step 4 Zahlung — Stripe + Rezeptkosten sichtbar (BUG-QA-06)
- [ ] /checkout Step 5 Bestätigung — Redirect funktioniert (BUG-QA-03 env)
- [ ] /onboarding — Role-Selection
- [ ] /onboarding/arzt — Doctor-Onboarding-Flow
- [ ] /onboarding/apotheke — Pharmacy-Onboarding-Flow

### Batch 4: Wissen + Freizeit + Therapiekarte (7)
- [ ] /wissen (0 Artikel — BUG-QA-07)
- [ ] /wissen/[slug] — Article-Rendering, JSON-LD
- [ ] /krankheiten (0 Einträge — BUG-QA-16)
- [ ] /krankheiten/[slug] — Content, related products
- [ ] /freizeit — Hub-Page
- [ ] /freizeit/clubs (0 Clubs — BUG-QA-19)
- [ ] /freizeit/clubs/[id] — Detail-Page

### Batch 5: Patient Dashboard (8)
Login as patient (/test-login?role=patient) on preview
- [ ] /patient — Widgets per DASH-PATIENT spec
- [ ] /patient/behandlung — Therapie-Übersicht
- [ ] /patient/bestellungen — Liste, Filter, Tracking-Links
- [ ] /patient/einstellungen — Profile-Edit, Consent-Revoke (GDPR)
- [ ] /patient/medikation — Dosierung + History
- [ ] /patient/rezepte — Aktive Rezepte, Nachbestellen-CTA
- [ ] /patient/tagebuch — Eintrag-Form, Kalender-View
- [ ] /patient/termine — Upcoming + Past, Videocall-Buttons

### Batch 6: Doctor Dashboard (13)
Login as doctor
- [ ] /doctor — Widgets per DASH-DOCTOR
- [ ] /doctor/bewertungen — Review-Table, Response-CTA
- [ ] /doctor/einstellungen — Profile, Standorte
- [ ] /doctor/faelle — FIFO-Queue, Claim-Button
- [ ] /doctor/patienten — Liste
- [ ] /doctor/patienten/[id] — Full Patient-Dossier mit Questionnaire
- [ ] /doctor/rezepte — Historie
- [ ] /doctor/rezepte/neu — Erstellen-Flow + PDF-Gen
- [ ] /doctor/standorte — CRUD
- [ ] /doctor/statistiken — Charts per DASH-DOCTOR
- [ ] /doctor/termine — Scheduling
- [ ] /doctor/videocall — Upcoming-Liste
- [ ] /doctor/videocall/[id] — Twilio/Daily-Integration, Permissions

### Batch 7: Pharmacy Dashboard (16)
Login as pharmacy
- [ ] /apotheke — Widgets per DASH-PHARMACY
- [ ] /apotheke/auslieferungen — Versand-Liste
- [ ] /apotheke/bestellungen — Orders-Tabelle
- [ ] /apotheke/druckkalkulator — Kalkulator
- [ ] /apotheke/einkauf — Hersteller-Browse
- [ ] /apotheke/einkauf/[productId] — Detail + In-Warenkorb
- [ ] /apotheke/einkauf/druck — Bestell-Liste-PDF
- [ ] /apotheke/einstellungen — Profile + deliveryOptions
- [ ] /apotheke/lieferkanaele — Versand/Abholung Config
- [ ] /apotheke/marktanalyse — Charts
- [ ] /apotheke/rechnungen — Invoices + Download
- [ ] /apotheke/rezeptanalyse — Dashboard
- [ ] /apotheke/rezepte — Queue + Actions
- [ ] /apotheke/sammelkauf — Group-Buy
- [ ] /apotheke/sortiment — Produktliste + Add/Edit
- [ ] /apotheke/zahlungen — Payouts

### Batch 8: Manufacturer Dashboard (11)
Login as manufacturer
- [ ] /hersteller — Widgets per DASH-MANUFACTURER
- [ ] /hersteller/apotheken — Partner-Liste
- [ ] /hersteller/bestandsliste — Produkte
- [ ] /hersteller/deliverables — Berichte
- [ ] /hersteller/einstellungen
- [ ] /hersteller/fokus — Strategic-Focus
- [ ] /hersteller/marktanalyse — Deep-Charts
- [ ] /hersteller/reports — Export
- [ ] /hersteller/roi
- [ ] /hersteller/standorte
- [ ] /hersteller/statistiken

### Batch 9: Admin Dashboard A (12)
Login as admin
- [ ] /admin — Widgets per DASH-ADMIN
- [ ] /admin/apotheken-dokumente — Pending review
- [ ] /admin/arzt-verifizierung — Pending doctors
- [ ] /admin/b2b — Hub
- [ ] /admin/b2b/bestellungen
- [ ] /admin/b2b/bestellungen/[id]
- [ ] /admin/b2b/lieferanten
- [ ] /admin/b2b/rechnungen
- [ ] /admin/b2b/routing
- [ ] /admin/b2b/sammelbestellungen
- [ ] /admin/bestellungen
- [ ] /admin/cannaflow-zahlungen

### Batch 10: Admin Dashboard B (13)
- [ ] /admin/cannaleo — Sync-Status
- [ ] /admin/cannametrics — Overview
- [ ] /admin/cannametrics/preisvergleich
- [ ] /admin/cannametrics/hersteller/[manufacturer]
- [ ] /admin/catalog — 8k+ products, search works
- [ ] /admin/einstellungen
- [ ] /admin/hersteller — Liste
- [ ] /admin/integrations — Health dashboard
- [ ] /admin/marktanalyse
- [ ] /admin/nutzer — User search + actions
- [ ] /admin/nutzer/[id]
- [ ] /admin/rezeptgebuehren — Fee config (fixt BUG-QA-06!)
- [ ] /admin/sammelbestellungen
- [ ] /admin/verifizierung

---

## Per-Page Test Protocol

For each page, run in Playwright Mode A:

```
1. browser_navigate <url>
2. browser_console_messages level=error → MUST be empty
3. browser_network_requests → any 4xx/5xx (non-auth) = FAIL
4. browser_snapshot → capture structure
5. browser_take_screenshot → save to tests/e2e/reports/sweep-YYYY-MM-DD/<role>/<slug>.png
6. browser_evaluate quick-scan:
   - undefined / NaN / €0.00 / lorem / placeholder / [wird ergänzt]
   - Title duplicate ("PhytoMedic | PhytoMedic")
   - All images.complete + naturalWidth > 0
   - Empty-state messaging elegant or naked "0 gefunden"
7. If dashboard page: verify widgets per DASH-* spec
8. If form page: try valid + empty submit (validation check)
9. Mobile viewport (resize 375x667) + screenshot
```

---

## Bug-Task Creation Convention

For every finding, create a task with standardized ID:

```bash
cortextos bus create-task "[BUG-SWEEP-<BATCH>-<NN>] <short title>" \
  --desc "URL: <url>
    Expected: <what should be>
    Actual: <what is>
    Screenshot: tests/e2e/reports/sweep-YYYY-MM-DD/<path>
    Console: <errors>
    Repro: 1. <step> 2. <step>
    Routing: <UI/data/integration>" \
  --assignee <frontend-dev|backend-architect|integrations-routing|cannametrics-data> \
  --priority <urgent|high|normal|low>
```

Priority heuristic:
- Data leak / wrong user sees other tenant data → urgent
- Checkout/payment/auth broken → urgent
- Dashboard widget crashes → urgent
- Layout broken on mobile → high
- Missing graph / empty state → high
- Typos / copy issues → normal
- Nitpick / polish → low

---

## Dedup Before Filing

Before creating a bug-task, search existing:

```bash
cortextos bus list-tasks --search "<key phrase from bug>"
```

If similar task exists:
- Status `pending/in_progress` → append note to that task, don't create duplicate
- Status `completed` less than 24h ago → this is a regression, tag `regression` + create new with `URGENT`

---

## Progress Tracking

After each batch:

```bash
# Write batch report
cat > tests/e2e/reports/sweep-YYYY-MM-DD/batch-N-report.md <<EOF
## Batch N — $(date)
Pages tested: <count>
Pass: <count>
Fail: <count>

### Bugs filed
- BUG-SWEEP-N-01 <title>
- BUG-SWEEP-N-02 <title>
...
EOF

# Update status via heartbeat
cortextos bus update-heartbeat "sweep-batch-N complete: X bugs filed"
```

## Chunking rule

ONE batch per session. 10 pages max. Take notes, write report, stop.
Next batch = next cron-tick or next /trigger-sweep instruction.

This prevents context overflow and lets you be thorough instead of shallow.

---

## Cron schedule

```json
{
  "name": "step-by-step-sweep",
  "interval": "6h",
  "prompt": "Read .claude/skills/step-by-step-sweep/SKILL.md. Continue with next unfinished batch. Write report, create bug tasks, signal platform-director when all 10 batches complete."
}
```

---

*Single source of truth for the exhaustive page-by-page sweep.*
