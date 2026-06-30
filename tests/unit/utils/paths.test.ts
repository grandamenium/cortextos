import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolvePaths, getIpcPath, getCtxRoot } from '../../../src/utils/paths';

// Make every test hermetic: a CTX_ROOT set in the developer's shell must not
// leak into expectations. Tests that want CTX_ROOT stub it explicitly.
beforeEach(() => {
  vi.stubEnv('CTX_ROOT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getCtxRoot (#568)', () => {
  it('falls back to ~/.cortextos/{instance} when CTX_ROOT is not set', () => {
    expect(getCtxRoot('default')).toMatch(/\.cortextos\/default$/);
    expect(getCtxRoot('prod')).toMatch(/\.cortextos\/prod$/);
  });

  it('honours the CTX_ROOT env var when set', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(getCtxRoot('default')).toBe('/agentic/cortextos-data');
  });

  it('explicit override beats the CTX_ROOT env var', () => {
    vi.stubEnv('CTX_ROOT', '/from-env');
    expect(getCtxRoot('default', '/explicit/root')).toBe('/explicit/root');
  });

  it('empty-string override falls through to env then default', () => {
    vi.stubEnv('CTX_ROOT', '/from-env');
    expect(getCtxRoot('default', '')).toBe('/from-env');
  });

  it('still validates instanceId even when CTX_ROOT is set', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(() => getCtxRoot('../traversal')).toThrow();
    expect(() => getCtxRoot('bad/id')).toThrow();
    expect(() => getCtxRoot('')).toThrow();
  });

  it('rejects uppercase / dotted instance IDs (council review)', () => {
    expect(() => getCtxRoot('Prod')).toThrow();
    expect(() => getCtxRoot('v2.1')).toThrow();
  });
});

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

  it('honours CTX_ROOT env var when no explicit ctxRoot is passed (#568)', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    const paths = resolvePaths('paul', 'default');
    expect(paths.ctxRoot).toBe('/agentic/cortextos-data');
    expect(paths.inbox).toBe('/agentic/cortextos-data/inbox/paul');
    expect(paths.stateDir).toBe('/agentic/cortextos-data/state/paul');
    expect(paths.taskDir).toBe('/agentic/cortextos-data/tasks');
  });

  it('explicit ctxRoot param wins over CTX_ROOT env var (#568)', () => {
    vi.stubEnv('CTX_ROOT', '/from-env');
    const paths = resolvePaths('paul', 'default', undefined, '/explicit/root');
    expect(paths.ctxRoot).toBe('/explicit/root');
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
    expect(() => resolvePaths('paul', '', undefined, '/custom/root')).toThrow();
    expect(() => resolvePaths('paul', 'My Instance', undefined, '/custom/root')).toThrow();
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

describe('getIpcPath (#568)', () => {
  // Windows named pipes are instance-keyed, not path-based — CTX_ROOT does not
  // apply there. These tests cover the Unix socket branch only.
  const unixOnly = process.platform === 'win32' ? it.skip : it;

  unixOnly('socket lives under the default root when CTX_ROOT is not set', () => {
    expect(getIpcPath('default')).toMatch(/\.cortextos\/default\/daemon\.sock$/);
  });

  unixOnly('socket lives under CTX_ROOT when set', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(getIpcPath('default')).toBe('/agentic/cortextos-data/daemon.sock');
  });

  unixOnly('explicit ctxRoot param wins over CTX_ROOT env var', () => {
    vi.stubEnv('CTX_ROOT', '/from-env');
    expect(getIpcPath('default', '/explicit/root')).toBe('/explicit/root/daemon.sock');
  });

  it('validates instanceId', () => {
    expect(() => getIpcPath('bad/id')).toThrow();
    expect(() => getIpcPath('../traversal')).toThrow();
    expect(() => getIpcPath('')).toThrow();
  });
});
