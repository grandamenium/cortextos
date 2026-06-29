# Claude Code Workflows Implementation and Spec Patterns

Date: 2026-06-29
Scope: implementation research, spec structure, authoring patterns, reusable examples, and gaps for cortextOS Workflows and Claude Code native Workflows.

## Executive Summary

There are two related systems in the local evidence:

1. Claude Code native Dynamic Workflows. These live under `~/.claude/projects/.../workflows/` and are executed by Claude Code's private workflow runtime. They use JavaScript orchestration files with runtime-provided primitives such as `phase`, `log`, `agent`, `parallel`, and `pipeline`. Agent calls spawn Claude workflow subagents. Scripts can contain inline schemas and large prompt builders. Run records include the script, args, result, logs, phases, per-agent progress, token totals, and tool-call totals.

2. cortextOS Workflows. This is the cortextOS implementation inspired by Claude Code Workflows. It lives in `src/workflows`, uses org-level workflow definition packages under `orgs/<org>/workflows/<name>/`, and maps `agent()` calls onto persistent cortextOS agents through the bus, workflow request envelopes, JSON replies, schema validation, audit packets, and dashboard data.

The important implementation difference is runtime ownership. Claude native workflows use Claude's own subagent runtime. cortextOS workflows use a safe local JS coordinator, persistent named agents, durable run directories, bus dispatch, and explicit `workflow-reply` records.

The strongest authoring pattern is to treat workflows as reusable orchestration packages, not as long-form instructions. The package should declare phases and agent calls in `workflow.meta.json`, implement deterministic control flow in `workflow.js`, put production output contracts in `schemas/*.schema.json`, and keep prompts self-contained enough that a target agent can complete its call without knowing the whole workflow architecture.

## Sources Inspected

Example research and workflow docs:

- `docs/research/2026-05-29/claude-workflows-opus-48.md`
- `docs/content/weekly-script-research-2026-06-22/claude-workflows-cortext-extraction-2026-06-22.md`
- `docs/workflows/boosend-workflow.md`
- `docs/workflows/skill-optimizer-implementation-plan.md`
- `docs/workflows/seedance-optimizer-implementation-plan.md`
- `docs/workflows/seedance-dialogue-optimizer.md`

Example workflow research and implementation notes:

- `docs/research/cortextos-workflows-design/cortextos-workflows-design-note.md`
- `docs/research/claude-workflows-codex-adapter/research-note.md`
- `docs/research/cortextos-workflows-mvp/final-mvp-spec-build-plan.md`
- `docs/research/workflows-dogfood-upgrade-plan/workflows-dogfood-upgrade-plan.md`
- `docs/research/workflows-continuation-upgrade/workflows-continuation-upgrade-implementation.md`

Implementation files:

- `src/workflows/types.ts`
- `src/workflows/validate.ts`
- `src/workflows/sandbox.ts`
- `src/workflows/runner.ts`
- `src/workflows/commands.ts`
- `src/workflows/store.ts`
- `src/workflows/agent-dispatch.ts`
- `src/workflows/bus-transport.ts`
- `src/workflows/reply.ts`
- `src/workflows/schema.ts`
- `src/workflows/dashboard-data.ts`
- `src/cli/bus.ts`

Templates and installed examples:

- `templates/workflows/basic-review/`
- `templates/workflows/pr-review-iteration/`
- `templates/workflows/software-development/`
- `orgs/example/workflows/pr-review-iteration-dogfood/`
- `orgs/example/workflows/deploy-smoke/`
- `orgs/example/workflows/continuation-smoke/`

Native Claude Code workflow artifacts:

- `~/.claude/projects/.../workflows/scripts/*.js`
- `~/.claude/projects/.../workflows/wf_*.json`
- `~/.claude/projects/.../subagents/workflows/wf_*/agent-*.jsonl`
- `~/.claude/projects/.../subagents/workflows/wf_*/agent-*.meta.json`

## Existing Local Research Position

The prior data-codex brief from 2026-05-29 frames Claude Code Dynamic Workflows as script-owned orchestration:

