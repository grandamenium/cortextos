import { describe, it, expect } from 'vitest';
import { resolvePaths } from '../../../src/utils/paths';

describe('resolvePaths', () => {
  it('returns paths under ctxRoot when explicitly provided', () => {
    const customRoot = '/custom/ctx/root';
    const paths = resolvePaths('paul', 'default', undefined, customRoot);
    expect(paths.ctxRoot).toBe(customRoot);
    expect(paths.inbox).toBe('/custom/ctx/root/inbox/paul');
    expect(paths.inflight).toBe('/custom/ctx/root/inflight/paul');
    expect(paths.processed).toBe('/custom/ctx/root/processed/paul');
    expect(paths.logDir).toBe('/custom/ctx/root/logs/paul');
    expect(paths.stateDir).toBe('/custom/ctx/root/state/paul');
    expect(paths.taskDir).toBe('/custom/ctx/root/tasks');
    expect(paths.approvalDir).toBe('/custom/ctx/root/approvals');
    expect(paths.analyticsDir).toBe('/custom/ctx/root/analytics');
    expect(paths.deliverablesDir).toBe('/custom/ctx/root/deliverables');
  });

  it('uses homedir() behaviour when ctxRoot is not provided', () => {
    const paths = resolvePaths('paul', 'default', undefined);
    expect(paths.ctxRoot).toMatch(/\.cortextos\/default$/);
    expect(paths.inbox).toContain('/.cortextos/default/inbox/paul');
    expect(paths.inflight).toContain('/.cortextos/default/inflight/paul');
    expect(paths.processed).toContain('/.cortextos/default/processed/paul');
    expect(paths.logDir).toContain('/.cortextos/default/logs/paul');
    expect(paths.stateDir).toContain('/.cortextos/default/state/paul');
  });

  it('applies org to org-scoped paths when provided', () => {
    const customRoot = '/custom/ctx/root';
    const paths = resolvePaths('paul', 'default', 'acme', customRoot);
    expect(paths.taskDir).toBe('/custom/ctx/root/orgs/acme/tasks');
    expect(paths.approvalDir).toBe('/custom/ctx/root/orgs/acme/approvals');
    expect(paths.analyticsDir).toBe('/custom/ctx/root/orgs/acme/analytics');
    expect(paths.deliverablesDir).toBe('/custom/ctx/root/orgs/acme/deliverables');
  });

  it('still validates instanceId even when ctxRoot is provided', () => {
    expect(() => resolvePaths('paul', 'invalid/id', undefined, '/custom/root')).toThrow();
    expect(() => resolvePaths('paul', 'Invalid', undefined, '/custom/root')).toThrow();
    expect(() => resolvePaths('paul', '../traversal', undefined, '/custom/root')).toThrow();
  });

  it('accepts valid instanceIds with explicit ctxRoot', () => {
    const paths = resolvePaths('paul', 'default', undefined, '/custom/root');
    expect(paths.ctxRoot).toBe('/custom/root');
  });

  it('empty string ctxRoot falls back to homedir default', () => {
    const pathsWithEmpty = resolvePaths('paul', 'default', undefined, '');
    expect(pathsWithEmpty.ctxRoot).toMatch(/\.cortextos\/default$/);
  });
});