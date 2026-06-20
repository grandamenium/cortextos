---
name: coding-standards-curator
description: "Mine Greptile review history, surface recurring P0/P1/P2 patterns, codify into project-specific coding standards. Goal: each Greptile-detected pattern becomes a rule that prevents future occurrences, reducing review iterations over time. Run weekly + on-demand."
triggers: ["coding standards", "greptile patterns", "recurring findings", "code rules", "quality standards"]
---

# Coding Standards Curator

> Greptile catches the same patterns repeatedly across PRs. Every time we
> fix one of these, we should also write the rule down — so the next agent
> doesn't have to learn it through failed review.
>
> Goal: shrink Greptile iterations. Today most PRs need 2-3 rounds; aim
> for 1.

---

## When to run

- **Real-time poll** (every 15 min) — fast lane: only mine PRs with new
  Greptile activity. If a P0/P1 graduates: immediate proactive push to
  agent GUARDRAILS so the NEXT PR can't repeat the same mistake.
- **Sunday weekly cycle** (14:00) — full re-cluster, regression report,
  weekly digest.
- **On-demand** when user says "run mining cycle now"
- **Triggered** when Greptile flags a pattern that already exists in
  the standards file (regression signal — alert immediately)

---

## The 5-step cycle

### Step 1 — Mine (incremental, 5–15 min)

Pull Greptile reviews from EVERY PR we haven't seen yet. We persist the
last-mined number in `tests/quality/.last-mined-pr` so future cycles
only process new PRs (~1-5 per cycle vs 293 first-time).

```bash
REPO=syntasticstudios/phytomedic-saas
mkdir -p tests/quality/greptile-cache

LAST_MINED=$(cat tests/quality/.last-mined-pr 2>/dev/null || echo 0)
LATEST=$(gh pr list --repo $REPO --state all --limit 1 --json number --jq '.[0].number')

if [ "$LATEST" -le "$LAST_MINED" ]; then
  echo "No new PRs since #$LAST_MINED."
  exit 0
fi

# Mine new PRs only (cache hit if already on disk)
for pr in $(gh pr list --repo $REPO --state all --limit 1000 --json number --jq '.[].number'); do
  if [ "$pr" -gt "$LAST_MINED" ] && [ ! -f "tests/quality/greptile-cache/pr-$pr.json" ]; then
    gh pr view $pr --repo $REPO \
      --json comments,reviews \
      --jq '{comments: [.comments[] | select(.author.login | startswith("greptile"))],
             reviews:  [.reviews[]  | select(.author.login | startswith("greptile"))]}' \
      > tests/quality/greptile-cache/pr-$pr.json
  fi
done

echo "$LATEST" > tests/quality/.last-mined-pr
```

**First-time bootstrap:** mine ALL existing PRs (set `LAST_MINED=0`).
This was done once on 2026-04-29 — produced the initial seed of 293
cached PRs and 8 graduated rules.

**Incremental:** every Sunday only processes new PRs since the last cycle.

### Step 2 — Cluster patterns (10 min)

Read the bodies file. Group into pattern-buckets. Each bucket = (regex|signature, severity-mode, count, example-PRs).

Common buckets to seed (project-specific to phytomedic-saas / Convex / Next.js):

| Pattern signature | Severity | Detection regex |
|-------------------|----------|----------------|
| `.collect()` without limit on growing table | P1 | `\.collect\(\).+(?:no full-table scans|cap|limit)` |
| `.take(N)` BEFORE filter | P1 | `\.take\(\d+\).+filter|truncates|silently excluded` |
| Unawaited promise in serverless catch | P1 | `unawaited|exit before.+resolve|background Promise` |
| Window-boundary off-by-one | P1 | `boundaries are equal|null when.+windowDays|silently zeroes` |
| State-mutation BEFORE validation throw | P1 | `called.+before.+guard|resets.+counter.+before throw` |
| Self-referential redirect | P0 | `redirect.+itself|infinite redirect|permanentRedirect.+same path` |
| Two sibling dynamic-segments | P0 | `sibling dynamic-segment|\[id\].+\[slug\]|app.+not compile` |
| pointer-events-none for form gating | P1 | `pointer-events-none.+keyboard|Tab into.+submit|inert attribute` |
| Nested `<a>` in `<Label>` | P1 | `nested.+<Label>|clicking.+link.+toggle.+checkbox` |
| Cap before filter underestimates metric | P2 | `capped at.+records.+silently understated|rate.+inherit` |