- Claude writes a JavaScript workflow script.
- A background runtime executes the script.
- Control flow, loops, branching, fan-out, and sequencing live in script code.
- Intermediate state lives in script variables rather than the main chat context.
- The practical value is scale, because many agent calls can be queued and coordinated without flooding the primary conversation.

The 2026-06-19 Stephen design note then maps that methodology into cortextOS:

- Do not monkeypatch Claude Code's private workflow runtime.
- Build a cortextOS-native runner using a compatible subset of the workflow methodology.
- Map `agent()` to persistent cortextOS agents.
- Persist run records, agent calls, logs, schemas, approvals, and outputs.
- Make workflow execution visible in CLI, Telegram, and dashboard surfaces.

The MVP spec locked in several product decisions:

- Org-level workflow definitions under `orgs/<org>/workflows/`.
- A safe JavaScript coordination layer.
- Workflow definitions authored by agents from templates and skills.
- Production workflows require schemas and changelogs.
- Dry-run graphs must expose phases, calls, side effects, approvals, and execution shape before a run.
- Agent dispatch is bus/inbox first, with optional tasks for visibility.
- Workflow requests carry their own reply contract.

The dogfood upgrade plan is important because it turned live evidence into implementation requirements. It found that early dogfood behavior dispatched downstream calls before upstream results were available. Later source work added a waiting result path and auto-continuation on `workflow-reply`, but the current checkout still has some continuation gaps described below.

## Claude Native Workflow File Structure

Observed native Claude Code workflow artifacts follow this shape:

```text
~/.claude/projects/<project-id>/<session-id>/
  workflows/
    scripts/
      <workflow-name>-<run-id>.js
    <run-id>.json
  subagents/
    workflows/
      <run-id>/
        agent-<id>.jsonl
        agent-<id>.meta.json
```

Example inspected:

```text
~/.claude/projects/-Users-cortextos-cortextos-orgs-lifeos-agents-data/9b6527e3-0caf-43d6-bc95-3bcdad49ffe8/workflows/scripts/deep-research-wf_c33ae5ab-ad1.js
~/.claude/projects/-Users-cortextos-cortextos-orgs-lifeos-agents-data/9b6527e3-0caf-43d6-bc95-3bcdad49ffe8/workflows/wf_c33ae5ab-ad1.json
```

The workflow script includes:

- `export const meta = { name, description, whenToUse, phases }`
- Constants for agent counts, budgets, and verification thresholds.
- Inline JSON schemas as JavaScript objects.
- Prompt builder functions.
- Calls to runtime-provided globals: `phase`, `log`, `agent`, `parallel`, and `pipeline`.
- Normal JavaScript data shaping between agent calls.
- A final structured return object.

The run JSON includes these top-level keys:

```text
agentCount
args
defaultModel
durationMs
logs
phases
result
runId
script
scriptPath
startTime
status
summary
taskId
timestamp
totalTokens
totalToolCalls
workflowName
workflowProgress
```

In the inspected `deep-research` run, the native run record had:

- `workflowName`: `deep-research`
- `status`: `completed`
- `agentCount`: `106`
- `phaseCount`: `5`
- `workflowProgress` entries: `111`
- `totalTokens`: `2869000`
- `totalToolCalls`: `625`
- `durationMs`: `703678`

The per-subagent metadata files can be minimal. One inspected `.meta.json` only contained:

```json
{"agentType":"workflow-subagent"}
```

The per-subagent `.jsonl` files contain sidechain messages, tool calls, tool results, structured output calls, model metadata, token usage, timestamps, cwd, session id, git branch, and workflow attribution fields such as `attributionAgent` and `attributionSkill`.

## cortextOS Workflow Definition Structure

cortextOS workflow definitions use a package directory:

```text
orgs/<org>/workflows/<workflow-name>/
  workflow.js
  workflow.meta.json
  schemas/
    <result>.schema.json
  CHANGELOG.md
```

Templates use the same shape:

```text
templates/workflows/<workflow-name>/
  workflow.js
  workflow.meta.json
  schemas/
    <result>.schema.json
  CHANGELOG.md
```

The command resolver first checks the org workflow directory, then falls back to the template directory:

