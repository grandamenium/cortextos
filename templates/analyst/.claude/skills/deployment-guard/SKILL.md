---
name: deployment-guard
description: "Proactive CI/CD monitoring. Checks GitHub Actions and Vercel deployments for failures, auto-diagnoses type errors, attempts self-healing fixes, and alerts the user only when it cannot resolve the issue autonomously."
triggers: ["deployment failed", "build broken", "ci check", "vercel failed", "github actions", "build guard", "check deployments", "check ci"]
---

# Deployment Guard

> Proactive CI/CD watchdog. Run every 2 hours and on-demand.
> Goal: catch broken builds BEFORE the user sees them.

---

## Phase 0: Sync Local State

Before any checks, fetch latest remote state to avoid stale branch data:

```bash
cd <repo-root> && git fetch --prune origin 2>/dev/null
```

This prevents deployment-guard from referencing already-merged branches or
missing new commits pushed since the last session.

---

## Phase 1: Check for Failures

### GitHub Actions

```bash
gh run list --repo <org>/<repo> --limit 5 --json conclusion,name,headBranch,createdAt,url
```

Look for: `conclusion: "failure"` in the last 5 runs.

### Vercel Deployments

```bash
gh api repos/<org>/<repo>/deployments --jq '.[0:5] | .[] | {sha, state, environment, created_at}'
```

---

## Phase 2: Diagnose Failures

If a failure is found:

### 2A: Get the failure log

```bash
RUN_ID=<from phase 1>
gh run view $RUN_ID --repo <org>/<repo> --log-failed 2>&1 | tail -60
```

### 2B: Classify the error

| Error Type | Action |
|-----------|--------|
| TypeScript type error | Attempt auto-fix (Phase 3) |
| Missing dependency | Run `npm install` and push |
| Test failure | Diagnose, fix if clear, else escalate |
| Environment variable missing | Alert user (cannot self-fix) |
| Build timeout | Retry or alert |
| Rate limit / infra | Ignore, retry later |
| "repository not found" on Deploy Preview | Known GitHub token scope issue — not actionable, skip |

---

## Phase 3: Self-Healing (Type Errors)

### 3A: Run type check locally

```bash
cd <repo-root>
npx tsc --noEmit 2>&1 | head -30
```

### 3B: Fix and push

```bash
git add <fixed files>
git commit -m "fix: resolve TypeScript compilation error

<description>

Co-Authored-By: systems-analyst <noreply@cortextos.dev>"
git push origin <branch>
```

### 3C: Verify

Wait 2 minutes, then:
```bash
gh run list --repo <org>/<repo> --branch <branch> --limit 1 --json conclusion,status
```

---

## Phase 4: Escalation

If you CANNOT self-fix:

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Build failure on $BRANCH that I could not auto-fix:

$ERROR_SUMMARY

Repo: $REPO | Branch: $BRANCH | Run: $RUN_URL

Attempted: $WHAT_YOU_TRIED
Need: $WHAT_IS_REQUIRED"

cortextos bus send-message backend-architect high "Build failure on $BRANCH: $ERROR_SUMMARY. Please fix."
```

---

## Phase 4.5: integrations-routing Stale Check

Use a tighter threshold for integrations-routing (6h vs standard 8h) due to
its history of extended stale periods blocking checkout/Cannaleo integration:

```bash
cortextos bus read-all-heartbeats --format text 2>&1 | grep "integrations-routing"
```

If last seen > 6 hours ago, alert platform-director directly:

```bash
cortextos bus send-message platform-director high "integrations-routing stale >6h — last seen: <timestamp>. Checkout/Cannaleo integration blocked. Recommend restart."
cortextos bus log-event action agent_unresponsive warning --meta '{"agent":"integrations-routing","threshold_hours":6}'
```

---

## Phase 5: Log Results

```bash
cortextos bus log-event metric deployment_guard info --meta '{"repo":"<repo>","status":"<ok|fixed|escalated>","branch":"<branch>","error":"<type if any>"}'
cortextos bus update-heartbeat "deployment-guard: <status>"
```

---

## Phase 5.5: Unresolved PR Reviews (Greptile)

Check open PRs for unresolved P0/P1 Greptile findings:

```bash
gh pr list --repo <org>/<repo> --state open --json number,title,createdAt
```

For each PR, check if Greptile has reviewed:
```bash
gh pr view <n> --repo <org>/<repo> --json comments --jq '[.comments[] | select(.author.login == "greptile-apps")] | .[-1].body' | head -20
```

If unresolved P0/P1 findings, message the responsible agent:
```bash
cortextos bus send-message <agent> high "PR #<n> has unresolved P0/P1 Greptile findings. Please address before merge."
```

**Greptile re-review note:** Greptile reviews the HEAD at time of first push.
Fix commits pushed afterward are NOT automatically re-reviewed. If an agent
fixed a P1 after initial push, verify Greptile's last comment is dated AFTER
the fix commit before recommending merge.

---

## Phase 6: Stale Feature Branch Detection

```bash
for branch in $(git -C <repo-root> branch -r | grep -v HEAD | grep -v main); do
  ahead=$(git -C <repo-root> rev-list --count main..$branch 2>/dev/null || echo 0)
  if [ "$ahead" -gt 10 ]; then
    echo "$branch is $ahead commits ahead of main"
  fi
done
```

If a branch is >10 commits ahead, >2 days old, and CI succeeded: send the user
a Telegram summary and ask if they want it merged. NEVER auto-merge.

---

## Cron Schedule

- **Every 2 hours**: full check (Phase 0–6)
- **On inbox message mentioning "build" or "deploy"**: immediate check