If any pattern has count ≥ 3 in last 30 PRs: **graduate to standards file** (Step 4).

### Step 3 — Severity-trend analysis (5 min)

For each existing rule in `tests/quality/CODING_STANDARDS.md`:
- count occurrences in last 30 PRs
- if count > 0 after rule was added: **regression signal** — alert user
- if count = 0: rule is working

```markdown
## Pattern Compliance Report (auto-generated)

| Pattern | Added | Last 30 PRs | Status |
|---------|-------|-------------|--------|
| `.collect()` no limit | 2026-04-12 | 2 | ⚠ regressing |
| Sibling [id]/[slug] | 2026-04-25 | 0 | ✅ effective |
| ... | ... | ... | ... |
```

### Step 4 — Codify (15 min)

Write to `tests/quality/CODING_STANDARDS.md`:

```markdown
## Convex queries

### NO `.collect()` on growing tables
Always use `.take(N)` with explicit limit, OR `.paginate()` with cursor.
Tables to never `.collect()` without limit: products, offers, orders,
cases, prescriptions, doctorProfiles, pharmacies.

If you absolutely need full-table scan: add a comment explaining why
the table size is bounded.

**Why:** convex enforces 16MB / 8s read limits. `.collect()` on a 10k+
row table will fail at scale, often after passing tests on small dev data.

**Example violation (PR #297, #300, #301):** `getPharmacyKpiSummary`
called `.collect()` on offers table — no row limit despite comment
"no full-table scans".

**Detection:** Greptile P1, biome lint rule TBD.

### `.take(N)` AFTER `.filter()`, never before
...
```

Each rule has: name, rule, why (mechanism), example (PR ref), detection
(Greptile label OR custom lint).

### Step 5 — Proactive Distribute (5 min) ⚠️ CRITICAL

After updating `CODING_STANDARDS.md`, the rule must be VISIBLE to coding
agents BEFORE they open their next PR. Pure markdown isn't enough — they
won't read it autonomously. **Push it into their working context:**

#### 5.1 — Update agent GUARDRAILS.md (frontend-dev + backend-architect)

Append to the Red Flag Table in each agent's `GUARDRAILS.md`:

```markdown
| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| About to add metadata.title with brand suffix | "I'll just add ` \| PhytoMedic`" | STOP. Check src/app/layout.tsx for title.template. If set: NEVER manually suffix. See P1-07 in tests/quality/CODING_STANDARDS.md. |
```

One row per new graduated rule. The rule's `Trigger` is the moment the
agent might violate it; `Red Flag Thought` is the rationalization;
`Required Action` includes the rule ID + file reference.

#### 5.2 — Update PR template (.github/pull_request_template.md)

Append a checkbox per critical rule. Example:

```markdown
## Pre-merge self-check

- [ ] No `.collect()` without limit (P1-02)
- [ ] No N+1 query loops (P1-01)
- [ ] No manual `| PhytoMedic` suffix in metadata.title (P1-07)
- [ ] All filter fields have an index (P1-03)
- [ ] No hardcoded URLs (P1-05)
- [ ] No race conditions on shared state (P1-04)
- [ ] Filter BEFORE .take() (P1-06)
- [ ] German UI consistency (P2-01)
```

When agent opens a PR, this checklist is in the description. They can't
miss it.

#### 5.3 — Generate machine-checkable lint rule

Append to `tests/quality/lint-rules.yaml`:

