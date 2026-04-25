---
name: verify-fixes-landed
description: "Iterative fix-verification loop. For every bug task marked completed, actually VERIFY the fix is live on production — not just that a PR was merged. Re-opens the task if the bug still reproduces."
triggers: ["verify fixes", "check completions", "validate tasks", "fix verification", "iteration check"]
---

# Verify Fixes Landed

> A task is NOT done when a PR merges. A task is done when the bug
> is GONE from production. This skill is the closing-of-the-loop.

---

## When to run

- Every 2h (cron `verify-fixes-landed`)
- After morning-briefing (09:30) to pre-check what to report
- On-demand when user asks "ist X gefixt?"

---

## Algorithm

```
for each task in tasks.list --status completed --updated-since last-24h:
    if task title starts with "[BUG-" or "[E2E-" or "[LEGAL-" or "[DASH-":
        extract PR URL from task.result
        if no PR URL → REOPEN task with note "no PR url — cannot verify"
        continue

        if PR state != merged → REOPEN task with note "PR not merged"
        continue

        verify_fix_on_prod(task):
            # Use Playwright Mode A (MCP browser tools)
            case: page loads without error?
                → browser_navigate to affected URL
                → browser_console_messages (errors = fail)
            case: specific element appears/disappears?
                → browser_evaluate with selector
            case: data correct?
                → convex query against prod
            case: count > 0?
                → body.innerText match pattern

        if verification_fails:
            REOPEN task with evidence (screenshot, console log, expected vs actual)
            message assignee: "Fix did NOT land — <what's wrong>"
        else:
            leave task completed, log verification_ok event
```

---

## Specific verification recipes

### BUG-QA-01 (Product images missing)
```
navigate: /medizin/produkte
evaluate: document.images.length
PASS: >= 12 (at least first page of products has images)
FAIL: 0 — images still missing
```

### BUG-QA-02 (Catalog pagination)
```
navigate: /medizin/produkte
scroll to bottom (browser_evaluate window.scrollTo(0, document.body.scrollHeight))
wait 2s
evaluate: document.querySelectorAll('[href*="/medizin/produkte/"]').length
PASS: > 24 (pagination loaded more)
FAIL: = 24 (still blocked)
```

### BUG-QA-03 (Clerk display name)
```
navigate: /login
evaluate: document.body.innerText
PASS: includes "PhytoMedic einloggen" and NOT "phytomedic saas"
```

### BUG-QA-04 (Strain DB empty)
```
navigate: /medizin/sorten
evaluate: document.body.innerText
PASS: does NOT include "0 Sorten" or "Keine Sorten gefunden"
```

### BUG-QA-05 (Title duplicate)
```
navigate each of: /medizin/produkte, /medizin/sorten, /medizin/arzt-finden, /medizin/apotheke-finden, /checkout, /wissen
evaluate: document.title.match(/PhytoMedic/g).length
PASS: exactly 1 per page (no duplicates)
```

### BUG-QA-06 (Rezeptkosten visible)
```
navigate: /medizin/produkte/<first-slug>, click "Rezept beantragen", /checkout...
evaluate: /(Rezeptkosten|Konsultationsgebühr|Arzt-?honorar)/.test(document.body.innerText)
PASS: true
```

### BUG-QA-07 (Wissen content)
```
navigate: /wissen
evaluate: document.querySelectorAll('a[href*="/wissen/"]').length
PASS: > 5
```

### BUG-QA-08 (Arzt-finden not empty)
```
navigate: /medizin/arzt-finden
evaluate: /(Keine Ärzte gefunden|0 Ärzte)/.test(document.body.innerText) ? FAIL : body has doctor cards
```

### BUG-QA-13/14 (AGB / Datenschutz)
```
navigate each: /agb, /datenschutz
evaluate: body.length
PASS: > 6000 (real content, not stub)
AND: query.sections.length > 10
```

### BUG-QA-15 (Impressum)
```
navigate: /impressum
evaluate: /\[.*wird ergänzt\]|\[Platzhalter|\[PLZ Ort\]/.test(body)
PASS: false (no placeholders)
```

### DASH-* tasks (role dashboards)
```
if test-login available in preview:
    login as each role
    navigate to dashboard root (/patient, /doctor, /apotheke, /hersteller, /admin)
    evaluate: document.querySelectorAll('[data-widget], [data-kpi], [data-chart]').length
    PASS: >= expected widget count per role (5+ for patient, 8+ for doctor, etc.)
    AND: no "No Data" or empty-chart placeholders on all widgets
```

---

## Re-open protocol

When a verification fails, re-open with DETAILED evidence:

```bash
cortextos bus update-task <id> pending --reason "Fix did not land: <specific>"
cortextos bus send-message <assignee> urgent \
  "Task <id> reopened. You marked as merged (PR #XX) but verification failed on $(date):

VERIFICATION STEP THAT FAILED:
<what was checked, expected, actual>

EVIDENCE:
- URL checked: <url>
- Expected: <text or count>
- Actual: <text or count>
- Console errors: <list>
- Screenshot: <path>

Most likely causes:
1. Deploy cache (wait 5-10 min, verify again)
2. Fix landed on preview but not main/prod — check git log
3. Feature-flagged — is there a toggle in config?
4. Fix didn't address root cause — re-diagnose

Please investigate, push fix, and mark complete only AFTER you verify on prod yourself."
```

---

## Daily report

At 09:30 morning-briefing, append a section:

```
📊 Fix-Verification Report (letzte 24h)
- Tasks completed: N
- Verified-OK: X (list titles)
- Reopened after failed verify: Y (list titles + reason)
- Still pending verify (just merged): Z
```

---

## Cron

```json
{
  "name": "verify-fixes-landed",
  "interval": "2h",
  "prompt": "Read .claude/skills/verify-fixes-landed/SKILL.md and run the full verification sweep. Re-open tasks where fix didn't land. Log results."
}
```

---

*Single source of truth for verifying that fixes actually shipped.*
