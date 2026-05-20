---
name: engineering-workflow-guardrails
description: "Six hard-learned guardrails for multi-agent engineering teams running agentic development workflows. Covers task tracking, code review gates, spec state machines, implementation agent handoffs, harness coverage, and staging validation. Apply these to any team using a repo-agent + implementation-agent pattern. Each guardrail was extracted from a real incident where skipping it caused rework or data loss."
triggers: ["coding guardrails", "engineering workflow", "pr required", "spec review", "adversarial review", "staging validation", "harness coverage", "tasks before code", "implementation workflow", "agentic development", "multi-agent engineering", "code review state machine", "no direct push", "coding workflow", "development guardrails", "repo agent workflow", "implementation agent", "spec state machine"]
external_calls: []
---

# Engineering Workflow Guardrails

Six guardrails for multi-agent engineering teams. Each was discovered from a real incident. All are non-negotiable once your team exceeds one implementation agent.

---

## Guardrail 1 — Tasks Before Code (hook-enforceable)

**Rule:** A cortextos task must be created and marked `in_progress` before any agent writes or modifies code. No exceptions.

**Why it exists:** Work that has no task is invisible on the dashboard. Agents can appear productive in logs while the task list stays empty, making utilization and accountability unmeasurable.

**Implementation:**

```bash
# Required BEFORE any Edit/Write/code Bash call
TASK_ID=$(cortextos bus create-task "<title>" --desc "<what and why>")
cortextos bus update-task "$TASK_ID" in_progress
```

**Enforcement:** Add to `settings.json` hooks:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write|Bash",
      "command": "check-task-in-progress.sh"
    }]
  }
}
```

**Target:** 0 code commits without a corresponding task. Dashboard effectiveness = tasks dispatched / time, so ghost work is wasted capacity.

---

## Guardrail 2 — PR Required, No Direct Main Push (hook-enforceable)

**Rule:** All code goes through a feature branch and pull request. Only the authorized human merges to main. No force pushes, no `--no-verify` bypasses.

**Why it exists:** Direct pushes to main bypass review, trigger immediate production deploys on auto-deploy platforms, and cannot be audited at the PR level. One incident: an HTTPS push using a token in the push URL bypassed all hooks and merged untested code to production.

**Implementation:**

```bash
# Always branch first
git checkout main && git pull
git checkout -b feature/<name>

# When ready — push branch, never push main
git push origin feature/<name>
# Then open PR via gh or your platform
gh pr create --title "..." --body "..."
```

**Enforcement hook:** Add to `settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash",
      "command": "block-direct-main-push.sh"
    }]
  }
}
```

**Target:** 0 direct pushes to main from any agent session. Branch-per-feature, always.

---

## Guardrail 3 — Spec-Review State Machine (sequential, no skips)

**Rule:** Implementation follows a fixed stage sequence. No stage may be skipped, and no two stages may run in parallel.

```
DRAFT_SPEC → SPEC_REVIEW (adversarial) → SPEC_APPROVED → IMPLEMENTATION → BUILD_REVIEW → STAGING_VALIDATE → PR_OPENED → HUMAN_MERGES
```

**Why it exists:** Parallelizing `SPEC_REVIEW` with `IMPLEMENTATION` means the implementation agent builds against an unapproved spec. When the spec changes (and it will), you get two competing codebases and a rebuild. This happened with a parallel test pipeline that produced garbage output and required reverting 4 PRs.

**How to enforce:**

- **Repo-agent** (supervisor) owns the state machine. It writes state to a shared task status field.
- **Implementation agent** does not begin until `SPEC_APPROVED` is set.
- **Repo-agent** does not merge until `STAGING_VALIDATE` passes.

```bash
# Repo-agent sets state; implementation agent checks before starting
cortextos bus update-task "$SPEC_TASK_ID" "SPEC_APPROVED"
# Implementation agent only starts when status = SPEC_APPROVED
cortextos bus get-task "$SPEC_TASK_ID" | grep -q "SPEC_APPROVED" || exit 1
```

**Target:** 0 parallel spec + implementation cycles. One thread at a time.

---

## Guardrail 4 — Adversarial Review BEFORE Implementation

**Rule:** Before any implementation agent starts coding, a senior agent (or the Architect sub-agent) must critique the spec from a "what could go wrong?" lens. This review blocks implementation — it is not optional or post-hoc.

**Why it exists:** Spec problems caught pre-implementation cost one conversation turn. Spec problems caught post-implementation cost a full rebuild. In one case, a harness was built for 3 entities when the spec committed to 25 — an adversarial review would have caught the commitment vs. scope mismatch before any code was written.

**Implementation:**

```bash
# Repo-agent spawns adversarial review before dispatching to implementation agent
# Use the architect sub-agent for independent critique
cortextos spawn-worker adversarial-review --dir . --prompt \
  "You are an adversarial reviewer. Read SPEC.md and identify: (1) scope/commitment mismatches, (2) missing edge cases, (3) any assumption that will break under load. Return PASS or FAIL with findings."