```yaml
- id: P1-07-no-manual-brand-suffix
  pattern: 'title:\s*"[^"]+\|\s*PhytoMedic"'
  files: ["src/app/**/page.tsx", "src/app/**/layout.tsx"]
  severity: error
  message: "Don't manually suffix '| PhytoMedic' — root layout title.template handles it. See P1-07."
```

Wire `lint-rules.yaml` to pre-commit hook (separate task — once wired,
patterns die at commit time, never reach Greptile).

#### 5.4 — Telegram digest (via platform-director, not own channel)

For weekly cycles only (don't spam on every real-time graduate):

```
📊 Coding Standards W18 — cortextos-improver

🆕 P1-07 graduated (caught live on PR #364)
⚠️ 5 regressing patterns: P1-01..P1-05
📈 Iteration rate: 2.1 (vs 2.3 W17, vs target 1.5)

Standards now: 9 rules
PR template updated.
GUARDRAILS distributed to frontend-dev + backend-architect.
```

For real-time graduates (single rule), only Telegram if SEVERITY=P0
(critical bugs that are live in prod or could ship next).

#### 5.5 — Commit + branch

```bash
cd /Users/arndt/phytomedic-saas
git checkout -b auto/coding-standards-$(date +%Y-%m-%d-%H%M)
git add tests/quality/ .github/pull_request_template.md \
  $(find orgs/$CTX_ORG/agents/{frontend-dev,backend-architect}/GUARDRAILS.md 2>/dev/null)
git commit -m "feat(quality): real-time pattern graduation — P1-XX (PR #N)"
git push -u origin auto/coding-standards-...
gh pr create --title "feat(quality): auto-distribute coding-standards update" \
  --body "Auto-curated by cortextos-improver. Real-time graduation from PR #N Greptile finding."
```

Self-merge after Greptile review of the standards-PR itself passes.

---

## Lint-gen capability (advanced)

For each pattern, attempt to generate an automated check:

```yaml
# tests/quality/lint-rules.yaml
rules:
  - id: convex-collect-no-limit
    pattern: '\\.collect\\(\\)'
    requires_nearby: '\\.take\\(\\d+\\)'
    severity: error
    message: "Use .take(N) before .collect() to avoid full-table scans"
    files:
      - "convex/functions/**/*.ts"
      - "convex/actions/**/*.ts"
```

Then add as pre-commit hook OR ESLint custom rule. Catches future
violations BEFORE PR open → before Greptile → before iteration.

---

## Output artifacts

- `tests/quality/CODING_STANDARDS.md` — human-readable, agent-readable rule set
- `tests/quality/lint-rules.yaml` — machine-checkable subset
- `tests/quality/greptile-cache/` — raw history for future mining
- Memory: `memory/coding-standards-versions.md` — when each rule added/last-violated

---

## Anti-patterns of this skill

- ❌ Codifying single-occurrence findings — wait for ≥3 to confirm pattern
- ❌ Phrasing rules as "don't do X" without explaining mechanism — agents need WHY
- ❌ Updating standards but not updating GUARDRAILS — rule stays invisible
- ❌ Not tracking compliance — without metrics, you don't know if rules work
- ❌ Vague rules ("write good code") — must be checkable

---

## Cron

```json
{
  "name": "coding-standards-curator",
  "type": "recurring",
  "cron": "0 14 * * 0",
  "prompt": "Read .claude/skills/coding-standards-curator/SKILL.md and run the full mining cycle. Pull last 30 Greptile reviews, cluster patterns, codify any with count ≥3 into tests/quality/CODING_STANDARDS.md, regenerate compliance report, distribute to GUARDRAILS files, send Telegram digest with iteration-rate trend."
}
```

---

## Success metrics

| Metric | Target |
|--------|--------|
| Iteration rate (rounds-of-Greptile-feedback per PR) | < 1.5 within 4 weeks |
| New rules graduating per week | 1-3 |
| Regressing rules (rule exists, pattern reappears) | 0 |
| Lint-rules generated per skill cycle | ≥ 50% of new rules |

---

*Greptile is the teacher. This skill is how the lesson sticks.*
