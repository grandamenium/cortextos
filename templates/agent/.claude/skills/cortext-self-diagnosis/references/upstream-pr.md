# Upstream Fix and PR

For confirmed framework bugs only — the classification gate in SKILL.md Phase 4
must have passed. If you are not certain, you are not ready for this file.

The output is a PR a maintainer who has never seen your machine can evaluate in a
few minutes: one bug, one fix, a test that fails without it, and a reproduction
they can follow. Everything here serves that.

**Contents**
1. [Before you start](#1-before-you-start)
2. [Branch from upstream main](#2-branch-from-upstream-main)
3. [Write the fix](#3-write-the-fix)
4. [Verify locally](#4-verify-locally)
5. [The PII and focus gate](#5-the-pii-and-focus-gate)
6. [The approval stop](#6-the-approval-stop)
7. [Push and open the PR](#7-push-and-open-the-pr)
8. [PR body template](#8-pr-body-template)

---

## 1. Before you start

Confirm with the user that a PR is what they want. A correct diagnosis does not
obligate anyone to upstream a fix — they may prefer a local patch, or to file an
issue, or to leave it. Ask.

Check whether it is already known before writing anything:

```bash
cd ~/cortextos
git fetch upstream
git log upstream/main --oneline -20
gh issue list --repo grandamenium/cortextos --search "<keywords>" --limit 10
gh pr list  --repo grandamenium/cortextos --search "<keywords>" --limit 10
```

If it is fixed on `upstream/main` already, the answer is "update", not "patch" —
and that is a much better outcome for the user. Report it and stop.

---

## 2. Branch from upstream main

Branch from `upstream/main`, never from whatever the local checkout happens to be
sitting on. Local branches carry unrelated work, and a PR that drags it along is
usually rejected on sight.

```bash
cd ~/cortextos
git status                       # stash or commit anything in progress first
git fetch upstream
git checkout -b fix/<short-slug> upstream/main
```

Name the branch for the bug, not the mechanism: `fix/fast-checker-stops-polling`
rather than `fix/add-null-check`.

**If the working tree is dirty, stop and ask.** Local uncommitted changes may be
the user's own work, and quietly stashing someone's in-progress edits is a bad
surprise. Confirm what to do with them.

Note this checkout has an `upstream` remote and typically no fork remote — the
push target is discussed in §7, and it is a decision for the user, not for you.

---

## 3. Write the fix

**Narrow beats clever.** The fix should address the root cause you evidenced and
nothing else. Every extra file lowers the odds of the PR being merged and raises
the review burden.

Things that belong in the diff:

- The minimal change that fixes the cause
- A regression test that fails before the fix and passes after
- A comment where the reasoning is non-obvious

Things that do not, however tempting:

- Unrelated refactors, formatting, or import reordering
- Drive-by fixes for other bugs you noticed — file those separately
- Config, personal paths, or anything specific to this install
- Version bumps, changelog edits, or dependency changes unless the fix requires them

Match the surrounding code. The repo is TypeScript strict, has no external runtime
dependencies beyond `package.json`, uses atomic writes via `src/utils/atomic.ts`
for file operations, and routes bus operations through `src/bus/`. Follow those
conventions rather than importing new ones.

**Write the regression test first if you can.** A test that fails for the right
reason before you touch the source is the strongest evidence you have understood
the bug — and it is what a reviewer will look for first. Add it under `tests/`
alongside similar cases.

---

## 4. Verify locally

```bash
npm run build      # tsup — must compile clean
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

All three must pass. A PR that does not build wastes everyone's time.

Then confirm the fix against the **real symptom**, not just the unit test. Rebuild
the daemon with the branch and watch the surface where the bug originally showed:

```bash
npm run build
pm2 restart cortextos-daemon
```

That restart takes the fleet — including your own session — down and back up.
**Tell the user before you do it.** You may drop mid-sentence.

Then wait **ten minutes** before judging the result. Startup produces a burst of
reconnects, re-injections, and heartbeat churn that closely resembles the original
symptom. Reading that burst as failure (or as success) is the single easiest way
to reach a wrong conclusion here.

The user-facing verification is a separate, more rigorous step — see
`test-matrix.md`. Build the matrix, have the user run it, and observe honestly.
A fix that passes your unit test but not the user's reproduction is not a fix.

---

## 5. The PII and focus gate

Everything so far was local. This is the last checkpoint before anything becomes
public and permanent — a merged PR is not retractable in any meaningful sense.

Run the scanner over the diff:

```bash
python3 scripts/pr_gate.py --base upstream/main
```

It flags, with file and line:

| Category | Examples |
|---|---|
| Absolute/home paths | `/Users/<name>/...`, `C:\Users\...`, `~/Projects/...` |
| Personal identifiers | emails, real names, usernames, phone numbers |
| Service identifiers | Telegram chat/user IDs, bot tokens, webhook URLs |
| Secrets | API keys, tokens, credentials, `.env` content |
| Machine specifics | hostnames, LAN/Tailscale IPs, local ports |
| Org/business data | agent names tied to a real business, customer data, revenue |
| Focus violations | unrelated files, lockfiles, build output, editor config |

**The scanner is a floor, not a ceiling.** It catches patterns; it cannot tell
that an agent name is your company's, that a test fixture quotes a real customer,
or that a comment mentions an internal project. Read the diff yourself:

```bash
git diff upstream/main --stat
git diff upstream/main
```

Read every line as a stranger would. The specific question is not "is this
sensitive?" but **"does this reveal anything about the person or machine it came
from?"** Anything install-specific gets replaced with a neutral placeholder or a
generic fixture value.

If the scanner flags something you believe is a false positive, say so explicitly
to the user with your reasoning rather than silently overriding it. Suppressing a
gate finding is exactly the kind of judgment that should be visible.

---

## 6. The approval stop

**Stop here. Do not push. Do not open a PR.**

A green test matrix and a clean gate are what make it reasonable to *ask* — they
are not permission. Nothing leaves this machine without the user approving that
specific action.

Present, compactly:

```
Bug:         one sentence
Evidence:    the log lines / artifacts that proved it
Root cause:  the code path and why it is wrong
Fix:         what changed, in which files, and why this approach
Tests:       regression test added; build/typecheck/test status
Matrix:      what the user ran and what was observed
Gate:        scanner result + what you found reading it yourself
Risk:        what this could affect; how to revert
```

Then ask plainly whether to push and open the PR. Two things to surface honestly
because they are easy to gloss over:

- **Anything the gate flagged that you judged acceptable**, and your reasoning
- **Anything you are unsure about** — an untested edge case, an assumption about
  intent, a test you could not run

If the user has not explicitly approved, the correct action is to wait. Not to
push "just the branch". Pushing to a fork is still publishing.

---

## 7. Push and open the PR

Only after explicit approval.

This checkout typically has only an `upstream` remote and no fork. Do not create
a fork or add a remote on your own initiative — ask which the user wants:

```bash
git remote -v
```

Once the target is agreed:

```bash
git push <remote> fix/<short-slug>
gh pr create --repo grandamenium/cortextos --base main \
  --title "fix: <what the bug was>" \
  --body-file <path-to-body>
```

Report the PR URL back. Then stop — do not merge, do not respond to review
comments, and do not push follow-ups without checking in first.

---

## 8. PR body template

Written for a maintainer with no access to your machine, no knowledge of your
setup, and limited time.

```markdown
## What's wrong

One or two sentences. The user-visible symptom, then the underlying cause.

## Root cause

The code path and why it misbehaves. Reference files as `src/path/file.ts:123`.
Explain the conditions that trigger it — a reviewer should be able to see why
this was not caught before.

## Reproduction

1. Numbered steps against a clean install
2. No paths, names, or values specific to one machine
3. Expected: ...
4. Actual: ...

## The fix

What changed and why this approach. Note alternatives you rejected and the
reason — that is often the most useful paragraph for a reviewer.

## Testing

- Regression test added: `tests/<file>` — fails before, passes after
- `npm run build`, `npm run typecheck`, `npm test` all pass
- Verified against a live daemon: <what was observed>

## Risk

What this touches and what could regress. How to revert.
```

Keep it factual. Do not describe the debugging journey, do not mention the user's
setup, and do not speculate about unrelated improvements. The reviewer needs the
bug, the cause, the fix, and the evidence — in that order.
