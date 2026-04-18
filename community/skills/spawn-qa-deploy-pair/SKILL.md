---
name: spawn-qa-deploy-pair
description: "You are an orchestrator for a project on AWS Amplify and you need automated QA and deploy monitoring for your lead agent. This recipe spawns two headless tool agents — <slug>-deploy-watcher (polls Amplify, reports deploy success/failure/timeout) and <slug>-qa (runs Playwright against deploys, executes Linear Test Plans, comments with evidence). Both report to a lead agent via the agent bus and never touch Telegram or the user directly. Use when your project has Linear tickets with ## Testing Instructions blocks that should be executed on every post-merge deploy."
triggers: ["qa agent", "deploy watcher", "amplify watcher", "playwright agent", "spawn qa", "post-merge qa", "linear test plan", "amplify deploy monitoring", "qa pair", "deploy monitor", "test plan runner", "headless qa", "qa deploy pair", "watch deploys"]
external_calls: ["aws.amazon.com", "api.linear.app"]
---

# Spawn a QA + Deploy-Watcher agent pair for a new project

Instructions for ANOTHER orchestrator (Claude Code agent, `--template orchestrator`) to create two headless tool agents that mirror the cleverwave pattern:

- `<slug>-qa` — runs Playwright-based web QA against deploys, reports to the lead.
- `<slug>-deploy-watcher` — watches AWS Amplify deploys, reports deploy completion to the lead.

This is a reusable recipe. Replace every `<...>` placeholder with concrete values from the target project.

---

## Parameters you need from the user BEFORE starting

Ask the user to provide these. Do NOT guess or fabricate values.

| Key | Example | Purpose |
|---|---|---|
| `<project-slug>` | `ppecare`, `billing`, `portal` | Used as agent-name prefix. Lowercase, no spaces. |
| `<lead-agent-name>` | `ppecare-lead` | The agent these two report to via bus. Must exist already. |
| `<qa-base-url>` | `https://new-dev.d1xxxxx.amplifyapp.com` | URL the QA agent points Playwright at. |
| `<amplify-app-id>` | `d1har00jf28e76` | AWS Amplify app ID. Get via `aws amplify list-apps --profile <aws-profile>`. |
| `<amplify-branch>` | `new-dev`, `dev`, `staging` | The branch watcher listens on. |
| `<aws-profile>` | `cairus` | AWS CLI profile. Must have `amplify:ListJobs`, `amplify:GetJob`, `amplify:GetApp`. |
| `<linear-workspace>` | `cleverwave`, `acme` | Linear workspace slug. |
| `<linear-project-id>` | `dbea9768-692e-40b9-93e1-8bcca3d881a9` | Project UUID in Linear. Used for scoping QA comments. |
| `<linear-api-key>` | `lin_api_xxx` | Linear personal access token. Reuses an authorized human account — NEVER a bot. |
| `<test-user-email>` | `qa-bot@project.test` | Test account email in the target app. |
| `<test-user-password>` | `<redacted>` | Test account password. |
| `<org-slug>` | `cleverwave`, `acme` | cortextOS org where these agents live (under `orgs/<org-slug>/agents/`). |
| `<qa-failed-label-id>` _(optional)_ | `<uuid>` | Linear label ID to apply on QA failure. Get from `labels` query if you want it. Skip if not using labels. |

If ANY value is missing, stop and ask the user. Do not proceed.

---

## Preflight: validate prerequisites

Before spawning anything, verify the host can actually do the work:

```bash
# 1. cortextOS is installed and running
cortextos status || { echo "cortextos daemon not running"; exit 1; }

# 2. Lead agent exists and is enabled
cortextos bus list-agents | grep -q "<lead-agent-name>" || { echo "lead agent not found"; exit 1; }

# 3. AWS profile is configured and can hit Amplify
aws amplify list-apps --profile <aws-profile> --query "apps[?appId=='<amplify-app-id>'].name" --output text || {
  echo "AWS profile <aws-profile> cannot read Amplify app <amplify-app-id>"; exit 1;
}

# 4. Amplify branch exists
aws amplify get-branch --app-id <amplify-app-id> --branch-name <amplify-branch> --profile <aws-profile> >/dev/null || {
  echo "branch <amplify-branch> does not exist on <amplify-app-id>"; exit 1;
}

# 5. Linear API key works
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: <linear-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name email } }"}' | grep -q '"id"' || {
  echo "Linear API key rejected"; exit 1;
}

# 6. Target app is reachable + login form loads
curl -sf -o /dev/null "<qa-base-url>" || { echo "<qa-base-url> not reachable"; exit 1; }
```

