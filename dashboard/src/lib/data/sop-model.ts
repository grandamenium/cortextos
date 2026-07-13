// Pure SOP document types + derivation logic (shard U1). No fs/network
// access here on purpose: this module is imported by client components
// (sop-step-card.tsx etc.), so it must never pull node:fs into the browser
// bundle. The server-only fixture/API reads live in sops.ts, which imports
// from here.

// ---------------------------------------------------------------------------
// Types (match the plan's confirmed SOP shape, section 1.1 / Part 4 contract)
// ---------------------------------------------------------------------------

export type SopStepKind = 'agent_task' | 'human_review' | 'human_approval' | 'system_handoff';

/**
 * Display classification. Until backend shard B1 backfills a real
 * `action_type` field onto every step, we derive one for display (see
 * classifyStep below). Once a step carries a real `action_type`, that value
 * wins over the derivation.
 */
export type SopDisplayActionType =
  | 'internal'
  | 'gate'
  | 'handoff'
  | 'external_comm'
  | 'money_movement'
  | 'legal_action'
  | 'system_write';

/** The GATED set (plan section 3.1): render amber + shield, require a gate. */
export const GATED_ACTION_TYPES: readonly SopDisplayActionType[] = [
  'external_comm',
  'money_movement',
  'legal_action',
  'system_write',
];

export function isGatedActionType(actionType: SopDisplayActionType): boolean {
  return (GATED_ACTION_TYPES as readonly string[]).includes(actionType);
}

/**
 * ROLE_AGENT_MAP (plan section 1.2, confirmed-from-code): the engine's known
 * assigned_role values. human/pm/owner intentionally map to null (never
 * auto-dispatched, not a mapping gap). Any other role value is unmapped —
 * the engine blocks dispatch on it today ("No agent mapping").
 */
const KNOWN_ROLES = new Set([
  'maintenance',
  'leasing',
  'accounting',
  'operations',
  'human', 'pm', 'owner',
]);

export function isUnmappedRole(role: string): boolean {
  return !KNOWN_ROLES.has(role);
}

export interface SopStep {
  task_key: string;
  title: string;
  kind: SopStepKind;
  assigned_role: string;
  is_automated: boolean;
  instructions: string;
  depends_on: string[];
  can_parallel?: boolean;
  estimated_minutes?: number;
  dispatch_title?: string;
  dispatch_body?: string;
  human_prompt?: string;
  /** Real field once backend shard B1 lands. Absent in today's fixtures. */
  action_type?: SopDisplayActionType;
}

export interface SopStage {
  stage_key: string;
  name: string;
  description: string;
  steps: SopStep[];
}

export interface SopDocument {
  slug: string;
  name: string;
  description: string;
  subject_type: string;
  default_start_stage_key: string;
  captured_at: string;
  stages: SopStage[];
}

export interface SopVersionEntry {
  id: string;
  updated_at: string;
  updated_by: string;
  change_note: string;
}

export interface SopIndexRow {
  slug: string;
  name: string;
  description: string;
  subject_type: string;
  stage_count: number;
  task_count: number;
  gated_step_count: number;
  /** No-gate violation count (Part 4 gate-map honesty: a GATED step with no
   *  upstream human_approval ancestor). Always 0 across a valid corpus. */
  ungated_violation_count: number;
  /** Placeholder for the real drift endpoint (plan section 5.1, not merged
   *  yet). Sourced from fixture metadata so the UI's drift chip/stat can be
   *  exercised honestly today; wire to the real drift report on swap. */
  drift_detected: boolean;
  involved_roles: string[];
  has_unmapped_role: boolean;
  is_synthetic_demo: boolean;
}

// ---------------------------------------------------------------------------
// Derivation (Part 4 keystone contract)
// ---------------------------------------------------------------------------

/**
 * Display action_type derivation. Honors a real `action_type` when present
 * (post-B1). Otherwise derives from `kind` per the plan's mapping:
 * human_review/human_approval -> 'gate'; system_handoff -> 'handoff';
 * agent_task -> 'internal' (default; never fabricates a GATED class).
 */
export function classifyStep(step: SopStep): SopDisplayActionType {
  if (step.action_type) return step.action_type;
  if (step.kind === 'human_review' || step.kind === 'human_approval') return 'gate';
  if (step.kind === 'system_handoff') return 'handoff';
  return 'internal';
}

