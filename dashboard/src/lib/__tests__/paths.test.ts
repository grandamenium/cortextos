import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import {
  getCtxRoot,
  getIpcPath,
  getAgentDir,
  getOrgDir,
  getKnowledgeBaseDir,
} from '../paths';

// Mirror tests/unit/utils/paths.test.ts hermetics: a CTX_ROOT in the
// developer's shell must not leak into expectations.
beforeEach(() => {
  vi.stubEnv('CTX_ROOT', '');
  vi.stubEnv('CTX_INSTANCE_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getCtxRoot (#568 parity with src/utils/paths.ts)', () => {
  it('falls back to ~/.cortextos/{instance} when CTX_ROOT is not set', () => {
    expect(getCtxRoot('default')).toBe(path.join(os.homedir(), '.cortextos', 'default'));
    expect(getCtxRoot('prod')).toBe(path.join(os.homedir(), '.cortextos', 'prod'));
  });

  it('honours the CTX_ROOT env var when set', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(getCtxRoot('default')).toBe('/agentic/cortextos-data');
  });

  it('does NOT tilde-expand CTX_ROOT (parity with daemon resolver, council [high])', () => {
    // The canonical src/utils/paths.ts:getCtxRoot returns the env value
    // verbatim — it does not expand a leading `~`. The dashboard MUST match,
    // or the two processes resolve different physical KB trees.
    vi.stubEnv('CTX_ROOT', '~/agentic/cortextos-data');
    expect(getCtxRoot('default')).toBe('~/agentic/cortextos-data');
  });

  it('explicit override beats the CTX_ROOT env var', () => {
    vi.stubEnv('CTX_ROOT', '/from-env');
    expect(getCtxRoot('default', '/explicit/root')).toBe('/explicit/root');
  });

  it('empty-string override falls through to env then default', () => {
    vi.stubEnv('CTX_ROOT', '/from-env');
    expect(getCtxRoot('default', '')).toBe('/from-env');
  });

  it('does NOT append the instance id when CTX_ROOT is set', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(getCtxRoot('prod')).toBe('/agentic/cortextos-data');
  });

  it('still validates instanceId even when CTX_ROOT is set', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(() => getCtxRoot('../traversal')).toThrow();
    expect(() => getCtxRoot('bad/id')).toThrow();
    expect(() => getCtxRoot('')).toThrow();
  });

  it('rejects uppercase / dotted instance IDs', () => {
    expect(() => getCtxRoot('Prod')).toThrow();
    expect(() => getCtxRoot('v2.1')).toThrow();
  });
});

describe('getIpcPath (#40)', () => {
  const unixOnly = process.platform === 'win32' ? it.skip : it;

  unixOnly('socket lives under the default root when CTX_ROOT is not set', () => {
    expect(getIpcPath('default')).toBe(
      path.join(os.homedir(), '.cortextos', 'default', 'daemon.sock'),
    );
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

describe('getAgentDir (resolver — CTX_ROOT-rooted agent workspace)', () => {
  it('resolves org-scoped agent workspace under ctxRoot', () => {
    expect(getAgentDir('builder', 'acme', 'default', '/custom/root')).toBe(
      '/custom/root/orgs/acme/agents/builder',
    );
  });

  it('resolves flat agent workspace when no org given', () => {
    expect(getAgentDir('builder', undefined, 'default', '/custom/root')).toBe(
      '/custom/root/agents/builder',
    );
  });

  it('honours CTX_ROOT env for the agent workspace', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(getAgentDir('builder', 'acme')).toBe(
      '/agentic/cortextos-data/orgs/acme/agents/builder',
    );
  });

  it('never resolves into the framework root', () => {
    vi.stubEnv('CTX_ROOT', '/state/root');
    vi.stubEnv('CTX_FRAMEWORK_ROOT', '/framework/root');
    expect(getAgentDir('builder', 'acme')).toBe('/state/root/orgs/acme/agents/builder');
  });
});

describe('getOrgDir / getKnowledgeBaseDir (#38)', () => {
  it('resolves the org dir under ctxRoot', () => {
    expect(getOrgDir('acme', 'default', '/custom/root')).toBe('/custom/root/orgs/acme');
  });

  it('resolves the knowledge-base dir under ctxRoot', () => {
    expect(getKnowledgeBaseDir('acme', 'default', '/custom/root')).toBe(
      '/custom/root/orgs/acme/knowledge-base',
    );
  });

  it('uses CTX_ROOT for the knowledge-base dir (not a re-rooted ~/.cortextos)', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(getKnowledgeBaseDir('acme')).toBe(
      '/agentic/cortextos-data/orgs/acme/knowledge-base',
    );
  });

  it('uses the instance fallback when CTX_ROOT is unset', () => {
    vi.stubEnv('CTX_INSTANCE_ID', 'e2e-phase');
    expect(getKnowledgeBaseDir('acme')).toBe(
      path.join(os.homedir(), '.cortextos', 'e2e-phase', 'orgs', 'acme', 'knowledge-base'),
    );
  });
});

// Cross-module parity: dashboard/src/lib/paths.ts and src/utils/paths.ts MUST
// resolve identical paths for identical inputs. This is the regression guard
// against the trees drifting apart again (the root cause of #38/#39/#40).
describe('parity with src/utils/paths.ts', () => {
  const unixOnly = process.platform === 'win32' ? it.skip : it;

  unixOnly('getCtxRoot resolves identically for the same inputs', async () => {
    const srcPaths = await import('../../../../src/utils/paths');
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(getCtxRoot('default')).toBe(srcPaths.getCtxRoot('default'));
    vi.stubEnv('CTX_ROOT', '');
    expect(getCtxRoot('prod')).toBe(srcPaths.getCtxRoot('prod'));
    expect(getCtxRoot('default', '/explicit/root')).toBe(
      srcPaths.getCtxRoot('default', '/explicit/root'),
    );
  });

  unixOnly('getIpcPath resolves identically for the same inputs', async () => {
    const srcPaths = await import('../../../../src/utils/paths');
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    expect(getIpcPath('default')).toBe(srcPaths.getIpcPath('default'));
    vi.stubEnv('CTX_ROOT', '');
    expect(getIpcPath('prod')).toBe(srcPaths.getIpcPath('prod'));
  });

  // src/utils/paths.ts has no getOrgDir/getKnowledgeBaseDir, but the canonical
  // bus-side KB writer (src/bus/knowledge-base.ts) composes the KB root as
  // `join(getCtxRoot(instanceId), 'orgs', <org>, 'knowledge-base')`. Assert the
  // dashboard composes the SAME shape off the SAME getCtxRoot so the dashboard
  // and the daemon agree on the KB tree (#38 drift guard).
  unixOnly('getOrgDir / getKnowledgeBaseDir match the bus-side KB root shape', async () => {
    const srcPaths = await import('../../../../src/utils/paths');
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    const srcRoot = srcPaths.getCtxRoot('default');
    expect(getOrgDir('acme')).toBe(path.join(srcRoot, 'orgs', 'acme'));
    expect(getKnowledgeBaseDir('acme')).toBe(
      path.join(srcRoot, 'orgs', 'acme', 'knowledge-base'),
    );
  });
});