```

**Checklist for adversarial review:**
- Does the spec commit to specific counts/outputs that the implementation can actually deliver?
- Are all external dependencies enumerated?
- Is the staging validation criterion concrete (not "deploy and check")?
- Are there race conditions or ordering dependencies not documented?

**Target:** Every spec gets an adversarial PASS before implementation begins. No exceptions.

---

## Guardrail 5 — Harness Coverage Gate

**Rule:** When a repo-agent reviews implementation output, it must verify that the actual entity/record/output count matches what the spec committed to. A review that does not verify counts is not a review.

**Why it exists:** In one incident, the implementation agent built a 3-entity test harness when the spec committed to 25. The review-agent checked "does it run?" but not "does it cover what was promised?" The shortfall shipped to staging and required a rebuild.

**Enforcement in review prompt:**

```
REQUIRED: Before marking this implementation as PASS, confirm:
1. Spec committed to N entities/records/outputs.
2. Implementation produces exactly N (not a subset, not a sample).
3. Evidence: paste the actual count from a test run.

If count ≠ commitment → FAIL. Do not pass partial implementations.
```

**How to log compliance:**

```bash
cortextos bus log-event action harness_coverage_verified info \
  --meta '{"spec_commitment":25,"actual_count":25,"task_id":"'"$TASK_ID"'"}'
```

**Target:** Every build review logs a coverage verification event. 0 PRs opened without this event.

---

## Guardrail 6 — Staging Validation = Full Deploy + Pipeline Run (not probes)

**Rule:** "Staging validated" means: (1) the branch is deployed to a staging environment, (2) it runs with production-equivalent data, (3) a full pipeline/workflow executes end-to-end, and (4) concrete output is produced and verified. A health check ping is not staging validation.

**Why it exists:** Health checks only verify the server started. They say nothing about whether the code produces correct output with real data. In one incident, "staging validated" was declared after a health probe returned 200 — but the pipeline logic was broken and only surfaced with real data 24h later in production.

**Required evidence before declaring "staging validated":**

```bash
# 1. Deploy the branch
git push origin feature/<name>
# trigger deploy to staging environment

# 2. Verify with real data — NOT synthetic test fixtures
# Run your pipeline/workflow end-to-end

# 3. Capture concrete output evidence
# E.g.: record count, generated file, API response body — not just 200 OK

# 4. Log staging validation
cortextos bus log-event action staging_validated info \
  --meta '{
    "branch": "feature/<name>",
    "env": "staging",
    "data_source": "production-equivalent",
    "output_evidence": "<what you observed>",
    "task_id": "'"$TASK_ID"'"
  }'
```

**Target:** Every `STAGING_VALIDATE` stage produces a logged event with concrete output evidence. No PR is opened without this log entry.

---

## Quick-Reference Table

| # | Guardrail | Enforced By | Skip Cost |
|---|-----------|-------------|-----------|
| 1 | Tasks before code | Hook (PreToolUse) | Invisible work, 0% dashboard score |
| 2 | PR required, no direct main push | Hook (PostToolUse) + human merge gate | Untested code in prod |
| 3 | Spec-review state machine | Repo-agent task states | Parallel builds, 4+ PR reverts |
| 4 | Adversarial review before implementation | Blocking review step | Rebuild on spec mismatch |
| 5 | Harness coverage gate | Review-agent checklist | Partial implementation ships |
| 6 | Staging = full deploy + pipeline run | Log gate before PR | Silent production breakage |

---

## Applying This to Your Fleet

These guardrails assume a **repo-agent + implementation-agent** architecture:

- **Repo-agent** — supervises spec, owns the state machine, runs adversarial + build reviews, validates staging, opens PRs
- **Implementation-agent** — writes code only after `SPEC_APPROVED`; does not merge
- **Human** — only entity who merges to main; approves external-comms and deployment categories

If you have a single-agent setup, the same agent runs all phases sequentially — the state machine still applies, just in one context window.

---

## Contributing Improvements

If you hit a new failure mode that produced rework, add it as Guardrail 7+. Follow the format: rule → why it exists (incident summary, anonymized) → implementation → target metric.