export interface StepDisplayInfo {
  actionType: SopDisplayActionType;
  gated: boolean;
  /** true for a step whose depends_on matches the simple linear chain. */
  isChainStep: boolean;
  /** Nearest upstream human_approval task_key in the transitive closure of
   *  depends_on, only meaningful for gated steps. Null = no gate found. */
  nearestGateTaskKey: string | null;
  nearestGateTitle: string | null;
}

/** Flat step index across the whole SOP: task_key -> step + stage index + step index. */
interface FlatStep {
  step: SopStep;
  stageIndex: number;
  stepIndex: number;
}

function flattenSteps(sop: SopDocument): Map<string, FlatStep> {
  const map = new Map<string, FlatStep>();
  sop.stages.forEach((stage, stageIndex) => {
    stage.steps.forEach((step, stepIndex) => {
      map.set(step.task_key, { step, stageIndex, stepIndex });
    });
  });
  return map;
}

/**
 * Chain-vs-custom detection (plan section 4.0), per step, no stored flag.
 * A step is "simple chain" if its depends_on is exactly [previous step in
 * its stage], or for the first step of a (non-first) stage,
 * [last step of the previous stage]. The first step of the first stage is
 * chain iff it has no dependencies. Anything else -> custom.
 */
export function isSimpleChainStep(sop: SopDocument, stageIndex: number, stepIndex: number): boolean {
  const stage = sop.stages[stageIndex];
  const step = stage.steps[stepIndex];
  const deps = step.depends_on ?? [];

  let expected: string[];
  if (stepIndex > 0) {
    expected = [stage.steps[stepIndex - 1].task_key];
  } else if (stageIndex > 0) {
    const prevStage = sop.stages[stageIndex - 1];
    const prevLastStep = prevStage.steps[prevStage.steps.length - 1];
    expected = prevLastStep ? [prevLastStep.task_key] : [];
  } else {
    expected = [];
  }

  if (deps.length !== expected.length) return false;
  return deps.every((d, i) => d === expected[i]);
}

/**
 * Gate-map (plan section 3.4/Part 4): for a GATED step, find the nearest
 * human_approval step in the transitive closure of depends_on via BFS. If
 * none exists, this is a violation state — U1 renders it honestly as a red
 * "no gate" chip rather than hiding it (U2 is where the validator blocks it).
 */
export function findNearestGate(sop: SopDocument, taskKey: string): FlatStep | null {
  const flat = flattenSteps(sop);
  const visited = new Set<string>([taskKey]);
  let frontier = [...(flat.get(taskKey)?.step.depends_on ?? [])];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const key of frontier) {
      if (visited.has(key)) continue;
      visited.add(key);
      const entry = flat.get(key);
      if (!entry) continue;
      if (entry.step.kind === 'human_approval') return entry;
      next.push(...(entry.step.depends_on ?? []));
    }
    frontier = next;
  }
  return null;
}

export function describeStep(sop: SopDocument, stageIndex: number, stepIndex: number): StepDisplayInfo {
  const step = sop.stages[stageIndex].steps[stepIndex];
  const actionType = classifyStep(step);
  const gated = isGatedActionType(actionType);
  const gate = gated ? findNearestGate(sop, step.task_key) : null;
  return {
    actionType,
    gated,
    isChainStep: isSimpleChainStep(sop, stageIndex, stepIndex),
    nearestGateTaskKey: gate?.step.task_key ?? null,
    nearestGateTitle: gate?.step.title ?? null,
  };
}

export function countGatedSteps(sop: SopDocument): number {
  let count = 0;
  for (const stage of sop.stages) {
    for (const step of stage.steps) {
      if (isGatedActionType(classifyStep(step))) count += 1;
    }
  }
  return count;
}

export function countUngatedViolations(sop: SopDocument): number {
  let count = 0;
  for (const stage of sop.stages) {
    for (const step of stage.steps) {
      if (isGatedActionType(classifyStep(step)) && !findNearestGate(sop, step.task_key)) {
        count += 1;
      }
    }
  }
  return count;
}

export function involvedRoles(sop: SopDocument): string[] {
  const roles = new Set<string>();
  for (const stage of sop.stages) {
    for (const step of stage.steps) roles.add(step.assigned_role);
  }
  return [...roles].sort();
}