```text
orgs/<org>/workflows/<name>
templates/workflows/<name>
```

This means org-specific definitions override templates by name. The dashboard definition loader follows the same merge model: templates are loaded first, then org definitions override by workflow name.

## `workflow.meta.json` Contract

The canonical TypeScript type is `WorkflowDefinitionMeta`:

```ts
interface WorkflowDefinitionMeta {
  name: string
  description?: string
  version?: string
  status: 'draft' | 'validated' | 'approved' | 'production'
  phases: Array<{ title: string; detail?: string }>
  calls?: WorkflowCallDefinition[]
  defaultConcurrency?: number
  hardConcurrencyCap?: number
  maxIterations?: number
  changelogRequired?: boolean
}
```

Each call uses:

```ts
interface WorkflowCallDefinition {
  label: string
  target: string
  phase: string
  schema?: string
  sideEffects?: 'none' | 'external-comms' | 'deployment' | 'financial' | 'data-deletion' | 'other'
  createTask?: boolean
  retries?: number
  onFailure?: 'fail' | 'continue' | 'retry'
  timeoutMs?: number
}
```

Practical rules enforced by validation:

- `workflow.js` must exist.
- `workflow.meta.json` must exist.
- `workflow.js` must export human-readable workflow metadata, normally `export const meta = ...`.
- `workflow.js` should reference at least one workflow primitive. Missing primitive usage is a warning.
- `name` must use lowercase slug format.
- `status` must be one of `draft`, `validated`, `approved`, or `production`.
- At least one phase is required.
- Every call's `phase` must match a declared phase title.
- Production calls require schemas.
- Declared schema files must exist.
- `defaultConcurrency` must be a positive integer.
- `hardConcurrencyCap` must be between 1 and the system hard cap.
- `defaultConcurrency` cannot exceed `hardConcurrencyCap`.
- Production workflows require `CHANGELOG.md` unless `changelogRequired` is explicitly false.
- Agent targets are validated with the shared agent-name validator.

Defaults from the dry-run graph:

- `defaultConcurrency`: `4`
- `hardConcurrencyCap`: `8`
- call `sideEffects`: `none`
- call `createTask`: `false`
- call `retries`: `1`
- call `onFailure`: `retry`

Important nuance: these defaults are visible in dry-run output, but some policies such as retries and on-failure behavior are not fully implemented as runtime control flow in the current source. They are part of the contract and planning surface, not a complete execution engine yet.

## `workflow.js` Contract

The runner loads `workflow.js`, rewrites simple exports, and executes it inside a Node `vm` context. The context exposes only:

```text
args
meta
phase
log
agent
parallel
pipeline
```

The safe sandbox rejects workflow source that references:

- `require(...)`
- imports
- `process`
- filesystem modules or `fs`
- `child_process`, `exec`, or `spawn`
- network access through `fetch`, `http`, or `https`
- environment-like confidential configuration names

The design intent is that workflow JS coordinates only. Agents perform all actual reading, writing, shell work, network fetching, tool use, communication, and external side effects under their own normal permissions and guardrails.

cortextOS `agent()` has this shape:

```js
await agent(targetAgent, prompt, {
  label: 'call-label',
  phase: 'Phase Name',
  schema: 'schemas/result.schema.json',
  sideEffects: 'none',
  timeoutMs: 900000,
  createTask: false
})
```

This differs from native Claude workflow scripts, where observed calls often use:

```js
await agent(prompt, { label, phase, schema })
```

That signature difference matters for importers and reusable examples. Native Claude examples cannot be copied directly into cortextOS workflow definitions without adapting `agent()` calls to include a target agent.

## Runtime Run Structure

cortextOS workflow runs are stored under the instance state, not inside the source repo:

```text
~/.cortextos/<instance>/orgs/<org>/workflows/runs/<run-id>/
  run.json
  events.jsonl
  args.json
  dry-run.md
  result.json
  calls/
    <call-id>.json
    <call-id>.prompt.md
    <call-id>.request.md
    <call-id>.result.json
  audit/
    calls/
      <call-id>.audit.json
      <call-id>.audit.md
    transcripts/
      <call-id>.transcript.json
      <call-id>.transcript.md
      <call-id>.native.jsonl
```

