---
name: pre-completion-live-recheck
description: "MANDATORY step between PR-merge and complete-task. Drive the live production URL with Playwright Mode A. Verify the bug is gone AS A USER WOULD SEE IT. No PR merge counts as done without this. Per user directive 2026-04-25."
triggers: ["pre-completion check", "live recheck", "verify on prod", "is it really fixed", "before complete-task"]
---

# Pre-Completion Live Recheck

> User directive 2026-04-25: "bevor der task abgeschlossen ist, soll das
> nochmal jeweils überprüft werden auf der seite."
>
> Translation: "Merged PR" ≠ "Fixed". Open the live URL. Look. Then say done.

---

## When to run

**Always, before `cortextos bus complete-task <id>`.** No exceptions.

Trigger sequence:
```
PR merged → CI green → main deployed (~3min) → run THIS skill → THEN complete-task
```

Skip ONLY for these task types:
- Internal refactors with no user-visible change
- Infrastructure-only (CI config, deps bumps with no UI impact)
- Documentation-only

For all task types prefixed `[BUG-]`, `[QA-]`, `[REOPEN-]`, `[E2E-]`, `[EC-]`, `[FB-]`, `[DASH-]`, `[CONV-]`: NEVER skip.

---

## Protocol (5 steps, ~5 min)

### Step 1 — Wait for prod deploy

```bash
# After merge, wait until "Deploy Production" run is success on the merge commit
SHA=$(git rev-parse HEAD)
for i in {1..15}; do
  status=$(gh run list --repo syntasticstudios/phytomedic-saas --branch main --limit 5 --json conclusion,headSha,name --jq ".[] | select(.headSha == \"$SHA\" and .name == \"Deploy Production\") | .conclusion")
  [ "$status" = "success" ] && break
  sleep 30
done
```

Don't skip. Verifying against stale prod = false-pass.

### Step 2 — Open the affected URL on www.phytomedic.de

Per task type:
| Task type | URL to load |
|-----------|-------------|
| Catalog/listing change | `/medizin/produkte` (+ filters URL) |
| Product detail | `/medizin/produkte/[a-real-slug]` |
| Strain page | `/medizin/sorten/[slug]` |
| Header/nav change | any page (e.g. `/`) |
| Cart/checkout | `/medizin/produkte/[slug]` → click "Rezept beantragen" |
| Auth | `/login` AND `/registrieren` |
| Dashboard | login as test-user-of-role + load dashboard |
| Email/notification | trigger the action that sends the email, then check inbox |
| Migration/seed | run a query to count, see expected delta |

### Step 3 — Run the task-specific assertion

Each task description should contain a `VERIFY:` line. Execute it via Playwright Mode A:

```
mcp__plugin_playwright_playwright__browser_navigate url=<from step 2>
mcp__plugin_playwright_playwright__browser_console_messages level=error  # must be empty
mcp__plugin_playwright_playwright__browser_network_requests  # no 4xx/5xx
mcp__plugin_playwright_playwright__browser_evaluate function="<task-specific assertion>"
mcp__plugin_playwright_playwright__browser_take_screenshot filename=verify-<taskId>.png
```

If the task description has no clear `VERIFY:` line, use **feature-completeness-checklist** all 12 checks as fallback.

### Step 4 — Compare against baseline

For bug-fixes: the bug must be GONE. Concrete test:

| Bug pattern | Pass condition |
|-------------|----------------|
| Empty list ("0 X gefunden") | Count > 0 |
| Missing element | element selector matches |
| Wrong text | text NOT in body OR new text in body |
| Title duplicate | `(document.title.match(/PhytoMedic/g) || []).length === 1` |
| Broken image | `[...document.images].every(i => i.naturalWidth > 0)` |
| Console error | `console.errors.length === 0` |
| 4xx/5xx | no failed network requests |
| Decorative tag | tag has `closest('a')` or `tagName === 'A'` |
| Missing CTA | `[...buttons].some(b => /<expected text>/.test(b.textContent))` |

For features: the feature must be VISIBLE + INTERACTIVE.

### Step 5 — Decide

**Pass:** All assertions ✅ → Proceed to complete-task with PR-URL + screenshot path in result.

**Fail:** Any assertion ❌ → DO NOT complete-task. Instead:
1. Reopen / extend the task with reproduction
2. Push fix-commit to same branch
3. Wait for re-deploy
4. Run this skill AGAIN

Don't loop more than 3 times. After 3rd failure, escalate to platform-director.

---

## Common Pitfalls (avoid)

- **Pitfall:** Verifying against `localhost:3000` or preview URL, not www.phytomedic.de.
  **Fix:** Always production URL. Preview deploys lie (different env vars, different data).

- **Pitfall:** Skipping step 1 (deploy wait) → checking stale prod → false pass.
  **Fix:** Always wait for the merge SHA's Deploy Production = success.

- **Pitfall:** "Looks good in browser" without specific assertion.
  **Fix:** Run `browser_evaluate` with explicit boolean. Visual check is not enough.

- **Pitfall:** Checking only desktop viewport.
  **Fix:** Resize to mobile (375x667) for any UI fix and check again.

- **Pitfall:** Test data missing → bug appears fixed because no data path triggered.
  **Fix:** Use seeded test entities OR explicitly note "verified empty-state" if intentional.

---

## Result Format for complete-task

```bash
cortextos bus complete-task <id> --result "Merged as PR #XX: <summary>.
VERIFIED on https://www.phytomedic.de<path> at $(date -Iseconds):
- <assertion 1>: PASS
- <assertion 2>: PASS
- ...
Screenshot: tests/e2e/reports/verify-<taskId>.png"
```

Without VERIFIED block → platform-director's `verify-fixes-landed` cron will reopen.

---

*Last gate before "done". User said: don't skip.*
