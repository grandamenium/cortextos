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
  // Set when the experiment transitions to running. measurement_end =
  // measurement_start + parsed window. evaluateExperiment soft-warns
  // (does not fail) when called before measurement_end. Both are null
  // until runExperiment runs; legacy experiment files written before
  // this field existed load with these as undefined and are tolerated.
  measurement_start: string | null;
  measurement_end: string | null;
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

/**
 * Parse a duration string (e.g. "72h", "30m", "7d") into milliseconds.
 * Returns null when the input doesn't match a known shape — callers
 * should leave the derived end-time field null in that case rather
 * than guess a wrong window.
 */
function parseWindowMs(window: string): number | null {
  const m = window.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const ms: Record<string, number> = {
    s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 604_800_000, wk: 604_800_000, wks: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  };
  const mult = ms[unit];
  if (mult === undefined) return null;
  return n * mult;
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

  const experiment: Experiment = {
    id,
    agent: agentName,
    metric,
    hypothesis,
    surface: options?.surface || '',
    direction: options?.direction || 'higher',
    window: options?.window || '24h',
    measurement: options?.measurement || '',
    status: 'proposed',
    baseline_value: 0,
    result_value: null,
    decision: null,
    learning: '',
    experiment_commit: null,
    tracking_commit: null,
    created_at: nowISO(),
    started_at: null,
    completed_at: null,
    changes_description: null,
    measurement_start: null,
    measurement_end: null,
  };

  saveExperiment(agentDir, experiment);

  return id;
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
  experiment.measurement_start = experiment.started_at;

  // measurement_end = start + parsed window. When the window string
  // can't be parsed we leave measurement_end null and warn — better
  // than committing a wrong end-time that downstream queries trust.
  const windowMs = parseWindowMs(experiment.window);
  if (windowMs != null) {
    const endIso = new Date(Date.now() + windowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    experiment.measurement_end = endIso;
  } else {
    experiment.measurement_end = null;
    console.warn(
      `[experiment] Could not parse window "${experiment.window}" for ${experiment.id}; measurement_end left null`,
    );
  }

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

  // Soft-warn (don't fail) when evaluating before the measurement
  // window has closed — the agent may want to short-circuit on
  // dramatic results, or the window estimate may be wrong. Skip the
  // check when measurement_end is missing (legacy rows or unparseable
  // window) so old experiments stay evaluatable.
  if (experiment.measurement_end) {
    const endMs = new Date(experiment.measurement_end).getTime();
    if (!Number.isNaN(endMs) && Date.now() < endMs) {
      const remainingMin = Math.ceil((endMs - Date.now()) / 60_000);
      console.warn(
        `[experiment] Evaluating ${experimentId} ${remainingMin}m before measurement_end (${experiment.measurement_end}); proceeding anyway.`,
      );
    }
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

  // Build learning from options
  const learningParts: string[] = [];
  if (options?.learning) learningParts.push(options.learning);
  if (options?.justification) learningParts.push(options.justification);
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
