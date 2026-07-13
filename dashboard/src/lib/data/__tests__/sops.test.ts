import { describe, expect, it } from 'vitest';
import {
  classifyStep,
  isGatedActionType,
  isSimpleChainStep,
  findNearestGate,
  describeStep,
  isUnmappedRole,
  getSopIndex,
  getSop,
  type SopDocument,
  type SopStep,
} from '../sops';

function baseStep(overrides: Partial<SopStep>): SopStep {
  return {
    task_key: 'x',
    title: 'X',
    kind: 'agent_task',
    assigned_role: 'operations',
    is_automated: true,
    instructions: 'do x',
    depends_on: [],
    ...overrides,
  };
}

describe('classifyStep', () => {
  it('derives gate from human_review and human_approval kinds', () => {
    expect(classifyStep(baseStep({ kind: 'human_review' }))).toBe('gate');
    expect(classifyStep(baseStep({ kind: 'human_approval' }))).toBe('gate');
  });

  it('derives handoff from system_handoff kind', () => {
    expect(classifyStep(baseStep({ kind: 'system_handoff' }))).toBe('handoff');
  });

  it('derives internal from agent_task by default (never fabricates a GATED class)', () => {
    expect(classifyStep(baseStep({ kind: 'agent_task' }))).toBe('internal');
  });

  it('honors an explicit action_type over derivation (post-B1 forward compat)', () => {
    expect(classifyStep(baseStep({ kind: 'agent_task', action_type: 'external_comm' }))).toBe('external_comm');
  });
});

describe('isGatedActionType', () => {
  it('flags exactly the GATED set', () => {
    expect(isGatedActionType('external_comm')).toBe(true);
    expect(isGatedActionType('money_movement')).toBe(true);
    expect(isGatedActionType('legal_action')).toBe(true);
    expect(isGatedActionType('system_write')).toBe(true);
    expect(isGatedActionType('internal')).toBe(false);
    expect(isGatedActionType('gate')).toBe(false);
    expect(isGatedActionType('handoff')).toBe(false);
  });
});

describe('isUnmappedRole', () => {
  it('recognizes known ROLE_AGENT_MAP roles', () => {
    for (const role of ['maintenance', 'leasing', 'accounting', 'operations', 'human', 'pm', 'owner']) {
      expect(isUnmappedRole(role)).toBe(false);
    }
  });

  it('flags an unknown role as unmapped', () => {
    expect(isUnmappedRole('totally-unknown-role')).toBe(true);
  });
});

// A minimal synthetic SOP for pure chain-detection unit tests, independent of fixtures.
function chainSop(): SopDocument {
  return {
    slug: 'test-sop',
    name: 'Test SOP',
    description: 'test',
    subject_type: 'test',
    default_start_stage_key: 's1',
    captured_at: '2026-01-01T00:00:00.000Z',
    stages: [
      {
        stage_key: 's1',
        name: 'Stage 1',
        description: '',
        steps: [
          baseStep({ task_key: 'a', depends_on: [] }),
          baseStep({ task_key: 'b', depends_on: ['a'] }),
        ],
      },
      {
        stage_key: 's2',
        name: 'Stage 2',
        description: '',
        steps: [
          baseStep({ task_key: 'c', depends_on: ['b'] }), // chain: first of stage 2, deps [last of stage 1]
          baseStep({ task_key: 'd', depends_on: ['b', 'a'] }), // custom: multi-parent
          baseStep({ task_key: 'e', depends_on: [] }), // custom: empty on non-first step
        ],
      },
    ],
  };
}

describe('isSimpleChainStep', () => {
  it('treats the very first step of the first stage as chain when it has no deps', () => {
    const sop = chainSop();
    expect(isSimpleChainStep(sop, 0, 0)).toBe(true);
  });

  it('treats a step depending only on the previous step in its stage as chain', () => {
    const sop = chainSop();
    expect(isSimpleChainStep(sop, 0, 1)).toBe(true);
  });

  it('treats the first step of a later stage depending on the previous stage\'s last step as chain', () => {
    const sop = chainSop();
    expect(isSimpleChainStep(sop, 1, 0)).toBe(true);
  });

  it('flags a multi-parent dependency as custom', () => {
    const sop = chainSop();
    expect(isSimpleChainStep(sop, 1, 1)).toBe(false);
  });

  it('flags an empty depends_on on a non-first step as custom', () => {
    const sop = chainSop();
    expect(isSimpleChainStep(sop, 1, 2)).toBe(false);
  });
});