The run record includes:

- run id
- workflow name
- org
- run status
- workflow definition path
- args path
- dry-run path
- result path
- current phase
- phase definitions
- call counts by status
- approval ids
- changelog version
- iteration count
- max iterations
- concurrency
- error
- timestamps

Call records include:

- call id
- run id
- target agent
- label
- phase
- call status
- prompt path
- rendered request path
- schema path
- result path
- audit path
- transcript paths
- transcript summary
- side-effect category
- approval id
- task id
- inbox message id
- retry count
- timestamps
- validation result
- error

Events are append-only JSONL records with ids, timestamps, event types, phase, call id, message, and optional metadata.

## CLI and Dashboard Surfaces

The CLI surface is implemented under `cortextos bus workflow`:

```bash
cortextos bus workflow validate <name>
cortextos bus workflow dry-run <name>
cortextos bus workflow run <name> --args <file> --timeout-ms <ms>
cortextos bus workflow continue <run-id> --timeout-ms <ms>
cortextos bus workflow status <run-id>
cortextos bus workflow list
cortextos bus workflow open <run-id>
cortextos bus workflow cancel <run-id> --reason <reason>
```

Agent calls complete through:

```bash
cortextos bus workflow-reply <call-id> <json-or-file>
cortextos bus workflow-reply <call-id> --reject <reason>
```

By default, `workflow-reply` tries to continue the owning workflow after accepting a successful reply. `--no-continue` disables that auto-continue behavior.

Dashboard APIs live under:

```text
dashboard/src/app/api/agent-workflows/definitions/route.ts
dashboard/src/app/api/agent-workflows/runs/route.ts
dashboard/src/app/api/agent-workflows/runs/[runId]/route.ts
dashboard/src/app/api/agent-workflows/runs/[runId]/actions/route.ts
```

Dashboard data is read from workflow definition metadata and durable run directories. It exposes run summaries, detailed events, calls, audits, and results.

## Prompt Construction Pattern

There are two prompt layers:

1. The workflow author's task prompt inside `workflow.js`.
2. The runtime request envelope rendered by `agent-dispatch.ts`.

The author prompt should be self-contained. Good template prompts include:

- Repository or artifact path.
- The specific task.
- Relevant upstream results, usually via `JSON.stringify(previousResult.data ?? previousResult, null, 2)`.
- Hard rules such as "do not merge", "do not deploy", "do not edit files", or "read only".
- Exact output expectations matching the schema.
- Stop conditions and risk boundaries.

The runtime wraps that prompt in a workflow request envelope:

```text
=== WORKFLOW REQUEST ===
run_id: <run-id>
call_id: <call-id>
workflow: <workflow-name>
phase: <phase>
label: <label>
schema_path: <schema-path-or-none>
side_effects: <side-effect-category>
allowed_actions: <allowed-actions>
timeout_ms: <timeout-or-none>
retry_count: <count>

<author prompt>

Reply using: cortextos bus workflow-reply <call-id> <absolute-result-json-path>
```

Allowed actions are derived from side effects:

- `none`: `read`, `analyze`, `write-result`
- non-`none`: `read`, `analyze`, `write-result`, `request-approval-before-side-effect`

This is the key participant contract. Target agents do not need to know the whole workflow runtime. They need to read the envelope, do the bounded work, write a schema-compliant JSON file, and call the exact reply command.

## Schema Pattern

Schemas are plain JSON Schema-like files under `schemas/`. Examples:

- review result: `status`, `verdict`, `summary`, `findings`
- fix result: `status`, `summary`, `filesChanged`, `testsRun`
- plan result: `status`, `summary`, `scope`, `verification`, `risks`, `stop_conditions`
- final result: workflow-specific synthesis and verification fields

The local validator supports a useful subset:

- `type`
- `enum`
- object `required`
- object `properties`
- array `items`

It does not fully enforce every JSON Schema feature. For example, source inspection shows no enforcement for `minItems`, `maxItems`, or `additionalProperties`. Native Claude workflow scripts often use inline schemas with those constraints, but cortextOS file schemas should not rely on unsupported constraints for correctness.

