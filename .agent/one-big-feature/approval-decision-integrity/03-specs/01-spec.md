# Spec 01 — approval-decision-integrity

## Josh's exact request (verbatim)
"Fix them" — the 70 verified Fable-hunt bugs. This spec is cluster C3 (2 HIGH, security):
the plan-approval hook fails OPEN so a user DENY can become ALLOW.

## Change 1 — atomic decision-file writes (root cause)
**File:** `src/daemon/fast-checker.ts`

At line ~787 (the `perm_(allow|deny|continue)` callback handler) and line ~805 (the
`restart_(allow|deny)` handler), the code currently does:
```ts
writeFileSync(responseFile, JSON.stringify({ decision: hookDecision }) + '\n', 'utf-8');
```
and
```ts
writeFileSync(responseFile, JSON.stringify({ decision }) + '\n', 'utf-8');
```

Replace BOTH with the atomic writer so a concurrent hook reader can never observe a torn/empty file:
```ts
atomicWriteSync(responseFile, JSON.stringify({ decision: hookDecision }));
```
```ts
atomicWriteSync(responseFile, JSON.stringify({ decision }));
```
- Import `atomicWriteSync` from `../utils/atomic` (adjust relative path to match existing imports).
- Drop the manual `+ '\n'` — `atomicWriteSync` appends its own newline.
- Do not change any other write in this file.

## Change 2 — plan-review consumer fails CLOSED on unreadable decision (defense)
**File:** `src/hooks/hook-planmode-telegram.ts`, lines ~117-128

Current:
```ts
if (content !== null) {
  try {
    const response = JSON.parse(content);
    const decision = response.decision || 'deny';
    if (decision === 'allow') {
      outputDecision('allow');
    } else {
      outputDecision('deny', 'Plan denied by user via Telegram. Ask what they want to change.');
    }
  } catch {
    outputDecision('allow');            // <-- BUG: torn/empty real DENY becomes ALLOW
  }
} else {
  // Timeout - auto-APPROVE ... (LEAVE UNCHANGED)
  ...
  outputDecision('allow');
}
```

Change ONLY the `catch` at lines 127-128 to fail closed:
```ts
  } catch {
    outputDecision('deny', 'Plan approval response was unreadable — denying for safety. Re-plan.');
  }
```

**Do NOT touch:**
- the `content === null` timeout branch (must stay `allow` — deliberate anti-wedge),
- the send-failure `catch` (must stay `allow`),
- the top-level `main().catch` (must stay `allow`).
Only the parse-failure of a *present* decision file changes from allow → deny.

## Change 3 — unit test (new file, MANDATORY fail-first)
**File:** `tests/unit/hooks/hook-planmode-telegram.test.ts`

Test the plan-review decision resolution. Structure it so the decision logic is exercised against a
response-file value without needing real Telegram. If the decision resolution is currently inlined in
`main()`, extract a small pure helper (e.g. `resolvePlanDecision(content: string | null): {decision:
'allow'|'deny'; reason?: string}`) in `hook-planmode-telegram.ts`, wire `main()` to call it, and unit
test the helper. Keep the extraction minimal and behavior-preserving.

Cases:
| input                              | expected |
|------------------------------------|----------|
| `'{"decision":"allow"}'`           | allow    |
| `'{"decision":"deny"}'`            | deny     |
| `''` (empty — torn write)          | **deny** |
| `'{"decision":'` (partial JSON)    | **deny** |
| `null` (genuine timeout)           | allow    |

The two bolded cases are the fail-first: they emit `allow` on clean main and must emit `deny` on the
branch. Include a comment noting the corrupt-file cases are the regression guard for the DENY→ALLOW flip.

## Acceptance
- `npm run build` clean; `npm test` green (all, not just the new file).
- New test FAILS on clean main (the corrupt/empty cases return allow), PASSES on branch.
- No `any`, no `console.log`. No change to permission-hook, timeout, or send-fail behavior.
- Diff limited to the three files above.
