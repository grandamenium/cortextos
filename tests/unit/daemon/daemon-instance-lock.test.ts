import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const daemonModule = await import('../../../src/daemon/index.js') as Record<string, unknown>;
const roots: string[] = [];

afterEach(() => {
  const release = daemonModule.releaseDaemonInstanceLock as ((ctxRoot: string) => void) | undefined;
  for (const root of roots.splice(0)) {
    release?.(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('daemon instance lock', () => {
  it('allows only one live daemon per ctx root', () => {
    const acquire = daemonModule.acquireDaemonInstanceLock as
      | ((ctxRoot: string) => boolean)
      | undefined;
    expect(acquire).toBeTypeOf('function');

    const root = mkdtempSync(join(tmpdir(), 'cortextos-daemon-lock-'));
    roots.push(root);

    expect(acquire!(root)).toBe(true);
    expect(acquire!(root)).toBe(false);
  });
});