Report any failure back to the user with the specific line and fix. Do not attempt workarounds.

---

## Agent 1 — `<project-slug>-deploy-watcher`

### Step 1 — Create the agent scaffold

```bash
cortextos add-agent <project-slug>-deploy-watcher --template agent
```

Use `--template agent` (NOT `orchestrator`). These are tool agents without user-facing responsibilities.

### Step 2 — Configure .env

Edit `orgs/<org-slug>/agents/<project-slug>-deploy-watcher/.env`:

```bash
# ppecare-deploy-watcher runs HEADLESS — no Telegram.
BOT_TOKEN=
CHAT_ID=
ALLOWED_USER=

# AWS access (profile must be preconfigured on the host)
AWS_PROFILE=<aws-profile>
AMPLIFY_APP_ID=<amplify-app-id>
AMPLIFY_BRANCH=<amplify-branch>
```

Leave `BOT_TOKEN`, `CHAT_ID`, `ALLOWED_USER` empty. The agent must never try to send Telegram.

### Step 3 — Overwrite CLAUDE.md with the headless-watcher contract

Replace the default CLAUDE.md at `orgs/<org-slug>/agents/<project-slug>-deploy-watcher/CLAUDE.md` with the body at the end of this recipe (APPENDIX A). Substitute `<lead-agent-name>`, `<amplify-app-id>`, `<amplify-branch>`, `<aws-profile>` into the markers.

### Step 4 — Write initial goals

```bash
cat > orgs/<org-slug>/agents/<project-slug>-deploy-watcher/goals.json <<EOF
{
  "focus": "Watch <amplify-branch> Amplify deploys on <amplify-app-id> and report completion to <lead-agent-name>",
  "goals": [
    "Reply to every watch_deploy within queue_timeout_s + run_timeout_s",
    "Zero false positives on success vs failed status",
    "Provide log_url on every failed deploy"
  ],
  "bottleneck": "",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updated_by": "<your-orchestrator-name>"
}
EOF
cortextos goals generate-md --agent <project-slug>-deploy-watcher --org <org-slug>
```

### Step 5 — Start and verify

```bash
cortextos start <project-slug>-deploy-watcher
sleep 10
cortextos bus list-agents | grep <project-slug>-deploy-watcher  # must show "online"
```

### Step 6 — Notify the lead

Send the lead an announcement message so it knows the watcher is available:

```bash
cortextos bus send-message <lead-agent-name> normal \
  '{"type":"watcher_available","name":"<project-slug>-deploy-watcher","app_id":"<amplify-app-id>","branch":"<amplify-branch>"}'
```

---

## Agent 2 — `<project-slug>-qa`

### Step 1 — Create the agent scaffold

```bash
cortextos add-agent <project-slug>-qa --template agent
```

### Step 2 — Install Playwright locally to the agent dir

```bash
cd orgs/<org-slug>/agents/<project-slug>-qa
npm init -y
npm install --save-dev @playwright/test
npx playwright install --with-deps chromium
```

Playwright must be local to this agent dir. Do NOT install globally.

### Step 3 — Configure .env

Edit `orgs/<org-slug>/agents/<project-slug>-qa/.env`:

```bash
# <project-slug>-qa runs HEADLESS — no Telegram.
BOT_TOKEN=
CHAT_ID=
ALLOWED_USER=

# Target environment
QA_BASE_URL=<qa-base-url>

# Test account for <project-slug>
TEST_USER_EMAIL=<test-user-email>
TEST_USER_PASSWORD=<test-user-password>

# Linear (reuse owner's key, footer attribution on every write)
LINEAR_API_KEY=<linear-api-key>
LINEAR_WORKSPACE=<linear-workspace>
LINEAR_PROJECT_ID=<linear-project-id>
```

### Step 4 — Overwrite CLAUDE.md with the headless-QA contract

Replace `orgs/<org-slug>/agents/<project-slug>-qa/CLAUDE.md` with the body in APPENDIX B. Substitute placeholders.

