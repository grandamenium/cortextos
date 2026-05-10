# adversarial-review

Codex pressure-tests the current diff for a specific risk area. Single-evaluator (Codex only); narrower and harsher than `dual-review`. Use on PRs touching sensitive code where "looks correct" isn't enough — auth, data deletion, schema migrations, rollback paths, financial logic, race conditions.

The skill invokes `codex review` with a custom adversarial prompt parameterised by the focus area. Codex acts as a hostile reviewer: assumes the code is broken, looks for the specific failure mode the area is prone to, ignores generic style concerns.

**Trigger phrases:**
- "run adversarial review on <area>"
- "/adversarial-review <area>"
- "/adversarial-review <area> <PR#>"

Where `<area>` is one of: `auth`, `data-loss`, `rollback`, `race`, `reliability`, `injection`, or `custom` (skill prompts for the focus).

---

## When to use

- **Sensitive PR pre-merge.** Auth changes, schema migrations, anything that can ship pain to users if wrong.
- **`code-evaluator` LGTM but you're not sure.** Fresh adversarial perspective often surfaces what the project-tuned reviewer normalised.
- **Post-incident review.** Run adversarial-review against the area where an incident happened; surface adjacent risks before the next one.

**When NOT to use:**
- On every PR. Adversarial mode flags more than it should by design; signal-to-noise drops if used everywhere. Reserve for genuine risk.
- Instead of `dual-review` for general PR review. Dual-review balances adversarial Codex with project-aware Claude; adversarial-review is single-perspective.
- Instead of `pr-deep-evaluator` for multi-phase PR cross-cutting review. Different question.

---

## Prerequisites

```bash
# Codex CLI installed
if ! command -v codex >/dev/null 2>&1; then
  echo "abort: codex CLI not installed. Install: npm i -g @openai/codex" >&2
  exit 1
fi

# AND authenticated (use exit code, not output text)
if ! codex login status >/dev/null 2>&1; then
  echo "abort: codex not authenticated. Run: codex login" >&2
  exit 1
fi
```

Unlike `dual-review`, this skill has no fallback — Codex IS the reviewer. If codex is unavailable, the skill aborts; use `dual-review` (with FALLBACK) or plain `code-evaluator` instead.

```bash
# Add reviews/ to .gitignore if not already there.
# `[ -f .gitignore ]` short-circuits when .gitignore doesn't exist (otherwise grep's
# non-zero exit would abort under `set -e`).
if [ -f .gitignore ] && grep -qE '^reviews/?$' .gitignore; then
  :  # already ignored
else
  echo "reviews/" >> .gitignore
fi
```

---

## Setup

```bash
AREA="${1:?usage: /adversarial-review <area> [PR#]}"
PR_NUM="${2:-branch}"
TS=$(date -u +%Y-%m-%dT%H%M%SZ)
SESSION_DIR="reviews/adversarial-${AREA}-${PR_NUM}-${TS}"
mkdir -p "$SESSION_DIR"

GH_REPO="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}"

DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
  | sed 's@^refs/remotes/origin/@@')
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

# Working tree must be clean — codex review reads live git state.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "abort: working tree has uncommitted changes — commit or stash first." >&2
  exit 1
fi

START_REF=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse HEAD)

if [ "$PR_NUM" = "branch" ]; then
  BASE="$DEFAULT_BRANCH"
else
  BASE=$(gh pr view "$PR_NUM" --repo "$GH_REPO" --json baseRefName -q .baseRefName)
  HEAD_SHA=$(gh pr view "$PR_NUM" --repo "$GH_REPO" --json headRefOid -q .headRefOid)
  git fetch origin "+refs/pull/${PR_NUM}/head:refs/remotes/origin/pr/${PR_NUM}"
  git checkout "$HEAD_SHA"
fi

# After Stage 2 (or on early exit), restore the original branch:
#   git checkout "$START_REF"
```

---

## Stage 1: Build the adversarial prompt

The prompt template depends on the focus area. The skill maintains a small library:

