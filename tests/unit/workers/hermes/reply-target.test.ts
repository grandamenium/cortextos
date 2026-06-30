import { describe, it, expect } from 'vitest';
import { resolveReplyTarget } from '../../../../src/cli/hermes';
import type { Task } from '../../../../src/types/index';

/**
 * Pins the exact F1 bug spot: who a dispatched task's result is reported to.
 * resolveReplyTarget must prefer the task CREATOR (delegator) over assigned_to —
 * on a delegated task assigned_to is the Hermes worker itself, so replying there
 * sends the result to our own inbox and the delegator never hears it. This is
 * the precedence the inline commander action cannot unit-test directly.
 */

const task = (created_by: string, assigned_to: string): Task =>
  ({ created_by, assigned_to } as Task);

describe('resolveReplyTarget — created_by precedence (F1 regression)', () => {
  it('delegated task: created_by wins over assigned_to (the worker)', () => {
    expect(resolveReplyTarget(task('planner', 'hermes'), 'hermes-self')).toBe('planner');
  });

  it('falls back to assigned_to when created_by is empty', () => {
    expect(resolveReplyTarget(task('', 'hermes'), 'hermes-self')).toBe('hermes');
  });

  it('falls back to self when both are unset (malformed task)', () => {
    expect(resolveReplyTarget(task('', ''), 'hermes-self')).toBe('hermes-self');
  });
});