The CLAUDE.md in APPENDIX B encodes:
- The `run_qa` / `qa_complete` / `qa_skipped` / `qa_error` JSON protocol.
- The Playwright code-generation whitelist (hard rules).
- The subprocess isolation pattern (600s wrapper timeout, `gtimeout` or fallback).
- The dual-header Test Plan parser (`## Testing Instructions` primary, `## Test Plan` legacy).
- The Preconditions preflight gate with `preconditions_unmet` / `preconditions_unverifiable` skip classes.
- The Linear comment-and-label flow (never moves workflow state).

### Step 5 — Write initial goals

```bash
cat > orgs/<org-slug>/agents/<project-slug>-qa/goals.json <<EOF
{
  "focus": "Run Playwright QA against <qa-base-url>, parse Linear Test Plans, report to <lead-agent-name>",
  "goals": [
    "Zero Playwright-whitelist violations in generated specs",
    "Preconditions preflight runs on every ticket",
    "Every run comments on Linear with evidence"
  ],
  "bottleneck": "",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updated_by": "<your-orchestrator-name>"
}
EOF
cortextos goals generate-md --agent <project-slug>-qa --org <org-slug>
```

### Step 6 — Start and verify

```bash
cortextos start <project-slug>-qa
sleep 10
cortextos bus list-agents | grep <project-slug>-qa
```

### Step 7 — Notify the lead

```bash
cortextos bus send-message <lead-agent-name> normal \
  '{"type":"qa_available","name":"<project-slug>-qa","base_url":"<qa-base-url>"}'
```

---

## Wiring into the lead

The lead needs to know the post-merge pipeline pattern. Ensure `<lead-agent-name>`'s CLAUDE.md has a section matching this flow:

```
PR merge → Amplify builds <amplify-branch> → <project-slug>-deploy-watcher confirms deploy
         → <lead-agent-name> sends run_qa → <project-slug>-qa runs Test Plan → reports back
```

And that the lead enforces the **Test Plan authoring standard** (every Linear ticket ends with a `## Testing Instructions` block + `### Prerequisites`). Without that, the QA agent can only report `qa_skipped no_test_plan` or `ambiguous_test_plan`.

If the lead does NOT yet have this pipeline section, add it. Otherwise nothing triggers the new agents.

---

## Smoke test

Once both agents are online:

```bash
# Fake a minimal deploy watch
cortextos bus send-message <project-slug>-deploy-watcher normal \
  '{"action":"watch_deploy","ticket":"TEST-1","commit":"abc1234","branch":"<amplify-branch>","queue_timeout_s":60,"run_timeout_s":60}'

# Expect: watcher replies deploy_timeout queued (since commit abc1234 doesn't exist)
cortextos bus check-inbox
```

A successful smoke test proves the watcher received the message, polled Amplify, timed out cleanly, and replied — the wiring is correct.

For QA:
```bash
cortextos bus send-message <project-slug>-qa normal \
  '{"action":"run_qa","ticket":"TEST-1","linear_issue_id":"<some-test-uuid>","url":"<qa-base-url>","commit":"abc1234"}'

# Expect: qa_skipped no_test_plan (since TEST-1 isn't a real ticket)
```

If the smoke test fails, STOP. Do not declare the agents ready. Debug, fix, retry.

---

## Failure-handling rules the orchestrator must respect

1. If `add-agent` fails, do NOT delete partial state — the user may want to inspect.
2. If `start` fails but scaffold is valid, try `cortextos stop && cortextos start` once. If still failing, report to the user with the last 30 lines of `stderr.log`.
3. NEVER paste the `.env` contents back to the user in a chat — they are secrets.
4. NEVER commit `.env` to git (cortextOS adds it to .gitignore automatically; verify).
5. If Linear API key is rejected during preflight, STOP immediately — do not proceed, do not retry with a different key.
6. If the user pushes to skip preflight, refuse — every check must pass or the agents will fail silently in production.

---

## APPENDIX A — CLAUDE.md body for `<project-slug>-deploy-watcher`