Practical authoring guidance:

- Always include `status` with values such as `completed`, `blocked`, and `failed`.
- Use `verdict` enums where the next workflow step branches on the result.
- Keep arrays of findings, risks, files, tests, and open questions simple.
- Prefer strings and arrays over deeply nested structures unless the workflow truly needs them.
- Make blocked states explicit so an agent can stop cleanly without inventing a malformed result.

## Reusable Local Examples

### `basic-review`

Path:

```text
templates/workflows/basic-review/
```

Pattern:

- One phase.
- One reviewer call.
- One review schema.
- No side effects.
- Good starter for read-only artifact review.

Useful for data-codex when a source, report, brief, or scraped artifact needs a single independent review pass.

### `pr-review-iteration`

Path:

```text
templates/workflows/pr-review-iteration/
```

Pattern:

- Initial review.
- Fix iteration.
- Re-review.
- Final verdict.
- `maxIterations` bound.
- Review result drives loop behavior.
- Explicit "do not merge or deploy" guardrail.

Useful as a model for any review/fix/re-review loop, including research QA, claim evaluation, and deliverable refinement.

### `software-development`

Path:

```text
templates/workflows/software-development/
```

Pattern:

- Plan.
- Implementation.
- Review.
- Fix.
- Synthesis.
- Agent names are configurable through `args`.
- Each step consumes prior structured results.
- Prompts include repo, request, plan, implementation, review, and fix context.

This is the best general-purpose multi-agent orchestration template in the current tree.

### `pr-review-iteration-dogfood`

Path:

```text
orgs/example/workflows/pr-review-iteration-dogfood/
```

Pattern:

- Claude-side reviewer via `skoolio`.
- Codex-side synthesis via `stephen`.
- Read-only artifact review.
- No repo modification, deploy, merge, Telegram, Supabase, or external systems.
- Good evidence of cross-runtime workflow dispatch.

This is the best local example of using a workflow as an audit-friendly dogfood harness.

### `deploy-smoke` and `continuation-smoke`

Paths:

```text
orgs/example/workflows/deploy-smoke/
orgs/example/workflows/continuation-smoke/
```

Pattern:

- Minimal single-call smoke tests.
- Fast schema-compliant reply expectations.
- Good for checking deployed command, dispatch, reply, and continuation paths.

### Native Claude `deep-research`

Path:

```text
~/.claude/projects/.../workflows/scripts/deep-research-wf_c33ae5ab-ad1.js
```

Pattern:

- Scope question into search angles.
- Fan out searchers.
- Deduplicate URLs.
- Fetch and extract claims.
- Run 3-vote adversarial verification.
- Synthesize a final report.

This is a strong methodology reference for data-codex research workflows, but it is not directly portable to cortextOS as-is. The native script uses Claude's `agent(prompt, options)` signature, inline schemas, and a pipeline form that differs from the current cortextOS runner.

## Data-codex Workflow Candidates From Local Patterns

The 2026-06-22 data-codex extraction doc identified three strong workflow candidates:

1. URL-to-briefing workflow.
2. Daily signal triage workflow.
3. Viral tool claim evaluator workflow.

These map cleanly onto cortextOS Workflows:

### URL-to-briefing

Likely phases:

- Intake.
- Fetch or scrape.
- Extract.
- Source-quality review.
- Brief synthesis.

Likely calls:

- `source-capture` to a scraping-capable data agent.
- `claim-extraction` to a research agent.
- `brief-synthesis` to data-codex or nick-facing writer.

Output schemas:

- source ledger
- claims
- caveats
- content angles
- saved artifact path

### Daily signal triage

Likely phases:

- Gather.
- Normalize.
- Score.
- Deduplicate.
- Route.

Likely calls:

- parallel source collectors
- scoring agent
- final brief agent

Output schemas:

- normalized signals
- zero-state classification
- ranking rationale
- selected items
- routing summary

### Viral tool claim evaluator

Likely phases:

- Claim capture.
- Source inspection.
- Bounded test plan.
- Replacement matrix.
- Verdict.

