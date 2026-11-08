import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { createServer, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import packageMetadata from '../../../package.json';
import {
  collectLegacyStatus,
  isLegacyAgentStatus,
  LegacyStatusCollectionError,
  probeLegacyDaemon,
  type LegacyDaemonProbe,
} from '../../../src/lifecycle/legacy-status';
import { redactLifecycleStatus } from '../../../src/lifecycle/redact-status';
import {
  evaluateStatusCheck,
  normalizeStatusCheckPolicy,
  UnsupportedStatusCheckPolicyError,
} from '../../../src/lifecycle/check-status';
import {
  LifecycleStatusCliError,
  localErrorEnvelope,
  redactedErrorEnvelope,
  renderLocalHuman,
  renderRedactedHuman,
  validateLifecycleStatusOptions,
} from '../../../src/cli/lifecycle';
import { CORTEXTOS_VERSION } from '../../../src/version';

const tempRoots: string[] = [];
const originalInstanceId = process.env.CTX_INSTANCE_ID;
const originalCtxRoot = process.env.CTX_ROOT;

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cortext-lifecycle-${label}-`));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function makeFixture(version = '0.1.1'): { root: string; frameworkRoot: string; ctxRoot: string } {
  const root = tempRoot('fixture');
  const frameworkRoot = join(root, 'framework');
  const ctxRoot = join(root, 'state');
  mkdirSync(frameworkRoot, { recursive: true });
  mkdirSync(join(ctxRoot, 'state'), { recursive: true });
  writeJson(join(frameworkRoot, 'package.json'), { name: 'cortextos', version });
  return { root, frameworkRoot, ctxRoot };
}

function addAgent(frameworkRoot: string, org: string, name: string, config: unknown = {}): string {
  const dir = org === '@root'
    ? join(frameworkRoot, 'agents', name)
    : join(frameworkRoot, 'orgs', org, 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'config.json'), config);
  return dir;
}

function responsive(statuses: LegacyDaemonProbe & { kind: 'responsive' }): () => Promise<LegacyDaemonProbe> {
  return async () => statuses;
}

async function probeFromTemporaryServer(
  respond: (socket: Socket) => void,
  timeoutMs = 250,
): Promise<LegacyDaemonProbe> {
  const root = tempRoot('ipc');
  const socketPath = join(root, 'daemon.sock');
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => respond(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await probeLegacyDaemon('default', socketPath, timeoutMs);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function treeMetadata(root: string, relative = ''): string[] {
  const current = join(root, relative);
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const result: string[] = [];
  for (const entry of entries) {
    const childRelative = join(relative, entry.name);
    const stat = lstatSync(join(root, childRelative));
    result.push([
      childRelative,
      stat.mode,
      stat.size,
      stat.mtimeMs,
      entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
    ].join(':'));
    if (entry.isDirectory()) result.push(...treeMetadata(root, childRelative));
  }
  return result;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
  else process.env.CTX_INSTANCE_ID = originalInstanceId;
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
});

describe('legacy lifecycle status collector', () => {
  it('selects the only conclusively discoverable legacy instance', async () => {
    delete process.env.CTX_INSTANCE_ID;
    delete process.env.CTX_ROOT;
    const home = tempRoot('one-instance');
    const ctxRoot = join(home, '.cortextos', 'solo');
    const frameworkRoot = join(home, 'framework');
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    mkdirSync(frameworkRoot, { recursive: true });
    writeJson(join(frameworkRoot, 'package.json'), { name: 'cortextos', version: '0.1.1' });

    const snapshot = await collectLegacyStatus({
      homeDir: home,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.scope).toMatchObject({
      requested_instance: null,
      selection_source: 'only_instance',
      resolved_instance_id: 'solo',
    });
  });

  it('rejects ambiguous discovery without exposing candidate identities', async () => {
    delete process.env.CTX_INSTANCE_ID;
    delete process.env.CTX_ROOT;
    const home = tempRoot('ambiguous');
    mkdirSync(join(home, '.cortextos', 'first', 'state'), { recursive: true });
    mkdirSync(join(home, '.cortextos', 'second', 'config'), { recursive: true });

    await expect(collectLegacyStatus({ homeDir: home }))
      .rejects.toMatchObject<Partial<LegacyStatusCollectionError>>({
        code: 'CORTEXT_STATUS_INSTANCE_AMBIGUOUS',
        candidateCount: 2,
      });
  });

  it('rejects a programmatic state root that is not explicitly bound to an instance', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    let probed = false;

    await expect(collectLegacyStatus({
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => {
        probed = true;
        return { kind: 'absent' };
      },
    })).rejects.toMatchObject<Partial<LegacyStatusCollectionError>>({
      code: 'CORTEXT_STATUS_INVALID_INSTANCE',
    });
    expect(probed).toBe(false);
  });

  it('blocks a noncanonical environment-selected state root whose daemon identity is unproven', async () => {
    delete process.env.CTX_INSTANCE_ID;
    const home = tempRoot('split-root-home');
    const frameworkRoot = join(home, 'framework');
    const customRoot = join(home, 'custom-state');
    mkdirSync(frameworkRoot, { recursive: true });
    mkdirSync(join(customRoot, 'state'), { recursive: true });
    writeJson(join(frameworkRoot, 'package.json'), { name: 'cortextos', version: '0.1.1' });
    process.env.CTX_ROOT = customRoot;

    const snapshot = await collectLegacyStatus({
      homeDir: home,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.scope.selection_source).toBe('legacy_environment');
    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.overall.status).toBe('blocked');
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_LEGACY_ROOT_AUTHORITY_UNPROVEN',
    );
  });

  it('returns a typed not-found error when no legacy instance root exists', async () => {
    const root = tempRoot('missing');
    await expect(collectLegacyStatus({
      instanceId: 'default',
      ctxRoot: join(root, 'does-not-exist'),
      frameworkRoot: root,
      probeDaemon: async () => ({ kind: 'absent' }),
    })).rejects.toMatchObject<Partial<LegacyStatusCollectionError>>({
      code: 'CORTEXT_STATUS_INSTANCE_NOT_FOUND',
    });
  });

  it('treats the dashboard version as component evidence, not an app conflict', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture('0.1.1');
    writeJson(join(frameworkRoot, 'dashboard', 'package.json'), {
      name: 'dashboard',
      version: '9.7.3',
    });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.application.version).toBe('0.1.1');
    expect(snapshot.application.version_evidence).toContainEqual(expect.objectContaining({
      domain: 'dashboard_component',
      value: '9.7.3',
    }));
    expect(snapshot.observations.map(item => item.code)).not.toContain('CORTEXT_STATUS_VERSION_CONFLICT');
    expect(snapshot.snapshot_status).toBe('complete');
    expect(snapshot.overall.status).toBe('stopped');
  });

  it('reports conflicting application authorities without guessing a version', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture('4.2.0');
    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.application.version).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toContain('CORTEXT_STATUS_VERSION_CONFLICT');
  });

  it('does not claim framework modification state without a non-executing proof', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    execFileSync('git', ['init'], { cwd: frameworkRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: frameworkRoot });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: frameworkRoot });
    execFileSync('git', ['add', 'package.json'], { cwd: frameworkRoot });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: frameworkRoot, stdio: 'ignore' });
    writeFileSync(join(frameworkRoot, 'PRIVATE_CHANGED_PATH_CANARY.txt'), 'private', 'utf-8');

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.observations.map(item => item.code)).not.toContain(
      'CORTEXT_STATUS_FRAMEWORK_MODIFIED',
    );
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_CHANGED_PATH_CANARY');
  });

  it('does not execute repository-configured clean filters during Git inspection', async () => {
    const { root, frameworkRoot, ctxRoot } = makeFixture();
    execFileSync('git', ['init'], { cwd: frameworkRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: frameworkRoot });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: frameworkRoot });
    writeFileSync(join(frameworkRoot, '.gitattributes'), '* filter=evil\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: frameworkRoot });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: frameworkRoot, stdio: 'ignore' });

    const marker = join(root, 'CLEAN_FILTER_EXECUTED_CANARY');
    const filter = join(root, 'malicious-clean-filter');
    writeFileSync(filter, `#!/bin/sh\nprintf executed > "${marker}"\ncat\n`, 'utf-8');
    chmodSync(filter, 0o700);
    execFileSync('git', ['config', 'filter.evil.clean', filter], { cwd: frameworkRoot });
    writeJson(join(frameworkRoot, 'package.json'), { name: 'cortextos', version: '0.1.1' });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.application.source_commit).toMatch(/^[a-f0-9]{40,64}$/);
    expect(existsSync(marker)).toBe(false);
    expect(snapshot.observations.map(item => item.code)).not.toContain(
      'CORTEXT_STATUS_FRAMEWORK_MODIFIED',
    );
  });

  it('does not execute a repository-configured fsmonitor command during Git inspection', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    execFileSync('git', ['init'], { cwd: frameworkRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: frameworkRoot });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: frameworkRoot });
    execFileSync('git', ['add', 'package.json'], { cwd: frameworkRoot });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: frameworkRoot, stdio: 'ignore' });

    const marker = join(frameworkRoot, 'FSMONITOR_EXECUTED_CANARY');
    const hook = join(frameworkRoot, '.git', 'malicious-fsmonitor');
    writeFileSync(
      hook,
      "#!/bin/sh\nprintf executed > FSMONITOR_EXECUTED_CANARY\nprintf '2\\n'\n",
      'utf-8',
    );
    chmodSync(hook, 0o700);
    execFileSync('git', ['config', 'core.fsmonitor', '.git/malicious-fsmonitor'], {
      cwd: frameworkRoot,
    });

    await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(existsSync(marker)).toBe(false);
  });

  it('scrubs Git redirection and tracing while disabling lazy fetches', async () => {
    const { root, frameworkRoot, ctxRoot } = makeFixture();
    const decoyRoot = join(root, 'decoy');
    mkdirSync(decoyRoot, { recursive: true });
    writeFileSync(join(decoyRoot, 'decoy.txt'), 'decoy', 'utf-8');
    for (const repository of [frameworkRoot, decoyRoot]) {
      execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
      execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: repository });
      execFileSync('git', ['add', '.'], { cwd: repository });
      execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository, stdio: 'ignore' });
    }
    const frameworkCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: frameworkRoot,
      encoding: 'utf-8',
    }).trim();
    const binRoot = join(root, 'bin');
    const executionCanary = join(root, 'PATH_GIT_EXECUTED_CANARY');
    const traceCanary = join(root, 'GIT_TRACE_WRITE_CANARY');
    mkdirSync(binRoot, { recursive: true });
    const wrapper = join(binRoot, 'git');
    writeFileSync(wrapper, [
      '#!/bin/sh',
      `printf executed > ${executionCanary}`,
      'exit 99',
      '',
    ].join('\n'), 'utf-8');
    chmodSync(wrapper, 0o700);

    const previous = {
      PATH: process.env.PATH,
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_TRACE: process.env.GIT_TRACE,
    };
    let snapshot;
    try {
      process.env.PATH = `${binRoot}:${previous.PATH ?? ''}`;
      process.env.GIT_DIR = join(decoyRoot, '.git');
      process.env.GIT_WORK_TREE = decoyRoot;
      process.env.GIT_TRACE = traceCanary;
      snapshot = await collectLegacyStatus({
        instanceId: 'default',
        ctxRoot,
        frameworkRoot,
        probeDaemon: async () => ({ kind: 'absent' }),
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(snapshot!.application.source_commit).toBe(frameworkCommit);
    expect(existsSync(traceCanary)).toBe(false);
    expect(existsSync(executionCanary)).toBe(false);
  });

  it('rejects malformed fields in otherwise status-shaped IPC entries', () => {
    expect(isLegacyAgentStatus({ name: 'agent', status: 'running', pid: 42 })).toBe(true);
    expect(isLegacyAgentStatus({ name: 'LegacyAgent', status: 'running', pid: 42 })).toBe(true);
    expect(isLegacyAgentStatus({ name: '../agent', status: 'running' })).toBe(false);
    expect(isLegacyAgentStatus({ name: 'agent.one', status: 'running' })).toBe(false);
    expect(isLegacyAgentStatus({ name: 'agent', status: 'running', pid: -1 })).toBe(false);
    expect(isLegacyAgentStatus({
      name: 'agent', status: 'running', awaitingConfirmation: 'yes',
    })).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'bounds and validates production daemon IPC responses and teardown',
    async () => {
      const valid = await probeFromTemporaryServer(socket => socket.end(JSON.stringify({
        success: true,
        data: [{ name: 'agent', status: 'running', pid: 42 }],
      })));
      expect(valid).toEqual({
        kind: 'responsive',
        statuses: [{ name: 'agent', status: 'running', pid: 42 }],
      });

      const duplicate = await probeFromTemporaryServer(socket => socket.end(JSON.stringify({
        success: true,
        data: [
          { name: 'agent', status: 'running' },
          { name: 'agent', status: 'stopped' },
        ],
      })));
      expect(duplicate).toEqual({ kind: 'invalid' });

      const oversized = await probeFromTemporaryServer(socket => {
        socket.end(Buffer.alloc((1024 * 1024) + 1, 0x20));
      });
      expect(oversized).toEqual({ kind: 'invalid' });

      const tooManyEntries = await probeFromTemporaryServer(socket => socket.end(JSON.stringify({
        success: true,
        data: Array.from({ length: 4097 }, (_, index) => ({
          name: `agent${index}`,
          status: 'stopped',
        })),
      })));
      expect(tooManyEntries).toEqual({ kind: 'invalid' });

      const empty = await probeFromTemporaryServer(socket => socket.end());
      expect(empty).toEqual({ kind: 'invalid' });

      const timeout = await probeFromTemporaryServer(() => {}, 20);
      expect(timeout).toEqual({ kind: 'timeout' });

      const absentRoot = tempRoot('ipc-absent');
      expect(await probeLegacyDaemon('default', join(absentRoot, 'missing.sock'), 20))
        .toEqual({ kind: 'absent' });
    },
  );

  it('counts every IPC process, including disabled and unregistered processes', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'team', 'alice', { enabled: false });
    addAgent(frameworkRoot, 'team', 'bob', { enabled: true });
    writeJson(join(ctxRoot, 'config', 'enabled-agents.json'), {
      alice: { org: 'team', enabled: false },
      bob: { org: 'team', enabled: true },
    });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      pidAlive: () => true,
      probeDaemon: responsive({
        kind: 'responsive',
        statuses: [
          { name: 'alice', status: 'running', pid: 101 },
          { name: 'rogue', status: 'running', pid: 102 },
          { name: 'bob', status: 'starting', pid: 103, awaitingConfirmation: true },
        ],
      }),
    });

    expect(snapshot.runtime.agents).toMatchObject({
      configured: 2,
      enabled: 1,
      observed_processes: 3,
      active_processes: 3,
      running: 2,
      starting: 0,
      degraded: 1,
      expected_missing: 0,
      disabled_active: 1,
      unregistered_active: 1,
    });
    expect(snapshot.overall.status).toBe('degraded');
    expect(snapshot.observations.map(item => item.code)).toEqual(expect.arrayContaining([
      'CORTEXT_STATUS_DISABLED_PROCESS_ACTIVE',
      'CORTEXT_STATUS_UNREGISTERED_PROCESS_ACTIVE',
      'CORTEXT_STATUS_AGENT_DEGRADED',
    ]));
  });

  it('observes uppercase legacy identities without treating valid registry state as corrupt', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    addAgent(frameworkRoot, 'team', 'LegacyAgent', { enabled: true });
    writeJson(join(ctxRoot, 'config', 'enabled-agents.json'), {
      LegacyAgent: { org: 'team', enabled: true },
      StaleAgent: { org: 'team', enabled: false },
    });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      pidAlive: () => true,
      probeDaemon: responsive({
        kind: 'responsive',
        statuses: [{ name: 'LegacyAgent', status: 'running', pid: 201 }],
      }),
    });

    expect(snapshot.snapshot_status).toBe('complete');
    expect(snapshot.runtime.agents).toMatchObject({
      configured: 2,
      enabled: 1,
      observed_processes: 1,
      active_processes: 1,
      expected_missing: 0,
      disabled_active: 0,
      unregistered_active: 0,
    });
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_LEGACY_AGENT_ID_NONCANONICAL',
    );
    expect(snapshot.observations.map(item => item.code)).not.toEqual(expect.arrayContaining([
      'CORTEXT_STATUS_AGENT_ID_INVALID',
      'CORTEXT_STATUS_REGISTRY_INVALID',
    ]));
    expect(JSON.stringify(snapshot)).not.toContain('LegacyAgent');
    expect(JSON.stringify(redactLifecycleStatus(snapshot))).not.toContain('LegacyAgent');
    expect(evaluateStatusCheck(snapshot, 'usable@v1').result).toBe('pass');
  });

  it('blocks case-folding collisions introduced by legacy uppercase identities', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'alpha', 'LegacyAgent');
    addAgent(frameworkRoot, 'beta', 'legacyagent');

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.overall.status).toBe('blocked');
    expect(snapshot.runtime.agents.enabled).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toEqual(expect.arrayContaining([
      'CORTEXT_STATUS_LEGACY_AGENT_ID_NONCANONICAL',
      'CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION',
    ]));
  });

  it('blocks case-folding collisions visible only in responsive daemon status', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: responsive({
        kind: 'responsive',
        statuses: [
          { name: 'LegacyAgent', status: 'running' },
          { name: 'legacyagent', status: 'running' },
        ],
      }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.overall.status).toBe('blocked');
    expect(snapshot.runtime.agents.observed_processes).toBe(2);
    expect(snapshot.runtime.agents.unregistered_active).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION',
    );
    expect(evaluateStatusCheck(snapshot, 'usable@v1').result).toBe('fail');
  });

  it('enforces one identity budget across registry and responsive daemon sources', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    const registry = Object.fromEntries(
      Array.from({ length: 4096 }, (_, index) => [`agent${index}`, { enabled: true }]),
    );
    writeJson(join(ctxRoot, 'config', 'enabled-agents.json'), registry);

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: responsive({
        kind: 'responsive',
        statuses: [{ name: 'daemononly', status: 'running' }],
      }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.runtime.daemon).toMatchObject({
      status: 'unresponsive',
      ipc_status: 'invalid',
    });
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_DAEMON_RESPONSE_INVALID',
    );
  });

  it('keeps identifiers outside the bounded ASCII-case compatibility class invalid', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'team', 'agent.one', { enabled: true });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.runtime.agents.enabled).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_AGENT_ID_INVALID',
    );
  });

  it('blocks ambiguous cross-org basenames without hiding all-process counts', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'alpha', 'researcher');
    addAgent(frameworkRoot, 'beta', 'researcher');

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      pidAlive: () => true,
      probeDaemon: responsive({
        kind: 'responsive',
        statuses: [{ name: 'researcher', status: 'running', pid: 404 }],
      }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.overall.status).toBe('blocked');
    expect(snapshot.runtime.agents).toMatchObject({
      configured: 2,
      enabled: null,
      observed_processes: 1,
      active_processes: 1,
      running: 1,
      expected_missing: null,
      disabled_active: null,
      unregistered_active: null,
      recent_heartbeat: null,
      stale_heartbeat: null,
    });
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION',
    );
  });

  it('uses the two-hour heartbeat threshold without treating heartbeats as liveness', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'team', 'fresh');
    addAgent(frameworkRoot, 'team', 'stale');
    addAgent(frameworkRoot, 'team', 'broken');
    const now = new Date('2026-08-10T12:00:00.000Z');
    writeJson(join(ctxRoot, 'state', 'fresh', 'heartbeat.json'), {
      last_heartbeat: '2026-08-10T11:00:00.000Z',
      current_task: 'PRIVATE TASK CONTENT',
    });
    writeJson(join(ctxRoot, 'state', 'stale', 'heartbeat.json'), {
      last_heartbeat: '2026-08-10T09:59:59.000Z',
    });
    writeJson(join(ctxRoot, 'state', 'broken', 'heartbeat.json'), {
      last_heartbeat: 'not-a-time',
    });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      now,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.runtime.daemon.status).toBe('stopped');
    expect(snapshot.runtime.agents.recent_heartbeat).toBe(1);
    expect(snapshot.runtime.agents.stale_heartbeat).toBe(1);
    expect(snapshot.runtime.agents.observed_processes).toBeNull();
    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.overall.status).toBe('stopped');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE TASK CONTENT');
  });

  it('classifies a daemon timeout as partial and degraded', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'timeout' }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.runtime.daemon).toMatchObject({ status: 'unresponsive', ipc_status: 'timeout' });
    expect(snapshot.overall.status).toBe('degraded');
  });

  it('does not repair or back up a corrupt registry while observing it', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'team', 'observer');
    const configDir = join(ctxRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'enabled-agents.json'), '{ not json', 'utf-8');

    const before = readdirNames(configDir);
    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });
    const after = readdirNames(configDir);

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.runtime.agents.enabled).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toContain('CORTEXT_STATUS_REGISTRY_INVALID');
    expect(after).toEqual(before);
    expect(after).toEqual(['enabled-agents.json']);
  });

  it('fails closed on non-boolean agent config enabled state', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'team', 'observer', { enabled: 'false' });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.runtime.agents.enabled).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_AGENT_CONFIG_INVALID',
    );
    expect(evaluateStatusCheck(snapshot, 'usable@v1').reason_codes).toContain(
      'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
    );
  });

  it.each([
    ['non-string org', { org: 7, enabled: true }],
    ['non-boolean enabled state', { org: 'team', enabled: 'false' }],
  ])('fails closed on registry entries with %s', async (_label, registryEntry) => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'team', 'observer', { enabled: true });
    writeJson(join(ctxRoot, 'config', 'enabled-agents.json'), { observer: registryEntry });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.runtime.agents.enabled).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_REGISTRY_INVALID',
    );
    expect(evaluateStatusCheck(snapshot, 'usable@v1').reason_codes).toContain(
      'CORTEXT_CHECK_SNAPSHOT_INCOMPLETE',
    );
  });

  it('bounds oversized JSON sources instead of parsing unbounded registry input', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    const configDir = join(ctxRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      `{${' '.repeat(1024 * 1024)}}`,
      'utf-8',
    );

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.runtime.agents.enabled).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_REGISTRY_INVALID',
    );
  });

  it('fails closed when nested agent discovery exhausts its global entry budget', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    for (const org of ['first', 'second']) {
      const agentsRoot = join(frameworkRoot, 'orgs', org, 'agents');
      mkdirSync(agentsRoot, { recursive: true });
      for (let index = 0; index < 2048; index += 1) {
        writeFileSync(join(agentsRoot, `entry-${index}`), '', 'utf-8');
      }
    }

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.runtime.agents.enabled).toBeNull();
    expect(snapshot.observations.map(item => item.code)).toContain(
      'CORTEXT_STATUS_AGENT_CONFIG_INVALID',
    );
  });

  it('blocks a responsive instance whose state directory is missing', async () => {
    const { frameworkRoot, ctxRoot } = makeFixture();
    rmSync(join(ctxRoot, 'state'), { recursive: true, force: true });

    const snapshot = await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: responsive({ kind: 'responsive', statuses: [] }),
    });

    expect(snapshot.snapshot_status).toBe('partial');
    expect(snapshot.state.status).toBe('missing');
    expect(snapshot.overall.status).toBe('blocked');
    expect(snapshot.observations.map(item => item.code)).toContain('CORTEXT_STATUS_STATE_MISSING');
    expect(evaluateStatusCheck(snapshot, 'usable@v1').reason_codes).toContain(
      'CORTEXT_CHECK_STATE_NOT_READABLE',
    );
    expect(evaluateStatusCheck(snapshot, 'healthy@v1').result).toBe('fail');
  });

  it('does not let an explicit instance consume an ambient root for another instance', async () => {
    const home = tempRoot('explicit-instance');
    const frameworkRoot = join(home, 'framework');
    const canonicalRoot = join(home, '.cortextos', 'wanted');
    const ambientRoot = join(home, '.cortextos', 'other');
    mkdirSync(frameworkRoot, { recursive: true });
    mkdirSync(join(canonicalRoot, 'state'), { recursive: true });
    mkdirSync(join(ambientRoot, 'state'), { recursive: true });
    writeJson(join(frameworkRoot, 'package.json'), {
      name: 'cortextos', version: CORTEXTOS_VERSION,
    });
    process.env.CTX_ROOT = ambientRoot;

    const snapshot = await collectLegacyStatus({
      instanceId: 'wanted',
      homeDir: home,
      frameworkRoot,
      includePaths: true,
      probeDaemon: async () => ({ kind: 'absent' }),
    });

    expect(snapshot.state.root).toBe(canonicalRoot);
    expect(snapshot.observations.map(item => item.code)).not.toContain(
      'CORTEXT_STATUS_LEGACY_ROOT_AUTHORITY_UNPROVEN',
    );
  });

  it('leaves complete framework and instance tree metadata unchanged', async () => {
    const { root, frameworkRoot, ctxRoot } = makeFixture();
    addAgent(frameworkRoot, 'team', 'observer', { enabled: true });
    mkdirSync(join(ctxRoot, 'state', 'observer'), { recursive: true });
    writeJson(join(ctxRoot, 'config', 'enabled-agents.json'), {
      observer: { org: 'team', enabled: true },
    });
    writeJson(join(ctxRoot, 'state', 'observer', 'heartbeat.json'), {
      last_heartbeat: '2026-08-10T11:00:00.000Z',
    });
    execFileSync('git', ['init'], { cwd: frameworkRoot, stdio: 'ignore' });
    // Disable git's background auto-maintenance/gc on the fixture repo. Otherwise a git
    // invocation (the commit below, or one collectLegacyStatus spawns) can trigger
    // `git maintenance run --auto`, which creates a transient `.git/objects/maintenance.lock`.
    // The treeMetadata walk then races that file: readdirSync enumerates it but it vanishes
    // before lstatSync, throwing ENOENT and flaking this snapshot comparison.
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: frameworkRoot });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: frameworkRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: frameworkRoot });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: frameworkRoot });
    execFileSync('git', ['add', '.'], { cwd: frameworkRoot });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: frameworkRoot, stdio: 'ignore' });
    const before = treeMetadata(root);

    await collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      now: new Date('2026-08-10T12:00:00.000Z'),
      probeDaemon: responsive({
        kind: 'responsive',
        statuses: [{ name: 'observer', status: 'running', pid: 1 }],
      }),
      pidAlive: () => true,
    });

    expect(treeMetadata(root)).toEqual(before);
  });

  it('constructs redacted output from an allowlist and excludes canary private data', async () => {
    const root = tempRoot('PRIVATE_PATH_CANARY');
    const frameworkRoot = join(root, 'framework-private');
    const ctxRoot = join(root, 'state-private');
    mkdirSync(frameworkRoot, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    writeJson(join(frameworkRoot, 'package.json'), { name: 'cortextos', version: '0.1.1' });
    addAgent(frameworkRoot, 'privateorg', 'privateagent', {
      enabled: true,
      api_key: 'SECRET_VALUE_CANARY',
    });
    writeJson(join(ctxRoot, 'state', 'privateagent', 'heartbeat.json'), {
      last_heartbeat: '2026-08-10T11:00:00.000Z',
      current_task: 'PRIVATE_TASK_CANARY',
    });

    const local = await collectLegacyStatus({
      instanceId: 'private-instance',
      ctxRoot,
      frameworkRoot,
      includePaths: true,
      now: new Date('2026-08-10T12:00:00.000Z'),
      pidAlive: () => true,
      probeDaemon: responsive({
        kind: 'responsive',
        statuses: [{ name: 'privateagent', status: 'running', pid: 1 }],
      }),
    });
    const redacted = redactLifecycleStatus(local, '00000000-0000-4000-8000-000000000000');
    const serialized = JSON.stringify(redacted);

    for (const canary of [
      root,
      'private-instance',
      'privateorg',
      'privateagent',
      'SECRET_VALUE_CANARY',
      'PRIVATE_TASK_CANARY',
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(redacted.scope.instance_alias).toBe('instance_1');
    expect(redacted.runtime.agent_count_bucket).toBe('1');
    expect(redacted.runtime.active_process_count_bucket).toBe('1');
    expect(redacted.components.declared_count_bucket).toBeNull();
    expect(Object.keys(redacted)).toEqual([
      'schema_version', 'ok', 'report_id', 'observed_day', 'snapshot_status',
      'scope', 'manager', 'capabilities', 'basis', 'consistency', 'device',
      'application', 'instance', 'state', 'components', 'runtime', 'recovery',
      'updates', 'compatibility', 'overall', 'check', 'observations',
    ]);
  });
});

function readdirNames(path: string): string[] {
  return readdirSync(path).sort();
}

describe('lifecycle status option and error contracts', () => {
  it('rejects redacted paths and emits a closed redacted error envelope', () => {
    let error: LifecycleStatusCliError | null = null;
    try {
      validateLifecycleStatusOptions({ json: true, redact: true, paths: true });
    } catch (caught) {
      error = caught as LifecycleStatusCliError;
    }
    expect(error).toMatchObject({
      code: 'CORTEXT_STATUS_INVALID_OPTION_COMBINATION',
      exitCode: 2,
      detailCode: 'REDACT_WITH_PATHS',
    });
    expect(redactedErrorEnvelope(error!)).toEqual({
      schema_version: 'cortext.status.redacted.error/v1',
      ok: false,
      error: {
        code: 'CORTEXT_STATUS_INVALID_OPTION_COMBINATION',
        message: 'The selected redacted-output options cannot be combined.',
        detail_code: 'REDACT_WITH_PATHS',
      },
    });
  });

  it('uses a candidate count as the only local ambiguity detail', () => {
    const error = new LifecycleStatusCliError(
      'CORTEXT_STATUS_INSTANCE_AMBIGUOUS',
      2,
      'INSTANCE_AMBIGUOUS',
      { candidate_count: 3 },
    );
    expect(localErrorEnvelope(error).error).toEqual({
      code: 'CORTEXT_STATUS_INSTANCE_AMBIGUOUS',
      message: 'Select exactly one Cortext instance.',
      details: { candidate_count: 3 },
    });
  });

  it('keeps local and redacted contract negotiation separate', () => {
    expect(() => validateLifecycleStatusOptions({
      json: true,
      contract: 'cortext.status/v1',
    })).not.toThrow();
    expect(() => validateLifecycleStatusOptions({
      json: true,
      redact: true,
      contract: 'cortext.status.redacted/v1',
    })).not.toThrow();
    expect(() => validateLifecycleStatusOptions({
      json: true,
      redact: true,
      contract: 'cortext.status/v1',
    })).toThrowError(expect.objectContaining({
      code: 'CORTEXT_STATUS_CONTRACT_MODE_MISMATCH',
      exitCode: 4,
    }));
  });

  it('uses static local error messages without dynamic paths or exceptions', () => {
    const error = new LifecycleStatusCliError(
      'CORTEXT_STATUS_COLLECTION_FAILED', 3, 'COLLECTION_FAILED',
    );
    expect(localErrorEnvelope(error)).toEqual({
      schema_version: 'cortext.status.error/v1',
      ok: false,
      error: {
        code: 'CORTEXT_STATUS_COLLECTION_FAILED',
        message: 'A trustworthy lifecycle status snapshot could not be assembled.',
        details: { detail_code: 'COLLECTION_FAILED' },
      },
    });
  });

  it('rejects an unsupported check policy before collection', () => {
    expect(() => normalizeStatusCheckPolicy('whatever@v1'))
      .toThrow(UnsupportedStatusCheckPolicyError);
    expect(() => validateLifecycleStatusOptions({ check: 'whatever@v1' }))
      .toThrow(UnsupportedStatusCheckPolicyError);
  });
});

describe('lifecycle status check policies', () => {
  async function healthyLegacySnapshot() {
    const { frameworkRoot, ctxRoot } = makeFixture();
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    return collectLegacyStatus({
      instanceId: 'default',
      ctxRoot,
      frameworkRoot,
      probeDaemon: responsive({ kind: 'responsive', statuses: [] }),
    });
  }

  it('keeps unversioned policy names as permanent v1 aliases', async () => {
    const snapshot = await healthyLegacySnapshot();
    expect(evaluateStatusCheck(snapshot, 'healthy')).toEqual(
      evaluateStatusCheck(snapshot, 'healthy@v1'),
    );
    expect(evaluateStatusCheck(snapshot, 'healthy')).toEqual({
      policy: 'healthy',
      policy_version: 'cortext.check.healthy/v1',
      result: 'pass',
      reason_codes: [],
    });
    expect(evaluateStatusCheck(snapshot, 'usable@v1').result).toBe('pass');
  });

  it('derives CLI and lifecycle version evidence from package metadata', () => {
    expect(CORTEXTOS_VERSION).toBe(packageMetadata.version);
  });

  it('fails update-safe closed on unsupported legacy capabilities in exact order', async () => {
    const snapshot = await healthyLegacySnapshot();
    expect(evaluateStatusCheck(snapshot, 'update-safe@v1')).toEqual({
      policy: 'update-safe',
      policy_version: 'cortext.check.update-safe/v1',
      result: 'fail',
      reason_codes: [
        'CORTEXT_CHECK_PROFILE_UNSUPPORTED',
        'CORTEXT_CHECK_MANAGER_INTEGRITY_UNVERIFIED',
        'CORTEXT_CHECK_CONSISTENCY_UNSTABLE',
        'CORTEXT_CHECK_BASIS_INCOMPLETE',
        'CORTEXT_CHECK_WRITER_NOT_ACTIVE',
        'CORTEXT_CHECK_MIGRATION_NOT_IDLE',
        'CORTEXT_CHECK_APPLICATION_UNVERIFIED',
        'CORTEXT_CHECK_COMPATIBILITY_UNSAFE',
        'CORTEXT_CHECK_CHECKPOINT_UNVERIFIED',
        'CORTEXT_CHECK_BACKUP_UNVERIFIED',
        'CORTEXT_CHECK_ROLLBACK_NOT_READY',
      ],
    });
  });

  it('never lets healthy or update-safe pass when usable fails', async () => {
    const healthy = await healthyLegacySnapshot();
    const blocked = structuredClone(healthy) as any;
    blocked.overall.status = 'blocked';
    blocked.overall.highest_severity = null;
    blocked.capabilities.profile = 'managed_running_v1';
    blocked.manager.integrity = 'verified';
    blocked.manager.trust_status = 'verified';
    blocked.manager.recovery_launcher_status = 'verified';
    blocked.consistency.status = 'stable';
    for (const key of [
      'trust_metadata_revision',
      'compatibility_matrix_revision',
      'lifecycle_generation',
      'writer_epoch',
      'selected_release_id',
      'config_revision',
      'observation_manifest_version',
      'config_observation_digest',
      'state_schema',
      'state_layout_generation',
      'state_control_observation_digest',
      'component_lock_revision',
    ]) blocked.basis[key] = 'present';
    blocked.device.writer_role = 'active';
    blocked.device.lease_status = 'held';
    blocked.state.migration_status = 'idle';
    blocked.application.integrity = 'verified';
    blocked.compatibility.status = 'compatible';
    blocked.recovery.latest_checkpoint.verification = 'passed';
    blocked.recovery.latest_state_backup.verification = 'passed';
    blocked.recovery.rollback_status = 'ready';

    expect(evaluateStatusCheck(blocked, 'usable@v1').result).toBe('fail');
    expect(evaluateStatusCheck(blocked, 'healthy@v1').result).toBe('fail');
    const updateSafe = evaluateStatusCheck(blocked, 'update-safe@v1');
    expect(updateSafe.result).toBe('fail');
    expect(updateSafe.reason_codes).toContain('CORTEXT_CHECK_OVERALL_DISALLOWED');
  });

  it('does not let a forged derived overall hide a canonical blocking observation', async () => {
    const healthy = await healthyLegacySnapshot();
    const forged = structuredClone(healthy) as any;
    forged.overall.status = 'degraded';
    forged.observations.push({
      code: 'CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION',
      severity: 'info',
      domain: 'legacy',
      summary: 'forged',
      recommended_operation: null,
    });

    expect(evaluateStatusCheck(forged, 'usable@v1')).toMatchObject({
      result: 'fail',
      reason_codes: expect.arrayContaining(['CORTEXT_CHECK_OVERALL_DISALLOWED']),
    });
    expect(evaluateStatusCheck(forged, 'healthy@v1')).toMatchObject({
      result: 'fail',
      reason_codes: expect.arrayContaining(['CORTEXT_CHECK_LIFECYCLE_ERROR_PRESENT']),
    });
  });

  it('orders namespace and containment failures by the pinned v1 sequence', async () => {
    const snapshot = await healthyLegacySnapshot();
    expect(evaluateStatusCheck(snapshot, 'sandbox-namespace@v1').reason_codes).toEqual([
      'CORTEXT_CHECK_TARGET_NOT_SANDBOX',
      'CORTEXT_CHECK_ROOTS_NOT_ISOLATED',
      'CORTEXT_CHECK_PROCESSES_NOT_ISOLATED',
      'CORTEXT_CHECK_INTEGRATIONS_NOT_ROUTED',
      'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
    ]);
    expect(evaluateStatusCheck(snapshot, 'security-contained@v1').reason_codes).toEqual([
      'CORTEXT_CHECK_TARGET_NOT_SANDBOX',
      'CORTEXT_CHECK_ROOTS_NOT_ISOLATED',
      'CORTEXT_CHECK_PROCESSES_NOT_ISOLATED',
      'CORTEXT_CHECK_INTEGRATIONS_NOT_ROUTED',
      'CORTEXT_CHECK_BOUNDARY_INSUFFICIENT',
      'CORTEXT_CHECK_CREDENTIALS_EXPOSED',
      'CORTEXT_CHECK_NETWORK_UNCONSTRAINED',
      'CORTEXT_CHECK_HOST_ACCESS_FULL',
      'CORTEXT_CHECK_ISOLATION_EVIDENCE_MISSING',
    ]);
  });

  it('projects only the closed check result into redacted output', async () => {
    const collected = await healthyLegacySnapshot();
    const check = evaluateStatusCheck(collected, 'update-safe@v1');
    const redacted = redactLifecycleStatus(
      { ...collected, check },
      '00000000-0000-4000-8000-000000000000',
    );
    expect(redacted.check).toEqual(check);
  });

  it('never strengthens unknown target or layout evidence in human output', async () => {
    const snapshot = await healthyLegacySnapshot();
    const unknown = {
      ...snapshot,
      scope: { ...snapshot.scope, target_kind: 'unknown' as const, layout_kind: 'unknown' as const },
    };
    const redacted = redactLifecycleStatus(
      unknown,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(renderLocalHuman(unknown)).toContain('UNKNOWN / LAYOUT UNKNOWN');
    expect(renderRedactedHuman(redacted)).toContain('UNKNOWN / LAYOUT UNKNOWN / REDACTED');
  });
});