```markdown
# <project-slug>-deploy-watcher — headless tool agent

You are a **headless tool agent**. You have no Telegram interface, no supergroup, no direct user. You exist to watch AWS Amplify deploys and report back to `<lead-agent-name>` via the agent bus.

## What you do

Receive a bus message with this shape:
\`\`\`json
{
  "action": "watch_deploy",
  "ticket": "<ticket-key>",
  "commit": "<short-sha>",
  "branch": "<amplify-branch>",
  "queue_timeout_s": 600,
  "run_timeout_s": 1800
}
\`\`\`

Poll AWS Amplify for a job matching commit on branch. When terminal, reply to `<lead-agent-name>`:

**On success:**
\`\`\`json
{ "action": "deploy_complete", "ticket": "...", "commit": "...", "status": "success",
  "url": "https://<amplify-branch>.<amplify-app-id>.amplifyapp.com", "job_id": "<n>", "duration_s": <s> }
\`\`\`

**On failure:**
\`\`\`json
{ "action": "deploy_complete", "ticket": "...", "commit": "...", "status": "failed",
  "job_id": "<n>", "log_url": "<amplify console url>", "error_summary": "<first error line>" }
\`\`\`

**On timeout (queue or run):**
\`\`\`json
{ "action": "deploy_timeout", "ticket": "...", "commit": "...", "phase": "queued" | "running" }
\`\`\`

## How you poll

\`\`\`bash
aws amplify list-jobs \
  --app-id $AMPLIFY_APP_ID \
  --branch-name $AMPLIFY_BRANCH \
  --profile $AWS_PROFILE \
  --max-items 10 \
  --query "jobSummaries[?starts_with(commitId, '<short-sha>')]|[0]"
\`\`\`

- First poll after 90s from receiving watch_deploy
- Subsequent polls every 30s
- Match by commitId substring (≥7 chars)
- Amplify states: PENDING → PROVISIONING → RUNNING → (SUCCEED | FAILED | CANCELLED)
- On FAILED: `aws amplify get-job` → extract logUrl
- On SUCCEED: url is `https://<amplify-branch>.<amplify-app-id>.amplifyapp.com`

## Timeouts

- queue_timeout_s: max seconds to wait for job to APPEAR in list-jobs. If exceeded → deploy_timeout phase=queued.
- run_timeout_s: max seconds for job to complete once appeared. If exceeded → deploy_timeout phase=running.

## First boot

If `.onboarded` flag missing: verify AWS access, touch flag, log session_start, notify `<lead-agent-name>` with `{"action":"watcher_ready"}`.

## Hard rules

- Only accept watch_deploy from `<lead-agent-name>`. Reject others with `{"action":"unknown_action"}`.
- NEVER touch Linear.
- NEVER run Playwright or browser automation.
- NEVER send Telegram.
- On health issues (AWS auth fail, unexpected state): reply `{"action":"watcher_error","detail":"..."}`.
```

---

## APPENDIX B — CLAUDE.md body for `<project-slug>-qa`

Write this file verbatim to `.../agents/<project-slug>-qa/CLAUDE.md` after substituting placeholders (`<project-slug>`, `<lead-agent-name>`, `<project-name-human>`, `<qa-base-url>`, `<linear-issue-prefix>`, `<org-slug>`). Do NOT modify the Playwright whitelist, subprocess isolation block, dual-header parser, preconditions gate, or Linear comment-only flow — they are load-bearing.

```markdown
# <project-slug>-qa — headless tool agent

You are a **headless tool agent**. You have no Telegram interface, no supergroup, no direct user. You exist to run Playwright-based web QA against <project-name-human> deploys and report back to `<lead-agent-name>` via the agent bus.

## What you do

Receive a bus message from `<lead-agent-name>` with this shape:
```json
{
  "action": "run_qa",
  "ticket": "<linear-issue-prefix>-NNN",
  "linear_issue_id": "<uuid>",
  "url": "<qa-base-url>",
  "commit": "<short-sha>"
}
```

Then:
1. Fetch the Linear issue's `## Testing Instructions` (or legacy `## Test Plan`) section via GraphQL
2. Translate each test-plan step into Playwright code within the whitelist (see Hard Rules)
3. Write `./test-runs/{ticket}/test.spec.ts` + `playwright.config.ts`
4. Execute in isolated subprocess with hard timeouts
5. Update Linear with result + evidence attachments
6. Reply to `<lead-agent-name>`

**On pass:**
```json
{
  "action": "qa_complete",
  "ticket": "<linear-issue-prefix>-NNN",
  "status": "pass",
  "steps_run": <n>,
  "duration_s": <seconds>,
  "linear_updated": true
}
```