Likely calls:

- source verifier
- repo/doc inspector
- test runner agent
- synthesis agent

Output schemas:

- claimed capability
- verified capability
- test evidence
- replacement matrix
- adopt/reject/monitor recommendation

## Authoring Patterns That Match the Current Implementation

### Start From a Template

Use `basic-review` for one-call read-only review. Use `pr-review-iteration` for bounded review loops. Use `software-development` for plan/execute/review/fix/synthesize flows.

Do not author from a blank directory unless the workflow shape is truly novel.

### Keep `workflow.meta.json` and `workflow.js` Aligned

Every label used in `workflow.js` should appear in `workflow.meta.json` calls. Every phase used in `workflow.js` should appear in `workflow.meta.json` phases. The runtime can still execute dynamic calls, but the dry-run graph and dashboard are only as good as the metadata.

### Use Stable Labels

Use labels like:

- `implementation-plan`
- `source-capture`
- `claim-extraction`
- `review-pass`
- `fix-pass`
- `final-synthesis`

Avoid labels generated from long source titles, long claims, or volatile paths. Native Claude examples can use dynamic labels freely, but cortextOS continuation and stored-call replay are easier to reason about when labels are stable.

### Make Agent Prompts Stand Alone

A target agent receives the request envelope and prompt. It should not need to inspect `workflow.js`. Include paths, expected actions, relevant upstream JSON, and output requirements in the prompt.

### Treat Side Effects as Contract Fields

Use `sideEffects: "none"` for research, review, analysis, local result writing, and read-only source inspection. Use a non-`none` side-effect category only when the call might send external comms, deploy, spend money, delete data, or perform another gated action.

The current runtime advertises side-effect constraints and allowed actions in the request envelope. Agents still need to follow the approval protocol for actual side effects.

### Put Branching on Schema Fields

Branch on simple schema fields such as:

```js
if (review?.data?.verdict === 'pass') break
if (capture?.data?.status === 'blocked') return capture
```

Avoid branching on prose summaries. If the workflow needs a decision, put that decision in the schema.

### Use Phases as Operator Milestones

Call `phase()` at human-meaningful boundaries:

- Plan.
- Gather.
- Review.
- Fix.
- Synthesis.
- Result.

Do not call `phase()` for every small local transformation. Use `log()` for counts, verdicts, and brief progress notes.

### Use `parallel()` Only for Independent Work

Use `parallel()` for source collectors, independent reviewers, or independent verification votes. Do not parallelize calls when one prompt depends on a prior agent result.

### Keep Iteration Bounded

Use `maxIterations` in metadata and an `args.maxIterations` override in `workflow.js`. Every review/fix loop should have a hard stop.

### Keep Workflow JS Pure

The script should not read files, shell out, fetch URLs, or access confidential configuration. Put those tasks in agent prompts and let the target agent use its normal tools.

## Native Claude Patterns Worth Reusing Carefully

The native `deep-research` script is valuable because it shows effective research orchestration:

- Use a scoping agent to decompose work.
- Generate complementary search angles.
- Deduplicate at the coordinator level.
- Extract falsifiable claims instead of generic summaries.
- Verify claims adversarially with multiple independent votes.
- Require a quorum before claims survive.
- Synthesize only after verified evidence is assembled.
- Preserve refuted claims for transparency.

For cortextOS, reuse the methodology but adapt the mechanics:

- Put schemas in files, not inline JS objects.
- Add explicit target agents to `agent()` calls.
- Use the current cortextOS `parallel()` signature.
- Avoid native Claude `pipeline(items, stage1, stage2)` unless the cortextOS runner is extended to support it.
- Use stable labels and metadata calls for dry-run visibility.

## Gaps and Risks

### Native Claude and cortextOS Primitive Mismatch

Native Claude examples use `agent(prompt, options)`. cortextOS uses `agent(target, prompt, options)`.

Native Claude examples can use `pipeline(items, stage1, stage2, ...)`. The current cortextOS runner implements `pipeline(items)` where `items` is an array of thunk functions. The authoring skill says `pipeline([fn, fn])`, which matches the current source more closely than the native `deep-research` script.

