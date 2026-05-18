import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() {
    return {
      spawn: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn(),
      write: vi.fn(),
      getPid: vi.fn().mockReturnValue(1),
      isAlive: vi.fn().mockReturnValue(true),
      onExit: vi.fn(),
    };
  },
}));
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));
vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test' }),
}));
vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

import { AgentProcess } from '../../../src/daemon/agent-process';
import type { CtxEnv, AgentConfig } from '../../../src/types';

describe('AgentProcess — handoff auto-resume one-shot', () => {
  let ctxRoot: string;
  let env: CtxEnv;
  const cfg: AgentConfig = {} as AgentConfig;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-handoff-test-'));
    env = { ctxRoot, instanceId: 'test', agentDir: ctxRoot } as CtxEnv;
  });

  it('returns false when no handoff marker was consumed', () => {
    const agent = new AgentProcess('a1', env, cfg);
    expect(agent.consumeHandoffAutoResume()).toBe(false);
    // calling twice is still false — flag stays cleared
    expect(agent.consumeHandoffAutoResume()).toBe(false);
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('returns true once after handoff marker, then false (one-shot semantics)', () => {
    // Create a real handoff marker + handoff doc so consumeHandoffBlock() flips the flag
    const stateDir = join(ctxRoot, 'state', 'a2');
    mkdirSync(stateDir, { recursive: true });
    const docPath = join(ctxRoot, 'handoff-doc.md');
    writeFileSync(docPath, '# Prior session state');
    writeFileSync(join(stateDir, '.handoff-doc-path'), docPath);

    const agent = new AgentProcess('a2', env, cfg);
    const block = (agent as any).consumeHandoffBlock() as string;
    expect(block).toContain('CONTEXT HANDOFF');
    expect(block).toContain(docPath);
    // Marker was unlinked
    expect(existsSync(join(stateDir, '.handoff-doc-path'))).toBe(false);

    // First call after the handoff = true
    expect(agent.consumeHandoffAutoResume()).toBe(true);
    // Second call = false (one-shot)
    expect(agent.consumeHandoffAutoResume()).toBe(false);
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('returns empty + does not set flag when marker exists but doc path is missing', () => {
    const stateDir = join(ctxRoot, 'state', 'a3');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.handoff-doc-path'), '/nonexistent/path');

    const agent = new AgentProcess('a3', env, cfg);
    const block = (agent as any).consumeHandoffBlock() as string;
    expect(block).toBe('');
    expect(agent.consumeHandoffAutoResume()).toBe(false);
    rmSync(ctxRoot, { recursive: true, force: true });
  });
});