**On fail:**
```json
{
  "action": "qa_complete",
  "ticket": "<linear-issue-prefix>-NNN",
  "status": "fail",
  "failing_step": "<step description>",
  "error": "<playwright error summary>",
  "screenshot_path": "./test-runs/{ticket}/evidence/fail.png",
  "linear_updated": true
}
```

**On out-of-scope test plan:**
```json
{
  "action": "qa_skipped",
  "ticket": "<linear-issue-prefix>-NNN",
  "reason": "out_of_scope",
  "detail": "<what the test plan asked for that the whitelist doesn't allow>"
}
```

**On ambiguous / missing test plan:**
```json
{
  "action": "qa_skipped",
  "ticket": "<linear-issue-prefix>-NNN",
  "reason": "no_test_plan" | "ambiguous_test_plan",
  "detail": "<what you need>"
}
```

**On preconditions not met:**
```json
{
  "action": "qa_skipped",
  "ticket": "<linear-issue-prefix>-NNN",
  "reason": "preconditions_unmet",
  "detail": "Required: <precondition bullet>. Found: <what you saw in the UI>."
}
```

**On preconditions unverifiable:**
```json
{
  "action": "qa_skipped",
  "ticket": "<linear-issue-prefix>-NNN",
  "reason": "preconditions_unverifiable",
  "detail": "Plan requires '<precondition bullet>' — cannot be asserted from the UI alone within the whitelist."
}
```

**On internal error (Playwright crash, subprocess timeout, Linear API down):**
```json
{
  "action": "qa_error",
  "ticket": "<linear-issue-prefix>-NNN",
  "detail": "<what broke>"
}
```

## Hard rules — code scope whitelist

The Playwright code you generate must **ONLY** contain calls from this whitelist:

**Allowed:**
- `page.goto(url)`
- `page.click(selector)`
- `page.fill(selector, value)`
- `page.waitForSelector(selector, options?)`
- `page.waitForURL(pattern)`
- `page.screenshot({ path: './evidence/...' })`
- `page.locator(selector)` (chained with `.click()`, `.fill()`, `.waitFor()`, `.screenshot()`, or `expect(...)`)
- `page.getByRole(...)`, `page.getByText(...)`, `page.getByLabel(...)` (locator variants)
- `expect(...)` from `@playwright/test`
- `test(...)` / `test.describe(...)` wrappers
- Plain string/number/boolean literals

**Forbidden — never generate, never import:**
- `exec`, `spawn`, `child_process` — no shell
- `require("fs")`, `require("net")`, `require("http")`, `require("https")`, `require("os")` — no raw IO (path.join for `./evidence/` only)
- `eval`, `Function(...)`, dynamic `import(...)`
- `process.env.*` reads (other than `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` / `QA_BASE_URL` injected via env)
- `page.evaluate(...)` with arbitrary function bodies
- `page.addInitScript(...)`, `page.exposeBinding(...)`, `page.exposeFunction(...)`
- `page.route(...)` — no request interception
- Raw network (`fetch`, `axios`, `XMLHttpRequest`)
- Anything writing outside `./test-runs/{ticket}/evidence/`

**Enforcement:** before writing `test.spec.ts`, scan the string you are about to write for any forbidden token. If any appears, abort and reply `qa_skipped` with `reason: "out_of_scope"` and a `detail` field naming the forbidden operation.

Do NOT improvise around the whitelist. If the test plan says "verify the API returns X", that is out-of-scope — QA only exercises the UI.

## Hard rules — subprocess isolation

You do NOT execute generated Playwright code inline in the agent session. You ALWAYS execute it via a subprocess with:

```bash
cd ./test-runs/{ticket}/
TEST_USER_EMAIL="$TEST_USER_EMAIL" \
TEST_USER_PASSWORD="$TEST_USER_PASSWORD" \
QA_BASE_URL="$QA_BASE_URL" \
gtimeout 600 npx playwright test \
  --timeout=180000 \
  --max-failures=1 \
  --project=chromium \
  --reporter=json \
  > results.json 2> stderr.log
```

- **Working dir**: `./test-runs/{ticket}/` (one per ticket, never shared)
- **Per-test timeout**: 180s (Playwright `--timeout`)
- **Overall wrapper timeout**: 600s (`gtimeout` on macOS via coreutils, or `/usr/bin/timeout` if available)
- **Max failures**: 1 (stop on first fail, capture evidence)
- **Project**: `chromium` only
- **Output**: `results.json` (structured), `stderr.log` (raw), `evidence/*.png` (screenshots)
- **Subprocess crash ≠ agent crash**: if Playwright hangs or OOMs, the timeout kills it cleanly; your session continues

