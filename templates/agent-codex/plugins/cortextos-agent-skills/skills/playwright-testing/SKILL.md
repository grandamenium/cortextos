---
name: playwright-testing
description: "Actively drive a real browser via Playwright to test what you just built. Use BEFORE opening a PR to verify your change actually works end-to-end. Two modes: scripted test files (tests/e2e/*.spec.ts) and interactive browsing via MCP playwright tools."
triggers: ["playwright", "e2e test", "browser test", "test my change", "verify ui", "check page renders", "test flow"]
---

# Playwright Testing

> You are not done coding until you've seen your change work in a real
> browser. This skill is the feedback loop — drive the browser, see what
> renders, fix what's broken, repeat.

---

## When to use

### Always before opening a PR
- UI change → load the affected page, click through the flow
- API change → load the page that calls it, check network + console
- Form change → fill the form, submit, verify response
- Data change → verify the data renders correctly in all places it appears

### During debugging
- User reports "X doesn't work" → reproduce in browser first
- Greptile flags a UI issue → verify in browser
- After a migration — screenshot the affected pages

---

## Two modes

### Mode A: MCP browser tools (interactive, fast iteration)

For exploring, debugging, taking one-off screenshots. Uses the
`mcp__plugin_playwright_playwright__*` tool family already available
in this environment. NO code to write, NO test file — just drive the
browser directly.

```
1. browser_navigate url=https://www.phytomedic.de/medizin/produkte
2. browser_snapshot     (get accessibility tree — is everything rendered?)
3. browser_take_screenshot    (visual check)
4. browser_console_messages   (any errors? any warnings?)
5. browser_network_requests   (any 404s? any 500s?)
6. browser_click element="product card 'London Pound Cake'"
7. browser_snapshot           (did navigation work? did data load?)
8. browser_evaluate function="() => ({ cbd: document.querySelector('[data-cbd]')?.textContent, thc: ... })"
```

When to use Mode A:
- Testing YOUR change right now
- Reproducing a user-reported bug
- Sanity-checking before opening a PR
- Quick "does this page even load" check

### Mode B: Scripted spec file (reproducible, runs in CI)

For permanent regression tests. Goes into `tests/e2e/*.spec.ts` and runs
on every PR (Unit Tests workflow). Use when:
- The flow is important enough to always test
- Multiple steps that need to run together
- Needs to run against multiple browsers/viewports

```typescript
// tests/e2e/product-detail.spec.ts
import { test, expect } from "@playwright/test"

test("product detail page shows CBD/THC correctly", async ({ page }) => {
  await page.goto("/medizin/produkte/london-pound-cake")
  await expect(page.getByRole("heading", { level: 1 })).toContainText("London Pound Cake")
  await expect(page.locator("[data-testid=cbd-value]")).toContainText(/\d+\.\d+%/)
  await expect(page.locator("[data-testid=thc-value]")).toContainText(/\d+\.\d+%/)
  // Must NOT see data errors
  const body = await page.textContent("body")
  expect(body).not.toContain("undefined")
  expect(body).not.toContain("NaN")
  expect(body).not.toContain("€0.00")
})
```

Run locally:
```bash
npx playwright test tests/e2e/product-detail.spec.ts
npx playwright test --ui    # interactive mode with time-travel
npx playwright show-report  # after run, see failures with screenshots
```

Against production:
```bash
BASE_URL=https://www.phytomedic.de npx playwright test tests/e2e/
```

---

## The self-validation loop

Before opening a PR with ANY user-facing change:

```
[1] Implement the change
     ↓
[2] Load the affected page in browser (Mode A)
     ↓
[3] Walk through the flow exactly like a user would
     ↓
[4] Check:
    - Visual render OK? (screenshot)
    - Console has no errors? (console_messages)
    - No 404/500 network calls? (network_requests)
    - Data values sane? (no undefined/NaN/€0.00/placeholder text)
    - Links go where expected?
    - Forms accept valid input + reject invalid?
    - Loading states render, not just flash empty?
     ↓
[5] Any issue → back to [1] fix
     ↓
[6] All clean → write a scripted test (Mode B) if the flow is important
     ↓
[7] THEN open PR
```

**If Greptile or CI finds a bug that Mode A would have caught — you skipped this loop. Don't skip the loop.**

---

## Common checks for this project

### Cannabis product pages (`/medizin/produkte/[slug]`)
```
- Does the slug resolve (not 404)?
- Does the image load?
- Are THC/CBD values plausible (THC 0-35%, CBD 0-35%)?
- Does the price show with € symbol, not €0.00 or NaN?
- Does "In den Warenkorb" actually add to cart?
- Breadcrumbs correct?
- JSON-LD valid?
```

### Cart + checkout (`/medizin/produkte` → `/checkout`)
```
- Add product → cart count increments in header
- Cart page shows correct items, quantities, prices
- Sum in cart == sum in checkout == sum at Stripe
- Logged-out + add to cart + log in → cart SURVIVES (not empty)
- Checkout redirect after payment → www.phytomedic.de/checkout?step=success
  (NEVER localhost, NEVER the vercel preview URL on production)
```

### Strain pages (`/medizin/sorten/[slug]`)
```
- Lineage graph renders
- Parent/child nodes clickable → navigate to their detail pages
- Terpenes shown with actual percentages (not placeholder)
- Products-containing-this-strain section has at least 1 product
```

### Forms
```
- Email pre-filled for signed-in users (no redundant re-entry)
- Validation errors show inline, not just as toast
- Submit button disabled while submitting
- Success state shown after submit
- Required fields marked with *
```

---

## Data-integrity quick scan

Load any page and run this in Mode A `browser_evaluate`:

```js
() => {
  const body = document.body.innerText
  return {
    hasUndefined: /\bundefined\b/.test(body),
    hasNaN: /\bNaN\b/.test(body),
    hasZeroEur: /€\s*0[.,]00/.test(body),
    hasLorem: /lorem ipsum/i.test(body),
    hasPlaceholder: /placeholder|TODO|FIXME/i.test(body),
    has404Images: [...document.images].filter(img => !img.complete || img.naturalWidth === 0).map(img => img.src),
    consoleHasErrors: null, // use browser_console_messages instead
  }
}
```

ANY of those returning `true` or non-empty = bug to fix.

---

## Integration with pr-review-loop

This skill slots between "implement" and "push to branch" in the
`pr-review-loop/SKILL.md` workflow. Greptile catches code issues;
Playwright catches runtime/behavior issues.

---

*Single source of truth for browser testing in this agent.*
