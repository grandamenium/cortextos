export const meta = {
  name: 'dynamic-pipeline',
  description: 'Explore (parallel, read-only) -> plan (single, high-reasoning decompose) -> implement (parallel, worktree-isolated) -> merge (deterministic) -> review (single, high-effort, loops back to implement) -> PR',
  whenToUse: 'A non-trivial coding task worth decomposing into non-conflicting workstreams and implementing in parallel with a high-effort review gate before opening a PR. Pass the task via args.',
  phases: [
    { title: 'Explore', detail: 'N parallel read-only scans routed via routing-config.json (default: OpenRouter Gemini)' },
    { title: 'Plan', detail: 'single plan stage with Fable opt-in gate; decline fallback defaults to Opus' },
    { title: 'Implement', detail: 'one worktree-isolated worker per workstream, in parallel (default: Codex)' },
    { title: 'Merge', detail: 'deterministic git merge of all workstream branches into one candidate branch (default: Haiku)' },
    { title: 'Review', detail: 'one high-effort review of the merged diff; always Anthropic Opus', model: 'opus' },
    { title: 'PR', detail: 'open a PR from the final candidate branch (default: Sonnet)' },
  ],
}

const runtimeBridgeModule = await import('./lib/runtime-bridge.js')
const routingPolicyModule = await import('./lib/routing-policy.js')
const lessonProfileModule = await import('./lib/lesson-profile.js')
const { execFileSync } = await import('node:child_process')
const { existsSync, mkdirSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')

const { sendWork } = runtimeBridgeModule.default ?? runtimeBridgeModule
const { buildAnthropicAgentOptions, loadRoutingConfig, resolveStageRoute } =
  routingPolicyModule.default ?? routingPolicyModule
const { upsertLesson, topLessons } = lessonProfileModule.default ?? lessonProfileModule

// ----------------------------------------------------------------------------
// ARGS  (all optional except task)
//   task              - what to build/fix (string, required)
//   repoPath          - absolute path to the target git repo (default: session cwd)
//   exploreCount      - how many parallel explorers (default 3)
//   maxWorkstreams    - cap on decomposed workstreams (default 6)
//   maxReviewLoops    - implement/merge/review iterations before giving up (default 2)
//   baseBranch        - branch to cut from and PR into (default 'main')
//   candidateBranch   - the merged integration branch (default 'wf/candidate')
//   routingConfigPath - optional alternate routing JSON path
//   confirmFable      - optional stub hook input; true/yes enables Fable at Plan
// ----------------------------------------------------------------------------
const A = args || {}
const task = A.task || 'NO TASK PROVIDED — pass args.task when invoking this workflow'
const repoPath = A.repoPath || '.'
const exploreCount = A.exploreCount || 3
const maxWorkstreams = A.maxWorkstreams || 6
const maxReviewLoops = A.maxReviewLoops || 2
const baseBranch = A.baseBranch || 'main'
const candidateBranch = A.candidateBranch || 'wf/candidate'
const routingConfigPath = A.routingConfigPath || '.claude/workflows/routing-config.json'
const routingConfig = loadRoutingConfig(routingConfigPath, { cwd: repoPath, log })

function isFableConfirmed() {
  return A.confirmFable === true || A.confirmFable === 'true' || A.confirmFable === 'yes'
}

function stageRoute(stageName) {
  return resolveStageRoute(routingConfig, stageName, {
    confirmFableUse: () => isFableConfirmed(),
  })
}

async function executeStage(stageName, prompt, baseOpts, bridgeOpts = {}) {
  if (stageName === 'plan') {
    const lessonsBlock = topLessons(20)
    if (lessonsBlock) {
      prompt =
        `LESSONS PROFILE — recurring failure modes from prior runs. Your plan MUST NOT repeat these:\n` +
        `${lessonsBlock}\n---\n\n` + prompt
    }
  }

  const route = stageRoute(stageName)
  if (route.provider === 'anthropic') {
    return agent(prompt, buildAnthropicAgentOptions(baseOpts, route))
  }

  return sendWork({
    provider: route.provider,
    model: route.model,
    prompt,
    schema: baseOpts.schema,
    effort: route.effort,
    cwd: bridgeOpts.cwd || repoPath,
    allowWrite: bridgeOpts.allowWrite === true,
  })
}

function slugifyBranch(branch) {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function runGit(args, cwd = repoPath) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function prepareImplementWorktree(branch, baseRef) {
  const worktreeRoot = join(repoPath, '.claude', 'workflow-worktrees')
  mkdirSync(worktreeRoot, { recursive: true })
  const worktreePath = join(worktreeRoot, slugifyBranch(branch))

  if (existsSync(worktreePath)) {
    try {
      runGit(['worktree', 'remove', '--force', worktreePath])
    } catch {
      // Best-effort stale cleanup only.
    }
    rmSync(worktreePath, { recursive: true, force: true })
  }

  try {
    runGit(['branch', '-D', branch])
  } catch {
    // Branch may not exist yet.
  }

  runGit(['worktree', 'add', '--force', '-B', branch, worktreePath, baseRef])
  return worktreePath
}

// ----------------------------------------------------------------------------
// SCHEMAS — force structured output so stages hand clean data to the next stage
// ----------------------------------------------------------------------------
const EXPLORE_SCHEMA = {
  type: 'object',
  required: ['summary', 'relevantFiles'],
  properties: {
    summary: { type: 'string', description: 'What this area of the codebase does, relative to the task' },
    relevantFiles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'why'],
        properties: {
          path: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    conventions: { type: 'array', items: { type: 'string' }, description: 'Patterns/idioms to match' },
    risks: { type: 'array', items: { type: 'string' }, description: 'Gotchas, coupling, things that could break' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['approach', 'workstreams'],
  properties: {
    approach: { type: 'string', description: 'One-paragraph implementation strategy' },
    workstreams: {
      type: 'array',
      description: 'Independent chunks that DO NOT touch the same files, so they can run in parallel',
      items: {
        type: 'object',
        required: ['id', 'title', 'instructions', 'files'],
        properties: {
          id: { type: 'string', description: 'short kebab id, e.g. "auth-mw"' },
          title: { type: 'string' },
          instructions: { type: 'string', description: 'Precise, self-contained build instructions for one agent' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files this workstream owns (must not overlap others)' },
          acceptance: { type: 'string', description: 'How to know this workstream is done' },
        },
      },
    },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['id', 'branch', 'committed', 'summary'],
  properties: {
    id: { type: 'string' },
    branch: { type: 'string', description: 'The branch this worktree committed to' },
    committed: { type: 'boolean', description: 'true if changes were committed to the branch' },
    summary: { type: 'string', description: 'What changed' },
    filesChanged: { type: 'array', items: { type: 'string' } },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['candidateBranch', 'mergedBranches', 'conflicts'],
  properties: {
    candidateBranch: { type: 'string' },
    mergedBranches: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'Branches/files that conflicted (empty = clean)' },
    buildPassed: { type: 'boolean' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['approved', 'problems'],
  properties: {
    approved: { type: 'boolean', description: 'true = ship it, no real problems' },
    problems: {
      type: 'array',
      description: 'Real correctness/design problems only. Each maps to the workstream that must fix it.',
      items: {
        type: 'object',
        required: ['workstreamId', 'issue', 'fix'],
        properties: {
          workstreamId: { type: 'string', description: 'id of the workstream that owns the fix' },
          issue: { type: 'string' },
          fix: { type: 'string', description: 'What the implement agent should change' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
      },
    },
  },
}

const PR_SCHEMA = {
  type: 'object',
  required: ['opened', 'url'],
  properties: {
    opened: { type: 'boolean' },
    url: { type: 'string' },
    title: { type: 'string' },
  },
}

// ----------------------------------------------------------------------------
// STAGE 1 — EXPLORE (parallel, read-only). No shared state, no locking.
// ----------------------------------------------------------------------------
phase('Explore')
const reports = (await parallel(
  Array.from({ length: exploreCount }, (_, i) => () =>
    executeStage(
      'explore',
      `You are EXPLORER #${i + 1} of ${exploreCount}. READ-ONLY — do not edit anything.\n` +
      `Repo: ${repoPath}\n\n` +
      `TASK CONTEXT (what we are about to build/fix):\n${task}\n\n` +
      `Independently scan the codebase and report the context most relevant to this task: ` +
      `which files matter and why, the conventions/idioms to match, and the risks. ` +
      `You are one of ${exploreCount} independent explorers — do not assume the others found what you found; be thorough on your own.`,
      { label: `explore-${i + 1}`, phase: 'Explore', schema: EXPLORE_SCHEMA },
    )
  ),
)).filter(Boolean)

log(`Explore complete: ${reports.length}/${exploreCount} reports`)

// ----------------------------------------------------------------------------
// STAGE 2 — PLANNING. Decompose into non-conflicting workstreams.
// ----------------------------------------------------------------------------
phase('Plan')
const plan = await executeStage(
  'plan',
  `You are the PLANNER. Read the ${reports.length} independent explore reports below and produce ONE ` +
  `implementation plan for this task, decomposed into independent workstreams.\n\n` +
  `TASK:\n${task}\n\n` +
  `EXPLORE REPORTS (JSON):\n${JSON.stringify(reports, null, 2)}\n\n` +
  `HARD REQUIREMENT: workstreams must be file-disjoint — no two workstreams may edit the same file — ` +
  `so they can be implemented in parallel git worktrees without conflicting. ` +
  `Cap at ${maxWorkstreams} workstreams. Each workstream must be self-contained with precise instructions.`,
  { phase: 'Plan', schema: PLAN_SCHEMA },
)

let workstreams = plan.workstreams.slice(0, maxWorkstreams).map((workstream) => ({ ...workstream, feedback: null }))
log(`Plan: ${workstreams.length} workstreams — ${workstreams.map((workstream) => workstream.id).join(', ')}`)

// ----------------------------------------------------------------------------
// STAGES 3-5 — IMPLEMENT -> MERGE -> REVIEW, looping back to IMPLEMENT while
// the reviewer finds real problems, up to maxReviewLoops.
// ----------------------------------------------------------------------------
let review = null
let lastMerge = null

for (let loop = 1; loop <= maxReviewLoops; loop++) {
  const isFix = loop > 1
  log(`--- iteration ${loop}/${maxReviewLoops}${isFix ? ' (fix loop)' : ''} ---`)

  const toBuild = isFix ? workstreams.filter((workstream) => workstream.feedback) : workstreams
  const impls = (await parallel(
    toBuild.map((workstream) => () => {
      const branch = `wf/ws-${workstream.id}`
      const baseRef = isFix ? candidateBranch : baseBranch
      const prompt =
        `You are the IMPLEMENTER for workstream "${workstream.id}" — ${workstream.title}.\n` +
        `Repo: ${repoPath}. You are in your OWN git worktree; other workstreams run in parallel.\n\n` +
        `Base your branch on "${baseRef}". Create/switch to branch "${branch}".\n\n` +
        `INSTRUCTIONS:\n${workstream.instructions}\n\n` +
        `FILES YOU OWN (stay within these — do not touch other workstreams' files):\n${(workstream.files || []).join('\n')}\n\n` +
        `ACCEPTANCE:\n${workstream.acceptance || 'Implements the instructions above and builds cleanly.'}\n\n` +
        (workstream.feedback
          ? `REVIEW FEEDBACK TO FIX (this is a fix loop — address exactly this):\n${workstream.feedback}\n\n`
          : '') +
        `When done, COMMIT your changes to branch "${branch}" with a clear message, then return the branch name. ` +
        `If you made no changes, return committed:false.`

      const route = stageRoute('implement')
      if (route.provider === 'anthropic') {
        return agent(
          prompt,
          buildAnthropicAgentOptions(
            { label: `impl-${workstream.id}`, phase: 'Implement', isolation: 'worktree', schema: IMPL_SCHEMA },
            route,
          ),
        )
      }

      const worktreePath = prepareImplementWorktree(branch, baseRef)
      return sendWork({
        provider: route.provider,
        model: route.model,
        prompt,
        schema: IMPL_SCHEMA,
        cwd: worktreePath,
        effort: route.effort,
        allowWrite: true,
      })
    }),
  )).filter(Boolean)

  const branches = impls.filter((result) => result.committed).map((result) => result.branch)
  log(`Implemented: ${branches.length} branch(es) — ${branches.join(', ') || '(none committed)'}`)

  lastMerge = await executeStage(
    'merge',
    `You are the MERGER. Deterministic git only — do not edit code to resolve logic, only mechanical merges.\n` +
    `Repo: ${repoPath}.\n\n` +
    (isFix
      ? `The candidate branch "${candidateBranch}" already exists. Merge these fix branches into it: ${JSON.stringify(branches)}.\n`
      : `Create branch "${candidateBranch}" from "${baseBranch}", then merge these workstream branches into it in order: ${JSON.stringify(branches)}.\n`) +
    `Because workstreams were planned to be file-disjoint, merges should be clean. ` +
    `Report any conflicts (branch + files) rather than guessing a resolution. ` +
    `After merging, run the project build/typecheck if there is one and report whether it passed.`,
    { label: 'merge', phase: 'Merge', schema: MERGE_SCHEMA },
  )
  log(`Merge -> ${lastMerge.candidateBranch}; conflicts: ${lastMerge.conflicts.length ? lastMerge.conflicts.join(', ') : 'none'}; build: ${lastMerge.buildPassed ? 'pass' : 'unknown/fail'}`)

  review = await executeStage(
    'review',
    `You are the REVIEWER. High-effort review of the merged candidate branch "${candidateBranch}" vs "${baseBranch}".\n` +
    `Repo: ${repoPath}.\n\n` +
    `ORIGINAL TASK:\n${task}\n\n` +
    `Read the full merged diff (e.g. \`git diff ${baseBranch}...${candidateBranch}\`). ` +
    `Flag only REAL correctness or design problems — not nits. For each problem, name the workstream id that owns the fix ` +
    `(valid ids: ${workstreams.map((workstream) => workstream.id).join(', ')}) so it can be routed back to Implement. ` +
    `If there are no real problems, set approved:true.`,
    { label: 'review', phase: 'Review', schema: REVIEW_SCHEMA },
  )

  if (review.approved || review.problems.length === 0) {
    log(`Review APPROVED on iteration ${loop}`)
    break
  }

  if (loop === maxReviewLoops) {
    log(`Review still found ${review.problems.length} problem(s) after ${maxReviewLoops} iterations — stopping loop, PR will note this`)
    break
  }

  const problemsByWorkstream = {}
  for (const problem of review.problems) {
    ;(problemsByWorkstream[problem.workstreamId] = problemsByWorkstream[problem.workstreamId] || []).push(
      `[${problem.severity || 'issue'}] ${problem.issue}\n  FIX: ${problem.fix}`,
    )
  }
  workstreams = workstreams.map((workstream) => ({
    ...workstream,
    feedback: problemsByWorkstream[workstream.id] ? problemsByWorkstream[workstream.id].join('\n') : null,
  }))
  log(`Looping back to Implement for: ${Object.keys(problemsByWorkstream).join(', ')}`)
}

phase('PR')
const unresolved = review && !review.approved ? review.problems : []
const pr = await executeStage(
  'pr',
  `You are the PR agent. Open a pull request from "${candidateBranch}" into "${baseBranch}" using \`gh pr create\`.\n` +
  `Repo: ${repoPath}.\n\n` +
  `TASK:\n${task}\n\n` +
  `PLAN SUMMARY:\n${plan.approach}\n\n` +
  `Write a clear title and a body summarizing the workstreams (${workstreams.map((workstream) => workstream.id).join(', ')}) and what changed.\n` +
  (unresolved.length
    ? `NOTE IN THE PR BODY: ${unresolved.length} review problem(s) remained unresolved after ${maxReviewLoops} iterations:\n` +
      unresolved.map((problem) => `- [${problem.severity || 'issue'}] (${problem.workstreamId}) ${problem.issue}`).join('\n') + '\n'
    : 'The reviewer approved the merged diff.\n') +
  'Do NOT merge the PR — just open it and return the URL.',
  { label: 'open-pr', phase: 'PR', schema: PR_SCHEMA },
)

phase('Lessons')
const lessons = await executeStage(
  'lessons',
  `You are the LESSONS agent. Reflect on THIS pipeline run for task:\n${task}\n\n` +
  `Review outcome: ${JSON.stringify(review)}\nMerge: ${JSON.stringify(lastMerge)}\n\n` +
  `If (and ONLY if) this run produced a NON-OBVIOUS, reusable lesson — a failure and its fix, a gotcha, or a durable standard worth remembering — write ONE lesson per file to ` +
  `/Users/joshweiss/code/knowledge-sync/lessons/<kebab-slug>.md. Each file: a title, a dated Context, the Lesson, and How-to-apply — short and genuinely reusable. ` +
  `Do NOT write filler or restate the task; if there is no real lesson, write nothing. Return the list of lesson file paths written (empty if none). ` +
  `For EACH lesson file you write, ALSO return a matching oneLiner: {domain, lesson} — a <=140-char imperative rule.`,
  {
    label: 'lessons',
    phase: 'Lessons',
    schema: {
      type: 'object',
      required: ['lessonFiles'],
      properties: {
        lessonFiles: { type: 'array', items: { type: 'string' } },
        oneLiners: {
          type: 'array',
          items: {
            type: 'object',
            required: ['domain', 'lesson'],
            properties: {
              domain: { type: 'string' },
              lesson: { type: 'string', description: 'imperative rule, <=140 chars' },
            },
          },
        },
      },
    },
  },
)

for (const [i, lesson] of (lessons.oneLiners || []).entries()) {
  try {
    upsertLesson({
      domain: lesson.domain,
      text: lesson.lesson,
      source: (lessons.lessonFiles || [])[i] || 'pipeline-run',
    })
  } catch (error) {
    log(`lesson-profile upsert failed (non-fatal): ${error}`)
  }
}

return {
  task,
  workstreams: workstreams.map((workstream) => ({ id: workstream.id, title: workstream.title })),
  merge: lastMerge,
  review,
  pr,
  lessons,
}