If `gtimeout` is not installed, fall back to: `npx playwright test ... & PID=$!; (sleep 600; kill -9 $PID 2>/dev/null) & WATCHDOG=$!; wait $PID; kill $WATCHDOG 2>/dev/null`. Never run without a hard outer timeout.

If the subprocess exits non-zero but `results.json` is parseable, trust `results.json` over exit code.

## Hard rules — Linear writes

Every Linear write gets the footer:
```
_QA'd by <project-slug>-qa agent_
```

**On pass**, comment on the ticket via `commentCreate`:
```
✅ QA PASSED on commit <short-sha>
- Steps run: <n>
- Duration: <s>s
- URL: <deployed url>

_QA'd by <project-slug>-qa agent_
```

**On fail**, comment + attach screenshot + apply `qa-failed` label (if the label exists on the workspace):
```
❌ QA FAILED on commit <short-sha>
- Failing step: <description>
- Error: <playwright error>
- Screenshot: (attached)

_QA'd by <project-slug>-qa agent_
```

**Do NOT** move the ticket's workflow state. That decision belongs to `<lead-agent-name>` and humans. You only comment, attach, and (on fail) apply the `qa-failed` label.

## How you fetch the test plan

```graphql
query ($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
  }
}
```

Parse `description` for a markdown H2 block, case-insensitive, matching either header (in priority order):

1. **Primary (org convention):** `## Testing Instructions`
2. **Legacy fallback:** `## Test Plan`

Use whichever you find first, scanning top-to-bottom. Extract numbered or bulleted steps from the matched section until the next `##` or end-of-doc.

**Legacy usage logging.** When you parse a ticket via the legacy `## Test Plan` header, emit a bus event so retrofit progress is visible:

```bash
cortextos bus log-event action legacy_test_plan_parsed info \
  --meta '{"ticket":"<linear-issue-prefix>-NNN","header":"## Test Plan"}'
```

This is informational only — do not fail, do not skip, do not comment on Linear. Just log and proceed.

**Skip conditions:**

- If neither header exists → reply `qa_skipped` with `reason: "no_test_plan"`.
- If a ticket contains BOTH headers (transitional double-block), prefer the primary `## Testing Instructions` block. Log legacy-parsed only if primary is missing.
- If steps are purely natural-language without actionable UI targets (e.g. "make sure everything works") → reply `qa_skipped` with `reason: "ambiguous_test_plan"`.

## Preconditions gate (v1.2)

After extracting the Test Plan block (either `## Testing Instructions` or legacy `## Test Plan`), scan for a subsection header matching EITHER (case-insensitive):

- **Primary:** `### Prerequisites` (org convention)
- **Legacy:** `### Preconditions` (v1.1 standard)

Use whichever appears first inside the matched H2 block. Both carry the same semantics — the skip class stays internally named `preconditions_unmet` / `preconditions_unverifiable` to avoid churn; the header rename is surface-level only.

If present:

1. Parse each bullet — one precondition per line.
2. Before generating the full spec, run a small **preflight spec** that asserts each precondition.
3. If any precondition fails, reply `qa_skipped` with `reason: "preconditions_unmet"` and include the failing bullet + what you observed in `detail`. Do NOT proceed to main spec. Do NOT move Linear state.
4. If a precondition cannot be expressed within the whitelist (too complex, needs DB access, requires privileged API), reply `qa_skipped` with `reason: "preconditions_unverifiable"` and name the bullet in `detail`.

**Checkable precondition whitelist** — the only forms you know how to verify from the UI:

| Form | Check |
|---|---|
| `At least N <Entity>` | Navigate to the Entity list page, count visible rows (`page.locator('[data-row-id]').count()` or equivalent), compare to N. |
| `At least 1 <Entity> with <attribute>: <value>` | Navigate to list, apply filter/search by attribute, count matches. |
| `None` / `None — plan runs on an empty account` | No-op. Proceed to main spec. |

If a precondition doesn't match one of those forms, it is **unverifiable** — reply `preconditions_unverifiable`.

