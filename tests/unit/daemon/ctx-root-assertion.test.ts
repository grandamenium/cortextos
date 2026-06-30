import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { checkCtxRootConsistency } from '../../../src/daemon/index';

const HOME = '/home/op';
const expectedFor = (instanceId: string) => join(HOME, '.cortextos', instanceId);

describe('checkCtxRootConsistency (CTX_ROOT startup assertion, #315 / 2026-06-04 flip)', () => {
  it('OK when CTX_ROOT matches the instance-derived path', () => {
    const r = checkCtxRootConsistency({
      instanceId: 'pr-sandbox',
      home: HOME,
      envCtxRoot: expectedFor('pr-sandbox'),
    });
    expect(r.ok).toBe(true);
  });

  it('OK when CTX_ROOT + CTX_ROOT_LOCK are both unset (daemon derives correctly)', () => {
    expect(checkCtxRootConsistency({ instanceId: 'default', home: HOME }).ok).toBe(true);
  });

  it('OK when CTX_ROOT is empty string (treated as unset)', () => {
    expect(checkCtxRootConsistency({ instanceId: 'default', home: HOME, envCtxRoot: '' }).ok).toBe(true);
  });

  it('FAILS CLOSED when a wrong shell CTX_ROOT disagrees with the instance (the --update-env flip)', () => {
    const r = checkCtxRootConsistency({
      instanceId: 'pr-sandbox',
      home: HOME,
      envCtxRoot: expectedFor('default'), // shell leaked the live default root
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.via).toBe('CTX_ROOT');
      expect(r.expected).toBe(expectedFor('pr-sandbox'));
      expect(r.got).toBe(expectedFor('default'));
    }
  });

  it('CTX_ROOT_LOCK is authoritative: fails when the instance-derived path disagrees with the lock', () => {
    const r = checkCtxRootConsistency({
      instanceId: 'default', // flipped to default by --update-env
      home: HOME,
      lock: expectedFor('pr-sandbox'), // ecosystem pinned the intended root
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.via).toBe('CTX_ROOT_LOCK');
      expect(r.got).toBe(expectedFor('pr-sandbox'));
    }
  });

  it('CTX_ROOT_LOCK OK path: lock == instance-derived == CTX_ROOT', () => {
    const expected = expectedFor('pr-sandbox');
    const r = checkCtxRootConsistency({
      instanceId: 'pr-sandbox',
      home: HOME,
      envCtxRoot: expected,
      lock: expected,
    });
    expect(r.ok).toBe(true);
  });

  it('with CTX_ROOT_LOCK set, a divergent CTX_ROOT still fails', () => {
    const r = checkCtxRootConsistency({
      instanceId: 'pr-sandbox',
      home: HOME,
      envCtxRoot: expectedFor('default'),
      lock: expectedFor('pr-sandbox'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.via).toBe('CTX_ROOT');
  });
});
