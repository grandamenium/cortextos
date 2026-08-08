import { readdirSync, readFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
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
  decision: 'keep' | 'discard' | null;
  learning: string;
  experiment_commit: string | null;
  tracking_commit: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  changes_description: string | null;
  /**
   * Set by the G1 zero-delta gate when an evaluation is the Nth consecutive
   * flat (non-improving) window on the same surface. Optional/back-compat:
   * absent on experiments created before the gate and on non-triggering ones.
   */
  guardrail_note?: string | null;
  /**
   * Set by the G3 baseline-drift detector when recent results on the surface
   * cluster within DRIFT_DELTA of the baseline for DRIFT_WINDOW+ windows.
   * Advisory only — never changes the decision or the baseline. Optional/
   * back-compat: absent on non-triggering evaluations.
   */
  drift_note?: string | null;
}

export interface ExperimentCreateOptions {
  surface?: string;
  direction?: 'higher' | 'lower';
  window?: string;
  measurement?: string;
  approval_required?: boolean;
  /** Explicit starting baseline. Defaults to 0. See suggestBaselineFromSurface. */
  baseline?: number;
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

function loadExperiment(agentDir: string, experimentId: string): Experiment {
  const filePath = join(historyDir(agentDir), `${experimentId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Experiment ${experimentId} not found`);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8').trim());
}

function saveExperiment(agentDir: string, experiment: Experiment): void {
  const dir = historyDir(agentDir);
  ensureDir(dir);
  atomicWriteSync(join(dir, `${experiment.id}.json`), JSON.stringify(experiment, null, 2));
}

/**
 * G1 zero-delta gate limit: number of consecutive flat (non-improving) windows
 * on the same surface that forces the surface to be abandoned. Per the
 * autoresearch skill's zero-delta rule ("result <= baseline for the SAME
 * surface change 3 windows in a row — discard and re-hypothesize").
 */
export const ZERO_DELTA_GATE_LIMIT = 3;

/**
 * Count how many of the most-recent CONSECUTIVE completed experiments on the
 * given surface ended in 'discard' (a flat / non-improving window). A 'keep'
 * breaks the streak — the skill's rule is explicitly about not chaining keeps
 * on flat results, so any real improvement resets the counter. Ordered by
 * completion time (newest first) so the streak reflects recent history, not
 * creation order. Returns 0 for an empty surface (cannot group).
 */
function countConsecutiveFlatOnSurface(
  agentDir: string,
  surface: string,
  excludeId: string,
): number {
  if (!surface) return 0;
  const completed = listExperiments(agentDir, { status: 'completed' })
    .filter((e) => e.surface === surface && e.id !== excludeId)
    .sort(
      (a, b) =>
        new Date(b.completed_at ?? b.created_at).getTime() -
        new Date(a.completed_at ?? a.created_at).getTime(),
    );
  let streak = 0;
  for (const e of completed) {
    if (e.decision === 'discard') streak++;
    else break;
  }
  return streak;
}

/**
 * G3 baseline-drift parameters. A run of DRIFT_WINDOW+ recent windows whose
 * results all sit within DRIFT_DELTA of the current baseline means the metric
 * is stuck — the baseline is pegged and no longer discriminating. Calibrated
 * for 1-10 qualitative scores (±1). Detection is advisory only.
 */
export const DRIFT_DELTA = 1;
export const DRIFT_WINDOW = 5;

/** Median of a numeric list (average of the two middle values for even n). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * G3 create-time helper: suggest a starting baseline for a new experiment on
 * a surface as the median of the last 5 completed results on that surface (or
 * all of them if fewer than 5). Median — not min — so a single outlier window
 * does not drag the floor. Returns null when the surface has no prior results,
 * so the caller can fall back to the default baseline of 0.
 */
export function suggestBaselineFromSurface(
  agentDir: string,
  surface: string,
): number | null {
  if (!surface) return null;
  const results = listExperiments(agentDir, { status: 'completed' })
    .filter((e) => e.surface === surface && typeof e.result_value === 'number')
    .sort(
      (a, b) =>
        new Date(b.completed_at ?? b.created_at).getTime() -
        new Date(a.completed_at ?? a.created_at).getTime(),
    )
    .slice(0, 5)
    .map((e) => e.result_value as number);
  if (results.length === 0) return null;
  return median(results);
}

/**
 * G3 evaluate-time helper: detect baseline drift. Counts, newest-first, how
 * many recent windows on the surface (the current result plus prior completed
 * results) sit within DRIFT_DELTA of the reference baseline in an unbroken run.
 * Returns the run length; the caller warns when it reaches DRIFT_WINDOW.
 */
function driftRunLength(
  agentDir: string,
  surface: string,
  excludeId: string,
  currentResult: number,
  baselineRef: number,
): number {
  if (!surface) return 0;
  const priorResults = listExperiments(agentDir, { status: 'completed' })
    .filter(
      (e) =>
        e.surface === surface &&
        e.id !== excludeId &&
        typeof e.result_value === 'number',
    )
    .sort(
      (a, b) =>
        new Date(b.completed_at ?? b.created_at).getTime() -
        new Date(a.completed_at ?? a.created_at).getTime(),
    )
    .map((e) => e.result_value as number);
  const sequence = [currentResult, ...priorResults];
  let run = 0;
  for (const v of sequence) {
    if (Math.abs(v - baselineRef) <= DRIFT_DELTA) run++;
    else break;
  }
  return run;
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
    baseline_value: options?.baseline ?? 0,
    result_value: null,
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
 * Evaluate a running experiment with a measured value.
 */
export function evaluateExperiment(
  agentDir: string,
  experimentId: string,
  measuredValue: number,
  options?: ExperimentEvaluateOptions,
): Experiment {
  const experiment = loadExperiment(agentDir, experimentId);

  if (experiment.status !== 'running') {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'running'`);
  }

  // Compare measured vs baseline using direction
  let decision: 'keep' | 'discard';
  if (experiment.direction === 'higher') {
    decision = measuredValue > experiment.baseline_value ? 'keep' : 'discard';
  } else {
    decision = measuredValue < experiment.baseline_value ? 'keep' : 'discard';
  }

  experiment.status = 'completed';
  experiment.completed_at = nowISO();
  experiment.result_value = measuredValue;
  experiment.decision = decision;

  // For qualitative metrics: if score is provided, use it as the measured value
  // (agent passes 0 as placeholder measuredValue and --score 7 as the actual value)
  if (options?.score !== undefined) {
    measuredValue = options.score;
    // Re-evaluate decision with the correct measured value
    if (experiment.direction === 'higher') {
      decision = measuredValue > experiment.baseline_value ? 'keep' : 'discard';
    } else {
      decision = measuredValue < experiment.baseline_value ? 'keep' : 'discard';
    }
    experiment.result_value = measuredValue;
    experiment.decision = decision;
  }

  // G1 zero-delta gate: if this is a flat (non-improving) window and the same
  // surface already produced ZERO_DELTA_GATE_LIMIT-1 consecutive flat windows,
  // the surface is exhausted. Force discard (belt-and-suspenders: a flat result
  // already discards) and record a tamper-proof re-hypothesize note in the
  // learning so the agent cannot keep chaining experiments on a dead surface.
  let guardrailNote: string | null = null;
  if (decision === 'discard' && experiment.surface) {
    const priorFlat = countConsecutiveFlatOnSurface(
      agentDir,
      experiment.surface,
      experiment.id,
    );
    if (priorFlat + 1 >= ZERO_DELTA_GATE_LIMIT) {
      decision = 'discard';
      experiment.decision = 'discard';
      guardrailNote =
        `G1 zero-delta gate: ${priorFlat + 1} consecutive flat windows on surface ` +
        `'${experiment.surface}' — metric not moving. Abandon this surface and ` +
        `re-hypothesize with a materially different change; do not keep chaining.`;
      experiment.guardrail_note = guardrailNote;
    }
  }

  // G3 baseline-drift detector (advisory only — never changes the decision or
  // the baseline; baseline stays ground truth). If recent windows on the
  // surface cluster within DRIFT_DELTA of the baseline for DRIFT_WINDOW+ in a
  // row, the baseline is pegged and no longer discriminating — warn so the
  // agent closes the cycle and re-creates with a fresh baseline.
  let driftNote: string | null = null;
  if (experiment.surface) {
    const baselineRef = experiment.baseline_value;
    const run = driftRunLength(
      agentDir,
      experiment.surface,
      experiment.id,
      measuredValue,
      baselineRef,
    );
    if (run >= DRIFT_WINDOW) {
      driftNote =
        `baseline drift suspected: results stuck at ${baselineRef} ± ${DRIFT_DELTA} for ` +
        `${run} windows on surface '${experiment.surface}'; consider closing this cycle ` +
        `and re-creating with baseline=${baselineRef}.`;
      experiment.drift_note = driftNote;
    }
  }

  // Build learning from options
  const learningParts: string[] = [];
  if (options?.learning) learningParts.push(options.learning);
  if (options?.justification) learningParts.push(options.justification);
  if (guardrailNote) learningParts.push(`⚠ ${guardrailNote}`);
  if (driftNote) learningParts.push(`⚠ ${driftNote}`);
  if (learningParts.length > 0) {
    experiment.learning = learningParts.join(' — ');
  }

  // If keep, baseline becomes the measured value
  if (decision === 'keep') {
    experiment.baseline_value = measuredValue;
  }

  saveExperiment(agentDir, experiment);

  // Append to results.tsv
  const expDir = join(agentDir, 'experiments');
  ensureDir(expDir);
  const tsvPath = join(expDir, 'results.tsv');
  if (!existsSync(tsvPath)) {
    appendFileSync(
      tsvPath,
      'experiment_id\tagent\tmetric\tmeasured_value\tbaseline\tdecision\thypothesis\ttimestamp\n',
      'utf-8',
    );
  }
  const tsvLine = [
    experiment.id,
    experiment.agent,
    experiment.metric,
    String(measuredValue),
    String(decision === 'keep' ? measuredValue : experiment.baseline_value),
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
  const learningEntry = [
    `## ${experiment.id} (${decision})`,
    `- **Metric:** ${experiment.metric}`,
    `- **Hypothesis:** ${experiment.hypothesis}`,
    `- **Result:** ${measuredValue} (baseline: ${decision === 'keep' ? measuredValue : experiment.baseline_value})`,
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
      experiments.push(JSON.parse(content));
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
