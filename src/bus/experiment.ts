import { readdirSync, readFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withRetry, isTransientError } from '../utils/retry.js';
import { randomString } from '../utils/random.js';

// --- Types ---

export interface Experiment {
  id: string;
  agent: string;
  metric: string;
  hypothesis: string;
  surface: string;
  direction: 'higher' | 'lower';
  window: string;
  measurement: string;
  status: 'proposed' | 'running' | 'completed';
  baseline_value: number;
  result_value: number | null;
  score: number | null;
  decision: 'keep' | 'discard' | null;
  learning: string;
  experiment_commit: string | null;
  tracking_commit: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  changes_description: string | null;
  /** UUID assigned by orch_experiments on first sync. Stored here to enable PATCH on subsequent state changes. */
  orch_id?: string;
}

export interface ExperimentCreateOptions {
  surface?: string;
  direction?: 'higher' | 'lower';
  window?: string;
  measurement?: string;
  approval_required?: boolean;
}

export interface ExperimentEvaluateOptions {
  learning?: string;
  score?: number;
  justification?: string;
}

export interface ExperimentFilters {
  status?: string;
  metric?: string;
  agent?: string;
}

export interface GatherContextOptions {
  format?: 'json' | 'markdown';
}

export interface ExperimentContext {
  agent: string;
  total_experiments: number;
  keeps: number;
  discards: number;
  keep_rate: number;
  learnings: string;
  results_tsv: string;
  identity: string;
  goals: string;
}

export interface ExperimentCycle {
  name: string;
  agent: string;
  metric: string;
  metric_type: 'quantitative' | 'qualitative';
  surface: string;
  direction: 'higher' | 'lower';
  window: string;
  measurement: string;
  loop_interval: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
}

export interface ExperimentConfig {
  approval_required?: boolean;
  cycles?: ExperimentCycle[];
  theta_wave?: {
    enabled?: boolean;
    interval?: string;
    metric?: string;
    metric_type?: string;
    direction?: string;
    auto_create_agent_cycles?: boolean;
    auto_modify_agent_cycles?: boolean;
  };
  monitoring?: Record<string, unknown>;
}

// --- Helpers ---

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function historyDir(agentDir: string): string {
  return join(agentDir, 'experiments', 'history');
}

export function loadExperiment(agentDir: string, experimentId: string): Experiment {
  const filePath = join(historyDir(agentDir), `${experimentId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Experiment ${experimentId} not found`);
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8').trim()) as Experiment & {
    score?: number | null;
  };
  if (!('score' in parsed) || parsed.score === undefined) {
    parsed.score = null;
  }
  return parsed;
}

function saveExperiment(agentDir: string, experiment: Experiment): void {
  const dir = historyDir(agentDir);
  ensureDir(dir);
  atomicWriteSync(join(dir, `${experiment.id}.json`), JSON.stringify(experiment, null, 2));
}

export function loadExperimentConfig(agentDir: string): ExperimentConfig {
  return loadConfig(agentDir);
}

function loadConfig(agentDir: string): ExperimentConfig {
  const configPath = join(agentDir, 'experiments', 'config.json');
  if (!existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, 'utf-8').trim());
}

function saveConfig(agentDir: string, config: ExperimentConfig): void {
  const dir = join(agentDir, 'experiments');
  ensureDir(dir);
  atomicWriteSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

// --- Public API ---

/**
 * Create a new experiment proposal.
 *
 * Fields with no explicit option fall back to the matching cycle in
 * `experiments/config.json` (same metric + same agent) before using the
 * static default. The autoresearch skill registers its measurement method,
 * direction, window, and surface once in the cycle config; with the cycle
 * fallback, repeat experiments on that metric stop losing the measurement
 * description because the agent forgot to pass --measurement.
 * Explicit options always win over the cycle so ad-hoc overrides still work.
 */
export function createExperiment(
  agentDir: string,
  agentName: string,
  metric: string,
  hypothesis: string,
  options?: ExperimentCreateOptions,
): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const id = `exp_${epoch}_${rand}`;

  const cycleDefaults = findCycleDefaults(agentDir, agentName, metric);

  const experiment: Experiment = {
    id,
    agent: agentName,
    metric,
    hypothesis,
    surface: options?.surface ?? cycleDefaults.surface ?? '',
    direction: options?.direction ?? cycleDefaults.direction ?? 'higher',
    window: options?.window ?? cycleDefaults.window ?? '24h',
    measurement: options?.measurement ?? cycleDefaults.measurement ?? '',
    status: 'proposed',
    baseline_value: 0,
    result_value: null,
    score: null,
    decision: null,
    learning: '',
    experiment_commit: null,
    tracking_commit: null,
    created_at: nowISO(),
    started_at: null,
    completed_at: null,
    changes_description: null,
  };

  saveExperiment(agentDir, experiment);

  return id;
}

