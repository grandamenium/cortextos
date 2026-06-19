# Feature Bundles — coordinated agent work

A **feature bundle** is the unit of coordinated work: ONE shared goal spanning the
affected product roles (patient / doctor / pharmacy / manufacturer / admin), with
ONE sub-task per role. Agents pull bundle sub-tasks via `claim-next --bundle`,
instead of grabbing isolated, self-filed random tasks — which was the structural
cause of duplicate, uncoordinated work.

## Where bundles live

Bundle manifests live in the **vault** (its own repo), one file per bundle:

```
obsidian-vault/agent-shared/bundles/<bundle_id>.md
```

The manifest is the human-readable source of truth; `bundle-decompose` turns it
into real bus tasks that carry the `bundle_id` + `role` and the cross-role
dependency edges.

## Manifest format (dependency-free, no YAML)

```
bundle: B-2026-06-rezept-flow
goal: Patient orders a prescribed product end-to-end across all roles

- role: manufacturer | assignee: backend-architect | title: createProduct sets draftStatus=pending
- role: admin | assignee: backend-architect | title: approveProductDraft flips atomically | after: manufacturer
- role: pharmacy | assignee: frontend-dev | title: einkauf uses the gated query | after: admin
- role: patient | assignee: frontend-dev | title: catalog filters draftStatus=approved | after: admin
- role: doctor | assignee: frontend-dev | title: review-only impact | after: admin
```

- `bundle:` — the bundle id (becomes `bundle_id` on every sub-task).
- `goal:` — the one shared end-to-end goal.
- one `- role: … | title: …` line per affected role. `assignee:` (optional) routes
  the task to an agent; `after:` (optional) is a comma-separated list of **roles**
  this sub-task depends on → a `blocked_by` edge (the dep role's task must reach
  `completed` first). Lines may be in any order; decomposition is topological.

## Workflow

```bash
# 1. Decompose a manifest into bus tasks (idempotent — safe to re-run):
cortextos bus bundle-decompose obsidian-vault/agent-shared/bundles/B-2026-06-rezept-flow.md

# 2. Agents pull coordinated work from the bundle:
cortextos bus claim-next --bundle B-2026-06-rezept-flow            # next workable sub-task
cortextos bus claim-next --bundle B-2026-06-rezept-flow --role doctor   # only the doctor slice

# 3. Track progress (existing):
cortextos bus bundle-status
```

A sub-task is only handed out when its `after:` dependencies are all `completed`,
so cross-role sequencing (e.g. manufacturer schema before pharmacy UI) is enforced.

## Not yet enforced (deliberate)

The hard rule "a task without a `bundle_id` cannot be claimed" is NOT enabled yet
— turning it on before bundles exist would block all current work. Enable it once
the active bundles are populated (see the dev-setup audit, follow-up A.5).