This mismatch blocks direct import of native Claude workflows.

### Dry-run Is Metadata-driven, Not Static Code Analysis

The dry-run graph is built from `workflow.meta.json`, not from parsed `workflow.js`. If metadata omits a dynamic call or declares a call that code never uses, validation does not catch the mismatch.

Practical result: authors must keep metadata and code aligned manually, and reviewers should compare labels/phases between both files.

### Sandbox Inspection Is Regex-based

The sandbox rejects forbidden source patterns with regular expressions. This is useful but not a full JavaScript security parser. It can produce false positives on innocent strings and false negatives on unusual syntax.

For production, AST-based validation would be stronger.

### JSON Schema Support Is Partial

The schema validator supports basic type, enum, required, properties, and array item validation. It does not enforce many JSON Schema features that native Claude examples use, such as item counts and additional-property rules.

For now, schemas should keep required correctness in the supported subset.

### Retry and Failure Policy Are Under-enforced

`retries`, `onFailure`, and `timeoutMs` are declared in metadata and shown in dry-run output. `timeoutMs` is included in the request envelope. Current source inspection did not show a complete runtime retry engine that automatically retries failed calls according to metadata.

Treat these fields as part of the intended contract and operator visibility, not as fully reliable execution semantics yet.

### Side-effect Approvals Are Declared More Than Enforced

Side-effect categories drive dry-run approval points and allowed actions in request envelopes. The runtime does not appear to create approval records automatically for side-effecting calls. Instead, target agents are told to request approval before side effects.

This is acceptable for internal read-only workflows, but production side-effecting workflows need stronger runtime enforcement.

### Continuation Is Improved but Still Needs Review

Current source has a waiting result path: when an agent call is dispatched, the runner can return `status: "waiting"`, persist the open call, and continue after `workflow-reply`.

However, the run status enum in the inspected `types.ts` does not include `waiting`; open calls leave the run as `running`. The stored-call resolver matches completed calls by target, phase, and label. That can be ambiguous if a loop repeats the same label in the same phase.

The Stephen upgrade note describes a stronger stable identity model using `phase::label::ordinal` and `call_key`, but those fields were not present in the inspected current `WorkflowCallRecord` type. Verify the deployed runtime before relying on repeated same-label loops.

### Result Markdown Is Not Fully Wired

Run types include `result_md_path`, and design docs mention final markdown outputs, but the current command path writes `result.json`. Markdown final output appears to be an intended surface rather than a complete standard output path.

### Dashboard Is Read-only by Design

Dashboard surfaces list definitions, runs, events, calls, audits, and details. The MVP design intentionally deferred full controls such as pause, resume, cancel buttons, and a visual editor. Some API action routes exist, but authoring and operations remain CLI-first.

### No Native Claude Importer

The roadmap mentions a Claude workflow importer, but source inspection did not find one. Any native Claude workflow reuse currently requires manual translation.

## Recommended Spec Pattern for Future data-codex Workflows

Use this package shape:

```text
orgs/lifeos/workflows/<workflow-name>/
  workflow.js
  workflow.meta.json
  schemas/
    intake-result.schema.json
    extraction-result.schema.json
    review-result.schema.json
    final-result.schema.json
  CHANGELOG.md
```

Use this metadata pattern:

```json
{
  "name": "url-to-briefing",
  "description": "Capture a URL, extract claims, review source quality, and produce a source-backed briefing.",
  "version": "0.1.0",
  "status": "draft",
  "phases": [
    { "title": "Intake", "detail": "Normalize input and scope the source." },
    { "title": "Capture", "detail": "Fetch, scrape, or transcribe the source." },
    { "title": "Extract", "detail": "Extract claims, caveats, and reusable angles." },
    { "title": "Review", "detail": "Check source quality and evidence risk." },
    { "title": "Synthesis", "detail": "Write the final briefing output." }
  ],
  "defaultConcurrency": 2,
  "hardConcurrencyCap": 4,
  "maxIterations": 1,
  "calls": [
    {
      "label": "source-capture",
      "target": "data-codex",
      "phase": "Capture",
      "schema": "schemas/capture-result.schema.json",
      "sideEffects": "none",
      "retries": 1,
      "onFailure": "fail",
      "timeoutMs": 900000
    },
    {
      "label": "claim-extraction",
      "target": "data-codex",
      "phase": "Extract",
      "schema": "schemas/extraction-result.schema.json",
      "sideEffects": "none",
      "retries": 1,
      "onFailure": "fail",
      "timeoutMs": 900000
    },
    {
      "label": "final-brief",
      "target": "data-codex",
      "phase": "Synthesis",
      "schema": "schemas/final-result.schema.json",
      "sideEffects": "none",
      "retries": 1,
      "onFailure": "fail",
      "timeoutMs": 900000
    }
  ],
  "changelogRequired": true
}
```