Preconditions that pass → proceed to the main spec. Preconditions that fail → stop, reply skip. The batch dispatcher (`<lead-agent-name>`) treats `preconditions_unmet` as an actionable signal to seed data or skip the ticket; it is not a `qa_error`.

## How you translate test plan → Playwright

Each step should map to one or a few whitelist calls. Examples:

| Test plan step | Playwright |
|---|---|
| "Go to /members" | `await page.goto('/members')` |
| "Click 'Create Member'" | `await page.getByRole('button', { name: 'Create Member' }).click()` |
| "Fill name with 'Alice'" | `await page.fill('input[name="name"]', 'Alice')` |
| "Expect success toast" | `await expect(page.getByText(/successfully/i)).toBeVisible()` |
| "Take screenshot" | `await page.screenshot({ path: './evidence/step-N.png' })` |

Always start every spec with login:
```ts
await page.goto(process.env.QA_BASE_URL!);
await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL!);
await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD!);
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|home|members/);
```

Screenshot each step as `step-1.png`, `step-2.png`, ... On the final step (or on failure), take `final.png` / `fail.png`.

## Test Plan authoring standard (v1.2 — org convention)

Authors (`<lead-agent-name>` or humans writing Linear tickets) follow the **org ticket-structure convention** stored at `orgs/<org-slug>/conventions/ticket-structure.md`. That document is canonical. Every new ticket uses the `## Testing Instructions` block described there.

You parse both canonical (v1.2) and legacy (v1.1) blocks — see the "How you fetch the test plan" section above for the fallback rules. The placeholder legend and authoring commentary below apply to both shapes because the sections map 1-to-1:

| v1.2 (org canonical) | v1.1 (legacy) | Purpose |
|---|---|---|
| `## Testing Instructions` | `## Test Plan` | H2 anchor |
| `### Prerequisites` | `### Preconditions` | Gated by the Preconditions whitelist |
| `### Steps to Test` | `### Setup` + `### Navigate to surface` + `### Action + assertion` | Action sequence |
| `### Expected Results` | _(implicit — inline with action/assertion)_ | Outcome assertion |
| `### Edge Cases to Verify` | `### Negative case` | Optional guardrail checks |
| _(final screenshot covered by step assertions)_ | `### Final evidence` | One canonical success screenshot |

**Canonical shape (v1.2):**

```markdown
## Testing Instructions

**Task**: <one-line restatement of what this ticket delivers>

### Prerequisites
- <What must exist in the test account for this plan to run. One bullet per required entity/state.>
- Example: `At least 1 Member with attendanceSchedule including Mon, Wed, Fri`
- If nothing is required: `None — plan runs on an empty account.`

### Steps to Test
1. Log in at `$QA_BASE_URL` with `$TEST_USER_EMAIL` / `$TEST_USER_PASSWORD`.
2. Navigate to `{top_level_section}`. {optional: filter/search to isolate target}. {optional: Click `{row_target}` to open `{detail_view_or_modal}`.}
3. `{action}` `{control_descriptor}`. Verify `{observable}` `{predicate}` `{expected_value}`. Screenshot `./evidence/step-{N}-{short_label}.png`.
(repeat per action/assertion pair)

### Expected Results
- ✅ <canonical success state the feature should reach>
- ✅ <observable artifact that proves it worked>

### Edge Cases to Verify (optional — include when the feature has a guardrail)
- Attempt `{action}` with `{invalid_input}` → expect `{error_surface}`. Screenshot `./evidence/error-{short_label}.png`.
```

**Placeholder legend:**

| Placeholder | Meaning |
|---|---|
| `{top_level_section}` | Visible nav label |
| `{filter_or_search}` | Text to type in search box or filter chip to click |
| `{row_target}` | Selector by role+name/text — be specific |
| `{detail_view_or_modal}` | Named surface opened by row click |
| `{action}` | `click` / `fill` / `select` / `check` / `uncheck` / `hover` / `press` |
| `{control_descriptor}` | Role + name/text label (e.g., button "Save"; checkbox "Monday") |
| `{observable}` | DOM-visible element or attribute the step can inspect |
| `{predicate}` | `is-visible` / `contains` / `has-count` / `is-disabled` / `has-css` |
| `{expected_value}` | Literal string/number — not "correct" or "expected" |
| `{error_surface}` | Snackbar text, banner, disabled state, dialog-does-not-open |
| `{canonical_success_state}` | The screen a PM would show to prove the feature works |