/**
 * Look up cycle-level defaults for a new experiment on the given metric.
 * Matches a cycle by metric + agent. Returns an empty object if no cycle
 * is configured — createExperiment then falls through to its static
 * defaults. Best-effort: any config-read error returns empty so the
 * experiment create path never breaks on malformed config.
 */
function findCycleDefaults(
  agentDir: string,
  agentName: string,
  metric: string,
): Partial<Pick<ExperimentCreateOptions, 'surface' | 'direction' | 'window' | 'measurement'>> {
  try {
    const config = loadConfig(agentDir);
    const cycle = config.cycles?.find(
      (c) => c.metric === metric && c.agent === agentName,
    );
    if (!cycle) return {};
    return {
      surface: cycle.surface || undefined,
      direction: cycle.direction || undefined,
      window: cycle.window || undefined,
      measurement: cycle.measurement || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Start running a proposed experiment.
 */
export function runExperiment(
  agentDir: string,
  experimentId: string,
  changesDescription?: string,
): Experiment {
  const experiment = loadExperiment(agentDir, experimentId);

  if (experiment.status !== 'proposed') {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'proposed'`);
  }

  experiment.status = 'running';
  experiment.started_at = nowISO();
  if (changesDescription) {
    experiment.changes_description = changesDescription;
  }

  saveExperiment(agentDir, experiment);

  // Write active.json
  const activeDir = join(agentDir, 'experiments');
  ensureDir(activeDir);
  atomicWriteSync(join(activeDir, 'active.json'), JSON.stringify(experiment, null, 2));

  return experiment;
}

/**
 * Evaluate a running experiment with a measured value and/or a 1-10 score.
 *
 * Quantitative metrics pass `measuredValue` (the real number). Qualitative
 * metrics pass `undefined` for `measuredValue` and supply `options.score`,
 * in which case the score doubles as the result value for keep/discard.
 * At least one of the two must be defined.
 */
export function evaluateExperiment(
  agentDir: string,
  experimentId: string,
  measuredValue: number | undefined,
  options?: ExperimentEvaluateOptions,
): Experiment {
  const experiment = loadExperiment(agentDir, experimentId);

  if (experiment.status !== 'running') {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'running'`);
  }

  const score = options?.score;
  if (measuredValue === undefined && score === undefined) {
    throw new Error(
      `Experiment ${experimentId} evaluate needs a measured value or --score (received neither)`,
    );
  }

  // Qualitative metrics pass only --score; the score then stands in for the
  // measured value too so decision logic has a number to compare.
  const effectiveValue = measuredValue ?? (score as number);

  // Compare effectiveValue vs baseline using direction
  let decision: 'keep' | 'discard';
  if (experiment.direction === 'higher') {
    decision = effectiveValue > experiment.baseline_value ? 'keep' : 'discard';
  } else {
    decision = effectiveValue < experiment.baseline_value ? 'keep' : 'discard';
  }

  experiment.status = 'completed';
  experiment.completed_at = nowISO();
  experiment.result_value = effectiveValue;
  experiment.decision = decision;

  // --score is a 1-10 rubric stored in its own field. It is preserved even
  // when a separate quantitative measured value was also provided.
  if (score !== undefined) {
    experiment.score = score;
  }

  // Build learning from options
  const learningParts: string[] = [];
  if (options?.learning) learningParts.push(options.learning);
  if (options?.justification) learningParts.push(options.justification);
  if (learningParts.length > 0) {
    experiment.learning = learningParts.join(' — ');
  }

  // If keep, baseline becomes the effective value so subsequent runs compare
  // against the new bar.
  if (decision === 'keep') {
    experiment.baseline_value = effectiveValue;
  }

  saveExperiment(agentDir, experiment);

  // Append to results.tsv
  const expDir = join(agentDir, 'experiments');
  ensureDir(expDir);
  const tsvPath = join(expDir, 'results.tsv');
  if (!existsSync(tsvPath)) {
    appendFileSync(
      tsvPath,
      'experiment_id\tagent\tmetric\tmeasured_value\tscore\tbaseline\tdecision\thypothesis\ttimestamp\n',
      'utf-8',
    );
  }
  const tsvLine = [
    experiment.id,
    experiment.agent,
    experiment.metric,
    String(effectiveValue),
    experiment.score === null || experiment.score === undefined ? '' : String(experiment.score),
    String(decision === 'keep' ? effectiveValue : experiment.baseline_value),
    decision,
    experiment.hypothesis,
    experiment.completed_at,
  ].join('\t');
  appendFileSync(tsvPath, tsvLine + '\n', 'utf-8');

  // Append to learnings.md
  const learningsPath = join(expDir, 'learnings.md');
  if (!existsSync(learningsPath)) {
    appendFileSync(learningsPath, '# Experiment Learnings\n\n', 'utf-8');
  }
  const scoreLine =
    experiment.score !== null && experiment.score !== undefined
      ? `- **Score:** ${experiment.score}/10`
      : '';
  const learningEntry = [
    `## ${experiment.id} (${decision})`,
    `- **Metric:** ${experiment.metric}`,
    `- **Hypothesis:** ${experiment.hypothesis}`,
    `- **Result:** ${effectiveValue} (baseline: ${decision === 'keep' ? effectiveValue : experiment.baseline_value})`,
    scoreLine,
    experiment.learning ? `- **Learning:** ${experiment.learning}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  appendFileSync(learningsPath, learningEntry + '\n', 'utf-8');

  // Remove active.json
  const activePath = join(expDir, 'active.json');
  if (existsSync(activePath)) {
    try {
      unlinkSync(activePath);
    } catch {
      // ignore
    }
  }

  return experiment;
}

/**
 * List experiments with optional filters.
 */
export function listExperiments(
  agentDir: string,
  filters?: ExperimentFilters,
): Experiment[] {
  const dir = historyDir(agentDir);
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  let experiments: Experiment[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8').trim();
      const parsed = JSON.parse(content) as Experiment & { score?: number | null };
      if (!('score' in parsed) || parsed.score === undefined) {
        parsed.score = null;
      }
      experiments.push(parsed);
    } catch {
      // skip corrupt files
    }
  }

  if (filters?.status) {
    experiments = experiments.filter(e => e.status === filters.status);
  }
  if (filters?.metric) {
    experiments = experiments.filter(e => e.metric === filters.metric);
  }
  if (filters?.agent) {
    experiments = experiments.filter(e => e.agent === filters.agent);
  }

  // Sort by created_at desc
  experiments.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return experiments;
}

/**
 * Gather experiment context for an agent: learnings, stats, identity, goals.
 */
export function gatherContext(
  agentDir: string,
  agentName: string,
  _options?: GatherContextOptions,
): ExperimentContext {
  const expDir = join(agentDir, 'experiments');

  // Read learnings
  const learningsPath = join(expDir, 'learnings.md');
  const learnings = existsSync(learningsPath) ? readFileSync(learningsPath, 'utf-8') : '';

  // Read results TSV
  const tsvPath = join(expDir, 'results.tsv');
  const resultsTsv = existsSync(tsvPath) ? readFileSync(tsvPath, 'utf-8') : '';

  // Calculate stats from history
  const all = listExperiments(agentDir);
  const completed = all.filter(e => e.status === 'completed');
  const keeps = completed.filter(e => e.decision === 'keep').length;
  const discards = completed.filter(e => e.decision === 'discard').length;
  const total = all.length;
  const keepRate = completed.length > 0 ? keeps / completed.length : 0;

  // Read agent IDENTITY.md and GOALS.md
  const identityPath = join(agentDir, 'IDENTITY.md');
  const identity = existsSync(identityPath) ? readFileSync(identityPath, 'utf-8') : '';

  const goalsPath = join(agentDir, 'GOALS.md');
  const goals = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : '';

  return {
    agent: agentName,
    total_experiments: total,
    keeps,
    discards,
    keep_rate: keepRate,
    learnings,
    results_tsv: resultsTsv,
    identity,
    goals,
  };
}

/**
 * Manage experiment cycles in config.json.
 */
export function manageCycle(
  agentDir: string,
  action: 'create' | 'modify' | 'remove' | 'list',
  options: {
    agent?: string;
    name?: string;
    metric?: string;
    metric_type?: 'quantitative' | 'qualitative';
    surface?: string;
    direction?: 'higher' | 'lower';
    window?: string;
    measurement?: string;
    loop_interval?: string;
    enabled?: boolean;
  },
): ExperimentCycle[] {
  const config = loadConfig(agentDir);
  if (!config.cycles) {
    config.cycles = [];
  }

  switch (action) {
    case 'create': {
      if (!options.name || !options.agent || !options.metric) {
        throw new Error('Cycle create requires name, agent, and metric');
      }
      const cycle: ExperimentCycle = {
        name: options.name,
        agent: options.agent,
        metric: options.metric,
        metric_type: options.metric_type || 'qualitative',
        surface: options.surface || '',
        direction: options.direction || 'higher',
        window: options.window || '24h',
        measurement: options.measurement || '',
        loop_interval: options.loop_interval || options.window || '24h',
        enabled: true,
        created_by: options.agent,
        created_at: nowISO(),
      };
      config.cycles.push(cycle);
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'modify': {
      if (!options.name) {
        throw new Error('Cycle modify requires name');
      }
      const idx = config.cycles.findIndex(c => c.name === options.name);
      if (idx === -1) {
        throw new Error(`Cycle '${options.name}' not found`);
      }
      if (options.metric) config.cycles[idx].metric = options.metric;
      if (options.metric_type) config.cycles[idx].metric_type = options.metric_type;
      if (options.surface) config.cycles[idx].surface = options.surface;
      if (options.direction) config.cycles[idx].direction = options.direction;
      if (options.enabled !== undefined) config.cycles[idx].enabled = options.enabled;
      if (options.window) config.cycles[idx].window = options.window;
      if (options.measurement) config.cycles[idx].measurement = options.measurement;
      if (options.loop_interval) config.cycles[idx].loop_interval = options.loop_interval;
      if (options.agent) config.cycles[idx].agent = options.agent;
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'remove': {
      if (!options.name) {
        throw new Error('Cycle remove requires name');
      }
      const removeIdx = config.cycles.findIndex(c => c.name === options.name);
      if (removeIdx === -1) {
        throw new Error(`Cycle '${options.name}' not found`);
      }
      config.cycles.splice(removeIdx, 1);
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'list': {
      // When an agent filter is supplied, return only that agent's cycles.
      // Omitting the agent returns the full list (back-compat for callers
      // that explicitly want a global view).
      if (options.agent) {
        return config.cycles.filter((c) => c.agent === options.agent);
      }
      return config.cycles;
    }

    default:
      throw new Error(`Unknown cycle action: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Supabase sync — non-blocking, fail-open
// ---------------------------------------------------------------------------

// orch_approvals.org_id is a UUID FK to organizations.id (RevOps Global).
const REVOPS_ORG_UUID =
  process.env.SUPABASE_RGOS_ORG_UUID || 'a1b2c3d4-0000-0000-0000-000000000001';
// Approvals expire if not decided within 14 days.
const APPROVAL_TTL_MS = 14 * 24 * 3600 * 1000;

/**
 * Create a paired orch_approvals row for a proposed experiment.
 * Returns the approval UUID, or null on failure (non-fatal).
 *
 * Must mirror the shape used by orch-experiment-proposer so the Approvals UI
 * renders identically regardless of which path created the experiment.
 */
async function createApprovalRow(
  supabaseUrl: string,
  serviceKey: string,
  experiment: Experiment,
): Promise<string | null> {
  const headers: Record<string, string> = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const body = JSON.stringify({
    org_id: REVOPS_ORG_UUID,
    type: 'orch_experiment',
    status: 'pending',
    context: {
      task_title: experiment.hypothesis.split('\n')[0].slice(0, 120),
      source: 'cortextos-bus',
      proposed_by: experiment.agent,
      hypothesis: experiment.hypothesis,
      method: experiment.measurement || `${experiment.metric} via ${experiment.surface}`,
      success_criteria: `${experiment.metric} (${experiment.direction}) — ${experiment.surface || 'general'}`,
      token_budget: 0,
    },
    expires_at: expiresAt,
  });
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/orch_approvals`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const rows = await res.json() as Array<{ id: string }>;
      return rows?.[0]?.id ?? null;
    }
  } catch {
    // Non-fatal — experiment will sync without an approval_id and stay stuck
    // in proposed forever. Caller logs nothing; the experiment row will be
    // visible in the dashboard as a signal that the approval path is broken.
  }
  return null;
}

/**
 * Sync a local Experiment to the orch_experiments table.
 * - If experiment.orch_id is set: PATCH that row (UPDATE).
 * - Otherwise: INSERT and store the returned UUID as orch_id in the local file.
 *   For proposed experiments, a paired orch_approvals row is created first so
 *   the trg_approve_experiment trigger can promote status → approved when Greg
 *   approves via the dashboard. Without this, approval_id is null and the
 *   experiment is permanently stuck in proposed.
 * Always non-blocking: errors are logged but never thrown.
 *
 * Mapping:
 *   hypothesis        → hypothesis
 *   measurement/surface → method
 *   metric+direction  → success_criteria
 *   agent             → proposed_by
 *   status            → status
 *   baseline_value, result_value, decision, learning → results_json
 */
export async function syncExperimentToSupabase(
  experiment: Experiment,
  agentDir: string,
): Promise<void> {
  const url = process.env.SUPABASE_RGOS_URL || process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return; // no credentials — silently skip

  const base = `${url}/rest/v1/orch_experiments`;
  const headers: Record<string, string> = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  const payload: Record<string, unknown> = {
    org_id: 'revops-global',
    hypothesis: experiment.hypothesis,
    method: experiment.measurement || `${experiment.metric} via ${experiment.surface}`,
    proposed_by: experiment.agent,
    success_criteria: `${experiment.metric} (${experiment.direction}) — ${experiment.surface || 'general'}`,
    // orch_experiments uses 'complete' not 'completed' (check constraint)
    status: experiment.status === 'completed' ? 'complete' : experiment.status,
    started_at: experiment.started_at ?? undefined,
    completed_at: experiment.completed_at ?? undefined,
    results_json: {
      metric: experiment.metric,
      direction: experiment.direction,
      baseline: experiment.baseline_value,
      result: experiment.result_value,
      decision: experiment.decision,
      learning: experiment.learning,
      local_id: experiment.id,
    },
    token_budget: 0,
    tokens_used: 0,
  };

  try {
    if (experiment.orch_id) {
      // PATCH existing row — idempotent, safe to retry
      await withRetry(
        () => fetch(`${base}?id=eq.${encodeURIComponent(experiment.orch_id!)}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        }),
        { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000, isRetryable: isTransientError },
      );
    } else {
      // New experiment INSERT.
      // For proposed experiments: create the orch_approvals row first so the
      // DB trigger (trg_approve_experiment) has an approval_id to fire on.
      // Skip for running/completed experiments — they were already approved
      // (or ran locally without the approval gate).
      if (experiment.status === 'proposed') {
        const approvalId = await createApprovalRow(url, key, experiment);
        if (approvalId) {
          payload.approval_id = approvalId;
        }
      }

      // INSERT and capture the UUID — 1 retry only (non-idempotent; duplicate risk on retry)
      const res = await withRetry(
        () => fetch(base, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        }),
        { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000, isRetryable: isTransientError },
      );
      if (res.ok) {
        const rows = await res.json() as Array<{ id: string }>;
        const orchId = rows?.[0]?.id;
        if (orchId) {
          // Store orch_id back in the local experiment file
          const updated = { ...experiment, orch_id: orchId };
          saveExperiment(agentDir, updated);
        }
      }
    }
  } catch {
    // Silently fail — local operation already succeeded
  }
}

/**
 * Bulk-sync all local experiments for an agent to orch_experiments.
 * Skips any already synced (orch_id present). Returns counts.
 */
export async function syncAllExperimentsToSupabase(
  agentDir: string,
): Promise<{ synced: number; skipped: number; errors: number }> {
  const dir = historyDir(agentDir);
  if (!existsSync(dir)) return { synced: 0, skipped: 0, errors: 0 };

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const exp = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Experiment;
      if (exp.orch_id) {
        skipped++;
        continue;
      }
      await syncExperimentToSupabase(exp, agentDir);
      synced++;
    } catch {
      errors++;
    }
  }

  return { synced, skipped, errors };
}
