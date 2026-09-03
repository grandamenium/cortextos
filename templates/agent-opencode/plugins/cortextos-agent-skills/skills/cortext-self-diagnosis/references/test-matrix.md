# The User-Facing Test Matrix

A unit test proves the code does what you meant. It does not prove the bug is
gone — the bug lived in a running fleet with real timing, real messages, and real
state. The matrix closes that gap.

The user drives it and you observe. That split matters: they can trigger real
conditions you cannot fabricate, and you can read the surfaces they will not
think to check.

**Contents**
1. [Shape of the matrix](#1-shape-of-the-matrix)
2. [Writing a runnable test](#2-writing-a-runnable-test)
3. [Baseline: reproduce it first](#3-baseline-reproduce-it-first)
4. [Rebuild with the branch](#4-rebuild-with-the-branch)
5. [Verify and check for regressions](#5-verify-and-check-for-regressions)
6. [Observing without fooling yourself](#6-observing-without-fooling-yourself)
7. [Reporting results](#7-reporting-results)
8. [Template](#8-template)

---

## 1. Shape of the matrix

Four phases, in order. The order is what makes the result mean anything:

| Phase | Purpose | On the current build | On the fix branch |
|---|---|---|---|
| **A. Baseline** | Prove the bug is real and reproducible | Bug appears | — |
| **B. Rebuild** | Switch the running daemon to the branch | — | Clean build + restart |
| **C. Verification** | Prove the bug is gone | — | Bug does not appear |
| **D. Regression** | Prove nothing else broke | — | Normal behavior intact |

**Phase A is not optional, and skipping it is the most common way this goes
wrong.** If you never reproduced the bug on the current build, then "it doesn't
happen now" tells you nothing — the bug may be intermittent, or environmental, or
may have already been fixed by an unrelated change. Without a baseline you cannot
distinguish a working fix from a lucky run.

If Phase A cannot reproduce the bug, **stop and say so.** That is a real finding.
It usually means the trigger conditions are not yet understood, and shipping a fix
for a bug you cannot summon is guesswork. Go back to diagnosis.

---

## 2. Writing a runnable test

The user is running these by hand, possibly on a workday, on a system they depend
on. Write accordingly.

Each row needs:

- **Steps** — concrete and numbered. "Send opsbot a message on Telegram saying
  `status`" — not "trigger the message path".
- **Expected** — what a correct system does.
- **Actual** — left blank; filled in during the run.
- **What I'll watch** — the surfaces you will read to judge it.
- **Time** — roughly how long, including any waiting.

Rules that keep the matrix trustworthy:

**One variable per row.** A row that changes two things cannot tell you which one
mattered.

**Say when it is disruptive.** Restarts take the fleet down, including whatever
the user was in the middle of. Flag those rows clearly and let the user choose
the moment.

**Prefer non-destructive tests.** Do not ask someone to delete state or clear a
bus directory unless it is genuinely the only way, and if it is, have them back
it up first and say how to restore.

**Build in the wait.** Where the ten-minute post-restart settle applies, put it
in the matrix as its own step. Otherwise it gets skipped and the results become
noise.

**Keep it short enough to finish.** Cover the bug path and the things most likely
to break beside it. A twenty-row matrix does not get run.

---

## 3. Baseline: reproduce it first

On the **current build**, before any branch is involved.

```bash
cd ~/cortextos && git branch --show-current   # confirm which build is running
bash scripts/collect_evidence.sh --agent <name> --since 30m
```

Run the reproduction steps, then capture evidence immediately — some of it
rotates or gets overwritten.

Record precisely:

- Whether the bug appeared
- **How reliably** — every attempt, or two in five? Intermittent bugs need more
  Phase C runs before "gone" means anything
- The exact artifacts that show it: file, line, timestamp
- How long from trigger to symptom

Those artifacts are what you compare against later. Without them you are relying
on memory across a daemon restart that will wipe your context.

---

## 4. Rebuild with the branch

The disruptive phase. Warn the user first — the fleet goes down, their agents stop,
and your own session restarts.

```bash
cd ~/cortextos
git status                       # nothing uncommitted that would be lost
git checkout fix/<slug>
npm run build
npm run typecheck && npm test    # catch it here, not after the restart
pm2 restart cortextos-daemon
```

Confirm the running daemon is actually on the branch before continuing —
verifying a fix against the old build is an easy and embarrassing mistake:

```bash
git branch --show-current
pm2 describe cortextos-daemon | head -20
ls -l dist/daemon.js              # mtime should be from the build you just ran
```

Then **wait ten minutes.** Startup churn — reconnects, re-injections, heartbeat
noise — mimics many of the symptoms you are testing for. Do not begin Phase C
until the fleet has settled.

Have the rollback ready and tell the user what it is before you need it:

```bash
git checkout <previous-branch> && npm run build && pm2 restart cortextos-daemon
```

---

## 5. Verify and check for regressions

**Phase C** repeats Phase A exactly — same steps, same surfaces. Changing the
steps invalidates the comparison.

For an intermittent bug, run it as many times as it took to see it in Phase A,
plus a margin. If Phase A showed it two times in five, a single clean Phase C run
proves nothing.

**Phase D** checks the blast radius. The fix touched something; the question is
what else that something feeds. Cover, at minimum, whatever the changed code path
is adjacent to, plus the basics:

- Messages flow end to end (Telegram in, reply out)
- Agents restart cleanly and come back
- A cron fires on schedule
- No new errors in the daemon log
- Heartbeats current across the fleet

```bash
tail -100 ~/.pm2/logs/cortextos-daemon-error.log
pm2 list
```

A fix that resolves the bug and breaks something adjacent is not ready, and it is
much better to find that here than in review.

---

## 6. Observing without fooling yourself

You want the fix to work. That is precisely the problem — this is the point in
the process where motivated reasoning does the most damage, because the cost of
being wrong is a public PR.

Guard against it deliberately:

**Decide the pass criterion before the run**, not after. Write down what would
count as failure. "No errors in the log" is not a criterion; "no `ECONNREFUSED`
in fast-checker.log within 5 minutes of the message" is.

**Look for the failure, not the success.** Search for the original error
signature explicitly rather than scanning for a general feeling of health.

**Absence of the symptom is weaker evidence than presence was.** The bug not
appearing once is consistent with both "fixed" and "did not trigger". Say which
you can actually support.

**Report anything odd**, including things that seem unrelated. A new warning that
appeared only after the rebuild is worth mentioning even if you cannot connect it.

**If a result is ambiguous, it is ambiguous.** Say so and run it again. Rounding
a shaky result up to "passed" is how a bad fix reaches a maintainer.

---

## 7. Reporting results

Fill in the Actual column as you go and give the user a plain summary:

- What passed, what failed, what was ambiguous
- For anything intermittent: the count, not an adjective — "3 of 5" beats "mostly"
- Anything unexpected, including apparent irrelevancies
- Your honest read on whether this is PR-ready

If any Phase C row failed, the fix is not ready. Return to diagnosis. If Phase D
surfaced a regression, the fix needs narrowing or the approach is wrong.

Only a fully green matrix — with a baseline that genuinely reproduced the bug —
supports asking about a PR. Even then it is a request, not a green light; the
approval stop in `upstream-pr.md` §6 still applies.

---

## 8. Template

```markdown
# Test Matrix — <bug in one line>

Branch: `fix/<slug>`   Baseline build: `<branch/commit>`
Disruptive rows are marked ⚠ — they restart the fleet.

## Phase A — Baseline (current build)

| # | Steps | Expected (correct system) | Actual | Watching | Time |
|---|-------|---------------------------|--------|----------|------|
| A1 | 1. ... 2. ... | ... | | `logs/<agent>/stdout.log` | 2m |
| A2 | Repeat A1 ×5 (reliability) | Bug appears N/5 | | same | 10m |

Bug reproduced: ☐ yes ☐ no ☐ intermittent (__/5)
**If no — stop. Do not proceed to Phase B.**

## Phase B — Rebuild ⚠

| # | Steps | Expected | Actual | Time |
|---|-------|----------|--------|------|
| B1 | `git checkout fix/<slug> && npm run build` | Builds clean | | 2m |
| B2 | `npm run typecheck && npm test` | All pass | | 3m |
| B3 | ⚠ `pm2 restart cortextos-daemon` | Fleet restarts | | 1m |
| B4 | Confirm branch + `dist/` mtime | On fix branch | | 1m |
| B5 | Wait 10 minutes | Fleet settles | | 10m |

## Phase C — Verification

| # | Steps | Expected | Actual | Watching | Time |
|---|-------|----------|--------|----------|------|
| C1 | Repeat A1 exactly | Bug does NOT appear | | same as A1 | 2m |
| C2 | Repeat ×5 (match A2) | 0/5 | | same | 10m |

## Phase D — Regression

| # | Steps | Expected | Actual | Time |
|---|-------|----------|--------|------|
| D1 | Telegram message → reply | Normal round trip | | 2m |
| D2 | Restart one agent | Comes back clean, no re-onboard | | 3m |
| D3 | Wait for a scheduled cron | Fires on time | | varies |
| D4 | `tail ~/.pm2/logs/cortextos-daemon-error.log` | No new errors | | 1m |
| D5 | `pm2 list` + heartbeats | All online, current | | 1m |

## Result

Phase A reproduced: ___    Phase C clean: ___    Phase D clean: ___
Ambiguous or unexpected: ___
PR-ready: ☐ yes ☐ no — reasoning: ___

Rollback: `git checkout <prev> && npm run build && pm2 restart cortextos-daemon`
```
