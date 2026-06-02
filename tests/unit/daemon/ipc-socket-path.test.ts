import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { IPCClient } from '../../../src/daemon/ipc-server';
import { getIpcPath } from '../../../src/utils/paths';
import { resolveEnv } from '../../../src/utils/env';

/**
 * #568 regression tests: the daemon (IPCServer) and CLI (IPCClient) must agree
 * on the socket path when the data root is relocated via CTX_ROOT — whether it
 * comes from the process env or from a .cortextos-env file via resolveEnv().
 *
 * Windows named pipes are instance-keyed, not path-based; these tests cover the
 * Unix socket branch only.
 */
const unixOnly = process.platform === 'win32' ? describe.skip : describe;

beforeEach(() => {
  vi.stubEnv('CTX_ROOT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

unixOnly('IPC socket path under CTX_ROOT (#568)', () => {
  it('IPCClient socket lives under an explicitly passed ctxRoot', () => {
    const client = new IPCClient('default', '/agentic/cortextos-data');
    expect((client as unknown as { socketPath: string }).socketPath)
      .toBe('/agentic/cortextos-data/daemon.sock');
  });

  it('IPCClient falls back to the CTX_ROOT env var', () => {
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    const client = new IPCClient('default');
    expect((client as unknown as { socketPath: string }).socketPath)
      .toBe('/agentic/cortextos-data/daemon.sock');
  });

  it('IPCClient falls back to ~/.cortextos/{instance} when nothing is set', () => {
    const client = new IPCClient('default');
    expect((client as unknown as { socketPath: string }).socketPath)
      .toMatch(/\.cortextos\/default\/daemon\.sock$/);
  });

  it('daemon (getIpcPath with explicit root) and CLI client resolve the same socket', () => {
    // The daemon passes its resolved this.ctxRoot to IPCServer -> getIpcPath;
    // a CLI in an env with the same CTX_ROOT must land on the same socket.
    const daemonSide = getIpcPath('default', '/agentic/cortextos-data');
    vi.stubEnv('CTX_ROOT', '/agentic/cortextos-data');
    const client = new IPCClient('default');
    expect((client as unknown as { socketPath: string }).socketPath).toBe(daemonSide);
  });
});

unixOnly('CTX_ROOT from .cortextos-env file reaches the IPC socket (#568)', () => {
  let dir: string;
  let savedCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctx568-'));
    savedCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('IPCClient constructed from resolveEnv().ctxRoot honours a file-only CTX_ROOT', () => {
    // CTX_ROOT set ONLY in .cortextos-env (not exported in the shell) — the
    // case Codex review flagged: bus paths honoured it but the socket did not.
    writeFileSync(join(dir, '.cortextos-env'), 'CTX_ROOT=/relocated/data-root\n', 'utf-8');
    process.chdir(dir);
    // resolveEnv() defaults agentName to basename(cwd); the mkdtemp suffix can
    // contain uppercase chars that fail validation — pin a valid name instead.
    vi.stubEnv('CTX_AGENT_NAME', 'test-agent');

    const env = resolveEnv();
    expect(env.ctxRoot).toBe('/relocated/data-root');

    const client = new IPCClient(env.instanceId, env.ctxRoot);
    expect((client as unknown as { socketPath: string }).socketPath)
      .toBe('/relocated/data-root/daemon.sock');
  });
});