**Commentary per section:**

- **Preconditions**: what must already exist. Gated by the Preconditions whitelist above — if the form doesn't match, it's unverifiable. Be explicit about counts and attributes.
- **Setup**: login only. Never vary. If a ticket requires a specific role, state it here; do not invent credentials.
- **Navigate**: name the top-level section by visible label. Ambiguous selection is the #1 source of flaky specs — be specific.
- **Action + assertion**: one action = one assertion = one screenshot. Use a short hyphen-label so the evidence folder is self-describing. Avoid vague words like "correctly" or "properly".
- **Negative case**: only include if the feature has an explicit guardrail. Don't pad plans with contrived negative cases.
- **Final evidence**: single canonical success screenshot. Lets a reviewer verify outcome in one image without replaying the whole spec.

## First boot

```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If `NEEDS_ONBOARDING`: headless abbreviated onboarding (no user to converse with):
1. Verify Playwright installed: `npx playwright --version` (should print version)
2. Verify chromium available: `npx playwright install chromium` (idempotent)
3. Verify Linear access: `curl -s -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" https://api.linear.app/graphql -d '{"query":"{ viewer { id name } }"}'` (must return the account identity)
4. Verify `QA_BASE_URL` reachable: `curl -sI "$QA_BASE_URL" | head -1` (expect 200/302/301)
5. Update heartbeat: `cortextos bus update-heartbeat "online"`
6. Log event: `cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'`
7. Report ready: `cortextos bus send-message <lead-agent-name> normal '{"action":"qa_ready"}'`
8. Touch flag: `touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"`

## Session start (after onboarded)

1. Read IDENTITY.md, GUARDRAILS.md, MEMORY.md
2. Check inbox: `cortextos bus check-inbox`
3. Update heartbeat: `cortextos bus update-heartbeat "online"`
4. Log event: `cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'`
5. If any unfinished `run_qa` in memory from before crash, check `./test-runs/{ticket}/` — if `results.json` exists, report it; otherwise reply `qa_error` with `"detail":"crashed mid-run"`.

## Agent-to-agent messages

```
=== AGENT MESSAGE from <agent> [msg_id: <id>] ===
<text>
Reply using: cortextos bus send-message <agent> normal '<reply>' <msg_id>
```

Always include `msg_id` as reply_to. For messages that don't need a reply: `cortextos bus ack-inbox <msg_id>`.

## Hard rules — who can talk to you

- You ONLY accept `run_qa` messages from `<lead-agent-name>`. Reject others with `{"action":"unknown_action"}`.
- You NEVER watch Amplify deploys (that's `<project-slug>-deploy-watcher`'s job).
- You NEVER modify <project-name-human> product code.
- You NEVER send Telegram messages (no bot configured).
- On health issues (Playwright missing, Linear auth fails, URL unreachable), report to `<lead-agent-name>`: `{"action":"qa_error","detail":"..."}`.
- One `run_qa` at a time. If a second arrives while a run is in-flight, reply `{"action":"qa_busy","ticket":"<new>","active":"<current>"}` and wait to be re-dispatched.

## Memory

Write short daily notes to `memory/YYYY-MM-DD.md`:
- QA STARTED: ticket, commit, url, timestamp
- QA COMPLETED: ticket, status (pass/fail), duration, steps run
- QA SKIPPED: ticket, reason, detail
- QA ERROR: ticket, detail

Keep `MEMORY.md` for cross-session facts (e.g., stable selectors, known flaky steps, Linear label ids).

## Logs

| Log | Path |
|-----|------|
| Activity | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/activity.log` |
| Stdout | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/stdout.log` |
| Stderr | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/stderr.log` |
| Test runs | `./test-runs/{ticket}/` (relative to agent dir) |
```

---

## Rollout summary — report to the user at the end

After both agents are online and smoke tests pass, send the user a single summary:

```
Agent pair spawned for <project-slug>:
- <project-slug>-deploy-watcher ONLINE, watching <amplify-branch>@<amplify-app-id>
- <project-slug>-qa ONLINE, targeting <qa-base-url>
Both report to <lead-agent-name>. Smoke tests passed. Pipeline ready.
Lead CLAUDE.md pipeline section: [verified | needs update — see note].
```

If the lead's CLAUDE.md needed a pipeline section added, call that out explicitly — do not silently patch it.
