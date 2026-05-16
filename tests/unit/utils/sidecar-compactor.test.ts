import { describe, it, expect, vi } from 'vitest';
import {
  splitTurnsByTokenBudget,
  flattenTurns,
  validateAndPatchSummary,
  buildLedgerDoc,
  redactLedgerSummary,
} from '../../../src/utils/sidecar-compactor.js';
import type { ParsedTurn } from '../../../src/utils/agent-session.js';
import type { CompactionSummary } from '../../../src/utils/sidecar-compactor.js';
import type { CompactionLedger } from '../../../src/types/index.js';

function makeTurn(role: 'user' | 'assistant', text: string, tokens = 100): ParsedTurn {
  return { uuid: `u-${Math.random()}`, role, contentText: text, estimatedTokens: tokens, rawLine: '{}' };
}

describe('splitTurnsByTokenBudget', () => {
  it('puts all turns in recent when total is under budget', () => {
    const turns = [makeTurn('user', 'a', 100), makeTurn('assistant', 'b', 100)];
    const { middle, recent } = splitTurnsByTokenBudget(turns, 1000);
    expect(middle).toHaveLength(0);
    expect(recent).toHaveLength(2);
  });

  it('splits turns when total exceeds budget', () => {
    const turns = Array.from({ length: 10 }, (_, i) => makeTurn('user', `msg${i}`, 100));
    const { middle, recent } = splitTurnsByTokenBudget(turns, 300);
    expect(recent.length).toBeLessThanOrEqual(3);
    expect(middle.length + recent.length).toBe(10);
  });

  it('always puts at least one turn in recent', () => {
    const turns = [makeTurn('user', 'single', 5000)];
    const { middle, recent } = splitTurnsByTokenBudget(turns, 100);
    expect(recent).toHaveLength(1);
    expect(middle).toHaveLength(0);
  });
});

describe('flattenTurns', () => {
  it('produces role-prefixed text blocks', () => {
    const turns = [makeTurn('user', 'hello'), makeTurn('assistant', 'world')];
    const result = flattenTurns(turns);
    expect(result).toContain('user: hello');
    expect(result).toContain('assistant: world');
  });
});

describe('validateAndPatchSummary', () => {
  it('returns null when next_action is empty', () => {
    const s: CompactionSummary = {
      resolved: [],
      pending: ['something'],
      key_facts: { current_state: 'state', next_action: '' },
      redaction_count: 0,
    };
    expect(validateAndPatchSummary(s, false)).toBeNull();
  });

  it('patches empty pending when recent activity exists', () => {
    const s: CompactionSummary = {
      resolved: [],
      pending: [],
      key_facts: { current_state: 'state', next_action: 'do X' },
      redaction_count: 0,
    };
    const result = validateAndPatchSummary(s, true);
    expect(result).not.toBeNull();
    expect(result!.pending).toHaveLength(1);
    expect(result!.pending[0]).toContain('unknown');
  });

  it('passes valid summary unchanged', () => {
    const s: CompactionSummary = {
      resolved: ['task 1'],
      pending: ['task 2'],
      key_facts: { current_state: 'state', next_action: 'do Y' },
      redaction_count: 0,
    };
    const result = validateAndPatchSummary(s, true);
    expect(result).not.toBeNull();
    expect(result!.pending).toEqual(['task 2']);
    expect(result!.resolved).toEqual(['task 1']);
  });
});

describe('redactLedgerSummary', () => {
  it('redacts secrets in key_facts', () => {
    const s: CompactionSummary = {
      resolved: [],
      pending: ['contact user@example.com'],
      key_facts: { current_state: 'saw user@test.org', next_action: 'proceed' },
      redaction_count: 0,
    };
    const result = redactLedgerSummary(s);
    expect(JSON.stringify(result)).not.toContain('@example.com');
    expect(result.redaction_count).toBeGreaterThan(0);
  });

  it('updates redaction_count cumulatively', () => {
    const s: CompactionSummary = {
      resolved: [],
      pending: [],
      key_facts: { current_state: 'clean', next_action: 'done' },
      redaction_count: 5,
    };
    const result = redactLedgerSummary(s);
    expect(result.redaction_count).toBe(5); // no new redactions in clean text
  });
});

describe('buildLedgerDoc', () => {
  it('produces markdown with all required sections', () => {
    const ledger: CompactionLedger = {
      schema_version: '1',
      compacted_at: '2026-05-15T22:00:00.000Z',
      session_id: 'abc-123',
      context_pct_at_compact: 62,
      variant: 'sonnet',
      resolved: ['task A'],
      pending: ['task B'],
      key_facts: {
        current_state: 'working on X',
        next_action: 'deploy Y',
        active_files: ['src/foo.ts'],
        blockers: ['waiting for approval'],
      },
      recent_turns_summary: 'recent text here',
      redaction_count: 3,
    };
    const doc = buildLedgerDoc('ops-g', ledger);
    expect(doc).toContain('# Compaction Ledger');
    expect(doc).toContain('## Resolved');
    expect(doc).toContain('## Pending');
    expect(doc).toContain('## Current State');
    expect(doc).toContain('## Next Action');
    expect(doc).toContain('## Active Files');
    expect(doc).toContain('## Blockers');
    expect(doc).toContain('task A');
    expect(doc).toContain('task B');
    expect(doc).toContain('src/foo.ts');
  });

  it('omits optional sections when empty', () => {
    const ledger: CompactionLedger = {
      schema_version: '1',
      compacted_at: '2026-05-15T22:00:00.000Z',
      session_id: 'abc-456',
      context_pct_at_compact: 65,
      variant: 'deterministic',
      resolved: [],
      pending: [],
      key_facts: { current_state: 'idle', next_action: 'wait' },
      recent_turns_summary: '',
      redaction_count: 0,
    };
    const doc = buildLedgerDoc('ops-g', ledger);
    expect(doc).not.toContain('## Active Files');
    expect(doc).not.toContain('## Blockers');
  });
});