Use this `workflow.js` style:

```js
export const meta = { name: 'url-to-briefing' }

const url = args.url
const requestedBy = args.requestedBy ?? 'operator'

phase('Capture', 'Fetch or scrape the source')
const capture = await agent('data-codex', `Capture this source for briefing.

URL: ${url}
Requested by: ${requestedBy}

Rules:
- Prefer primary source text where available.
- If scraping fails, return a blocked result with the reason.
- Do not send external messages.
- Return JSON matching the capture schema.`, {
  label: 'source-capture',
  phase: 'Capture',
  schema: 'schemas/capture-result.schema.json',
  sideEffects: 'none',
})

phase('Extract', 'Extract claims and content angles')
const extraction = await agent('data-codex', `Extract reusable claims and angles from the captured source.

Capture result:
${JSON.stringify(capture.data ?? capture, null, 2)}

Return falsifiable claims, caveats, source-quality notes, and content angles.`, {
  label: 'claim-extraction',
  phase: 'Extract',
  schema: 'schemas/extraction-result.schema.json',
  sideEffects: 'none',
})

phase('Synthesis', 'Write the final briefing')
const final = await agent('data-codex', `Create the final source-backed briefing.

Capture:
${JSON.stringify(capture.data ?? capture, null, 2)}

Extraction:
${JSON.stringify(extraction.data ?? extraction, null, 2)}

Return a concise briefing, source ledger, confidence notes, and open questions.`, {
  label: 'final-brief',
  phase: 'Synthesis',
  schema: 'schemas/final-result.schema.json',
  sideEffects: 'none',
})

return {
  status: 'completed',
  capture,
  extraction,
  final,
}
```

## Checklist for Authoring or Reviewing a Workflow Spec

- The workflow directory has `workflow.js`, `workflow.meta.json`, `schemas/`, and `CHANGELOG.md` if production.
- `workflow.meta.json` status is honest: start at `draft`.
- Every `phase()` call exists in metadata.
- Every `agent()` label has a metadata call.
- Every production call has a schema file.
- Every prompt includes enough context for the target agent.
- Every prompt says what not to do.
- Side effects are explicitly declared.
- Non-read-only side effects have an approval plan.
- Loops have `maxIterations`.
- Dynamic labels are avoided unless there is a strong reason.
- Parallel calls are independent.
- Prior result JSON is passed into downstream prompts when needed.
- Output schemas use only locally enforced JSON Schema features.
- `cortextos bus workflow validate <name>` passes.
- `cortextos bus workflow dry-run <name>` is reviewed before running.
- The workflow has a clear operator-facing success, blocked, and failed state.

## Bottom Line

Claude Code native Workflows provide the methodology: script-owned orchestration, structured subagent calls, fan-out, pipeline stages, verification loops, and compact final synthesis.

cortextOS Workflows provide the local production path: org-level reusable workflow packages, safe JS coordination, persistent agent dispatch, workflow request envelopes, JSON schema replies, durable run records, audit packets, transcript capture, and dashboard visibility.

For data-codex, the practical next step is not to import native Claude scripts wholesale. It is to translate the best native patterns into cortextOS packages using the local `workflow.meta.json` plus `workflow.js` plus `schemas/` structure, starting with read-only workflows such as URL-to-briefing, daily signal triage, and viral tool claim evaluator.