```bash
case "$AREA" in
  auth)
    PROMPT='You are an adversarial reviewer assuming this code is broken. Pressure-test for authentication and authorization bugs: missing access-control checks, session-fixation, token-leak in logs/URLs/errors, role-bypass via the wrong endpoint, race in token refresh, scope-broadening in OAuth flows, missing CSRF protection on state-changing requests, downgrade attacks on auth handshakes. Cite file:line for every finding. Skip style and naming.'
    ;;
  data-loss)
    PROMPT='You are an adversarial reviewer assuming this code can lose data. Pressure-test for: unsafe deletes (no soft-delete fallback, no audit log), schema migrations without rollback paths, race between read-and-write that can drop a write, cascade deletes that span more than the immediate row, missing transactions where atomicity is required, batch operations with partial-failure that orphan state. Cite file:line for every finding.'
    ;;
  rollback)
    PROMPT='You are an adversarial reviewer assuming this deploy will be rolled back tomorrow. Pressure-test the rollback path: schema changes that are forwards-compatible but break the previous code version, config field additions consumed by current code with no default, new required env vars without fallbacks, data migrations that are not idempotent, observable side-effects (events, webhooks) that fire during rollout but not on rollback. Cite file:line for every finding.'
    ;;
  race)
    PROMPT='You are an adversarial reviewer assuming concurrency is hostile. Pressure-test for: read-modify-write races on shared state, double-spawn in supervisor restart paths, time-of-check vs time-of-use bugs in file handling, queue-consumer races that drop or duplicate messages, retry storms that hammer the upstream, deadlocks under contention, ordering assumptions that fail under partial failure. Cite file:line for every finding.'
    ;;
  reliability)
    PROMPT='You are an adversarial reviewer assuming the network is unreliable and processes will crash. Pressure-test for: missing timeouts on outbound calls, retries without backoff or jitter, unbounded memory or queue growth, lost work on process restart (no idempotency, no checkpoint), silent failures that swallow exceptions, monitors that fire on usage rather than liveness, alerts that page on transient noise. Cite file:line for every finding.'
    ;;
  injection)
    PROMPT='You are an adversarial reviewer assuming every input is hostile. Pressure-test for: SQL/NoSQL/command/LDAP/log injection via string concatenation, XSS via unescaped output, SSRF via fetched URLs, path traversal via user-supplied filenames, deserialisation of untrusted data, header injection in HTTP responses, prompt injection if LLM-mediated. Cite file:line for every finding.'
    ;;
  custom)
    echo "Enter custom adversarial focus (one paragraph), then EOF (Ctrl-D):" >&2
    PROMPT=$(cat)
    ;;
  *)
    echo "abort: unknown area '$AREA'. Valid: auth | data-loss | rollback | race | reliability | injection | custom" >&2
    exit 1
    ;;
esac
```

The prompts are deliberately hostile. Codex's default review is balanced; the adversarial prompt biases toward suspicion. Reconciliation discipline (see Stage 2) catches the false-positive cost.

---

## Stage 2: Run codex review with the adversarial prompt

```bash
codex review --base "$BASE" "$PROMPT" > "$SESSION_DIR/codex-adversarial.md" 2>&1
```

Codex returns a free-form review keyed to the adversarial prompt. Output goes to the session dir for audit.

---

## Stage 3: Disciplined triage

Same FIX / DISMISS-with-reason / ESCALATE classification as `dual-review` (see `community/skills/dual-review/SKILL.md` § "Stage 3: Disciplined triage").

The adversarial bias makes triage especially important — Codex will flag patterns that aren't actually bugs in your context. The DISMISS reason is the discipline:

- "Codex flags missing CSRF on POST /webhook, but webhook signature verification at line 23 is the equivalent protection — CSRF doesn't apply to server-to-server calls."
- "Codex flags a race in the token-refresh path, but the refresh is gated by a per-user mutex acquired at line 8 — no race possible."

Without the dismissal reason, the agent obediently applies "fixes" that introduce real bugs (a CSRF token check on a webhook endpoint that breaks signature verification).

---

## Stage 4: Apply fixes + commit

Standard fix-commit pattern:

```bash
git add -u
git commit -m "$(cat <<EOF
fix: adversarial-review feedback ($AREA)

Addresses N findings from codex adversarial review for $AREA.
Triage: $SESSION_DIR/triage.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

ESCALATE findings stay open for user input. DISMISS findings are recorded but require no action.

After review and fixes, return to original branch:

```bash
git checkout "$START_REF"
```

---

## Output structure

```
reviews/adversarial-<AREA>-<PR>-<TS>/
  codex-adversarial.md     # raw Codex output
  triage.md                # FIX / DISMISS-with-reason / ESCALATE
```

Smaller than `dual-review` (no claude-review or merged file) — single evaluator means single artifact.

---

## Cost

One Codex API call per invocation. Adversarial prompts run longer (Codex explores more deeply) so the call is ~2x the cost of a standard `codex review`. Reserve for sensitive PRs.

---

## Anti-patterns

- **Running adversarial-review on every PR.** Adversarial bias produces false positives by design; using it everywhere drowns the signal.
- **Applying every adversarial finding without triage.** The whole point is the dismissal discipline.
- **Treating adversarial-review as a substitute for `dual-review`.** Adversarial is harsh-and-narrow; dual is balanced-and-broad. Different tools.
- **Picking the wrong area.** "auth" prompt on a data-migration PR misses migration-specific risks. Pick the area that matches the diff.
- **Stacking multiple areas in one run.** Each area gets its own focused prompt; running two areas dilutes both. Run twice if you genuinely need two areas.

---

## Source

- OpenAI Codex CLI: `codex review` with custom prompt (https://developers.openai.com/codex/cli)
- `codex-plugin-cc`'s `/codex:adversarial-review` slash command (the inspiration; this skill replicates the pattern via direct CLI for agent-callability)
- Companion: `community/skills/dual-review/SKILL.md` (balanced review), `community/skills/codex-rescue/SKILL.md` (delegate stuck task)
- Pattern doc: `08-llm-and-agents/dual-evaluator-pattern.md` in sb-tech-handbook (the dismissal-discipline framing applies here too)
