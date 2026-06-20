---
name: pr-review-loop
description: "Iterative self-correction workflow: push PR → Greptile reviews → fix findings → push again → re-review → repeat until clean. Max 5 iterations before escalation. Covers Greptile bot + CI + human-review handling."
triggers: ["pr review loop", "greptile fix", "iterate pr", "address review findings", "self-test pr"]
---

# PR Self-Correction Loop

> The PR is not done when Greptile posts its first review. The PR is done
> when (CI green) AND (no unresolved P0/P1 Greptile findings) AND (human
> approved if required). This skill is the loop that gets you there.

---

## The Loop

```
[1] Push branch → open PR
     ↓
[2] Wait for Greptile (~2 min) + CI (~3 min)
     ↓
[3] Read all findings (Greptile + CI errors + human comments)
     ↓
[4] Any P0/P1 or CI failures?
     │
     ├─ NO  → Go to [7]
     │
     └─ YES → [5] Fix the findings in local branch
              ↓
              [6] Push fix commit(s) — Greptile auto re-reviews
              ↓
              Back to [2]
     ↓
[7] CI green, P0/P1 clean → [8] Merge or request human approval
```

**Critical:** steps [2]–[6] repeat. Not once. Until the PR is actually clean.

---

## Step-by-step

### [1] Push the branch

```bash
git checkout -b fix/<short-name>      # or feat/<name>
# make changes
npx tsc --noEmit                       # must pass locally
npm test                               # must pass locally
git push -u origin fix/<short-name>
PR_URL=$(gh pr create --title "..." --body "..." --repo syntasticstudios/phytomedic-saas)
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
```

### [2] Wait for review

```bash
# Poll for Greptile review (max 5 min)
for i in {1..10}; do
  count=$(gh pr view $PR_NUMBER --repo syntasticstudios/phytomedic-saas \
    --json comments --jq '[.comments[] | select(.author.login | startswith("greptile"))] | length')
  [ "$count" -gt 0 ] && break
  sleep 30
done

# Wait for CI to complete
gh pr checks $PR_NUMBER --repo syntasticstudios/phytomedic-saas --watch
```

### [3] Read findings

```bash
# Greptile findings with severity
gh pr view $PR_NUMBER --repo syntasticstudios/phytomedic-saas \
  --json comments --jq '.comments[] | select(.author.login | startswith("greptile")) | .body'

# CI failures (if any)
gh pr checks $PR_NUMBER --repo syntasticstudios/phytomedic-saas \
  --json name,state --jq '.[] | select(.state != "SUCCESS")'
```

Parse priorities:
- **P0** = security / data loss / crash — MUST fix
- **P1** = correctness / logic bug — MUST fix
- **P2** = quality / best practice — fix unless there's a clear reason
- **P3** = nitpick / style — optional, skip if tight on time
- **CI failure** = MUST fix (compilation, tests, lint errors)

### [4] Decide

- All CI green + no P0/P1 findings? → skip to [7]
- Otherwise → continue to [5]

### [5] Fix findings

Address each blocker in your local branch:
```bash
# make the fixes
npx tsc --noEmit                       # verify clean
npm test
```

**Never dismiss a P0/P1 without a very good reason.** If you disagree with
Greptile, reply to the comment explaining why — don't just ignore it:
```bash
gh pr comment $PR_NUMBER --repo syntasticstudios/phytomedic-saas \
  --body "Re: P1 finding on X — this is actually intentional because <reason>. Keeping current behavior."
```

### [6] Push fix, loop back

```bash
git add -A
git commit -m "fix: address greptile P1 finding on <thing>"
git push
```

Greptile **automatically re-reviews** on every new push (typically within
1–2 min). CI also reruns. Go back to [2].

### [7] Merge

Only when:
- All CI checks green ✅
- No unresolved P0/P1 findings ✅
- If the change touches security/deployment/financial logic: human approval ✅

```bash
gh pr merge $PR_NUMBER --repo syntasticstudios/phytomedic-saas --squash --delete-branch
```

---

## Iteration Budget

**Max 5 iterations (loop [2]→[6]) per PR.**

If after 5 iterations Greptile is still finding P0/P1 issues, the change
is probably too big or too complex. Escalate:

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID \
  "⚠️ PR #$PR_NUMBER needs human review. After 5 iterations, still has unresolved findings:
$(gh pr view $PR_NUMBER --repo syntasticstudios/phytomedic-saas --json comments --jq '.comments[-3:] | .[].body')

Consider splitting into smaller PRs."
```

Also log the stuck state:
```bash
cortextos bus log-event metric pr_iteration_exhausted warning \
  --meta "{\"pr\":$PR_NUMBER,\"iterations\":5}"
```

---

## Anti-Patterns (don't do these)

| Anti-Pattern | Why it's wrong |
|--------------|----------------|
| Merge after first Greptile review regardless of findings | Findings are there for a reason |
| Fix one P1 and leave others, merge anyway | All P0/P1 must be clean before merge |
| Push the fix but skip waiting for re-review | Your fix might introduce new issues |
| Mark P2/P3 as "ignore" without reading | At least read them — they're often quick wins |
| Reply to Greptile with "wont fix" but don't explain | Leaves the reviewer (human or next agent) confused |
| Merge while CI is still running | CI exists to catch what Greptile doesn't |

---

## Example: real iteration cycle

```
Iteration 1:
  Push "fix(header): replace SignedIn with useAuth"
  Greptile: "P2: Loading state not handled — flash of unauth UI"
  CI: green
  → fix with isLoaded guard, push

Iteration 2:
  Greptile: "Looks good, no new findings"
  CI: green
  → merge
```

Two iterations is typical for a small fix. Three for a medium feature.
If you hit 5+, something is wrong with the approach — escalate.

---

## Integration with deployment-guard

After a PR is merged, systems-analyst's deployment-guard cron (2h)
verifies the deploy succeeded. If the deploy fails on `main` after merge:
- Revert the merge or forward-fix via a new PR
- Never leave `main` broken overnight

---

*This skill is the single source of truth for iterative PR review handling.*