describe('findNearestGate', () => {
  it('finds the nearest upstream human_approval step across the transitive closure', () => {
    const sop: SopDocument = {
      slug: 'gate-test',
      name: 'Gate Test',
      description: '',
      subject_type: 'test',
      default_start_stage_key: 's1',
      captured_at: '2026-01-01T00:00:00.000Z',
      stages: [
        {
          stage_key: 's1',
          name: 'Stage 1',
          description: '',
          steps: [
            baseStep({ task_key: 'draft', depends_on: [] }),
            baseStep({ task_key: 'approve', kind: 'human_approval', assigned_role: 'human', is_automated: false, depends_on: ['draft'] }),
            baseStep({ task_key: 'send', action_type: 'external_comm', depends_on: ['approve'] }),
          ],
        },
      ],
    };
    const gate = findNearestGate(sop, 'send');
    expect(gate?.step.task_key).toBe('approve');
  });

  it('returns null when no human_approval ancestor exists (honest no-gate state)', () => {
    const sop: SopDocument = {
      slug: 'no-gate-test',
      name: 'No Gate Test',
      description: '',
      subject_type: 'test',
      default_start_stage_key: 's1',
      captured_at: '2026-01-01T00:00:00.000Z',
      stages: [
        {
          stage_key: 's1',
          name: 'Stage 1',
          description: '',
          steps: [
            baseStep({ task_key: 'draft', depends_on: [] }),
            baseStep({ task_key: 'send', action_type: 'external_comm', depends_on: ['draft'] }),
          ],
        },
      ],
    };
    expect(findNearestGate(sop, 'send')).toBeNull();

    const info = describeStep(sop, 0, 1);
    expect(info.gated).toBe(true);
    expect(info.nearestGateTaskKey).toBeNull();
  });
});

describe('getSopIndex (fixture-backed)', () => {
  it('returns ready state with the 46-SOP public corpus', async () => {
    const data = await getSopIndex();
    expect(data.state).toBe('ready');
    if (data.state !== 'ready') return;
    expect(data.source).toBe('fixtures');
    expect(data.rows.length).toBe(46);
    const slugs = data.rows.map((r) => r.slug);
    expect(slugs).toContain('delinquency-escalation-ladder');
    expect(slugs).not.toContain('demo-gated-resident-notice');
    expect(slugs).not.toContain('demo-branching-approval-chain');
  });

  it('the 46-SOP public corpus has zero gated steps today (honest, not a bug)', async () => {
    const data = await getSopIndex();
    if (data.state !== 'ready') throw new Error('expected ready state');
    for (const row of data.rows) {
      expect(row.gated_step_count).toBe(0);
      expect(row.is_synthetic_demo).toBe(false);
    }
  });

  it('ships no synthetic drift rows in the public corpus', async () => {
    const data = await getSopIndex();
    if (data.state !== 'ready') throw new Error('expected ready state');
    const drifted = data.rows.filter((r) => r.drift_detected);
    expect(drifted).toEqual([]);
  });
});

describe('getSop (fixture-backed)', () => {
  it('returns an honest error state for an unknown slug', async () => {
    const data = await getSop('this-slug-does-not-exist');
    expect(data.state).toBe('error');
    if (data.state !== 'error') return;
    expect(data.reason).toMatch(/not found/i);
  });

  it('returns the full document for a known slug with a derived v0 version from captured_at', async () => {
    const data = await getSop('delinquency-escalation-ladder');
    expect(data.state).toBe('ready');
    if (data.state !== 'ready') return;
    expect(data.sop.stages.length).toBeGreaterThan(0);
    expect(data.version.id).toBe('v0');
    expect(data.version.updated_at).toBe(data.sop.captured_at);
  });

  it('flags a real fixture multi-parent dependency as custom, not chain', async () => {
    const data = await getSop('lease-drafting-execution');
    expect(data.state).toBe('ready');
    if (data.state !== 'ready') return;
    const stageIndex = data.sop.stages.findIndex((s) => s.stage_key === 'approval-gates');
    const stepIndex = data.sop.stages[stageIndex].steps.findIndex((s) => s.task_key === 'approve-lease-packet-release');
    const info = describeStep(data.sop, stageIndex, stepIndex);
    expect(info.isChainStep).toBe(false);
  });
});
