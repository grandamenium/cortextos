import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeVaultHealth, PLACEHOLDER } from '../vault-health';

const BASE = 1_750_000_000_000;
const MIN = 60_000;

function seed(vaultRoot: string, opts: { board?: string; boardMtime?: number; ps?: string; psMtime?: number }): void {
  const dir = join(vaultRoot, 'agent-shared');
  mkdirSync(dir, { recursive: true });
  if (opts.board !== undefined) {
    const p = join(dir, 'active-tasks.md');
    writeFileSync(p, opts.board, 'utf-8');
    if (opts.boardMtime) utimesSync(p, opts.boardMtime / 1000, opts.boardMtime / 1000);
  }
  if (opts.ps !== undefined) {
    const p = join(dir, 'project-state.md');
    writeFileSync(p, opts.ps, 'utf-8');
    if (opts.psMtime) utimesSync(p, opts.psMtime / 1000, opts.psMtime / 1000);
  }
}

describe('computeVaultHealth', () => {
  let vaultRoot: string;
  beforeEach(() => { vaultRoot = mkdtempSync(join(tmpdir(), 'vault-health-')); });
  afterEach(() => rmSync(vaultRoot, { recursive: true, force: true }));

  it('reports ok when both files are fresh', () => {
    seed(vaultRoot, { board: '# board', boardMtime: BASE, ps: '# state', psMtime: BASE });
    const h = computeVaultHealth(vaultRoot, BASE + 2 * MIN);
    expect(h.status).toBe('ok');
    expect(h.messages).toEqual([]);
  });

  it('reports down when the board is missing', () => {
    seed(vaultRoot, { ps: '# state', psMtime: BASE });
    const h = computeVaultHealth(vaultRoot, BASE);
    expect(h.status).toBe('down');
    expect(h.board.exists).toBe(false);
    expect(h.messages[0]).toMatch(/board is missing/);
  });

  it('reports down when the board still holds the dead-updater placeholder', () => {
    seed(vaultRoot, { board: `# board\n| ${PLACEHOLDER} |`, boardMtime: BASE, ps: '# state', psMtime: BASE });
    const h = computeVaultHealth(vaultRoot, BASE + 1 * MIN);
    expect(h.status).toBe('down');
    expect(h.board.placeholder).toBe(true);
    expect(h.messages[0]).toMatch(/placeholder/);
  });

  it('reports stale when the board is older than 15 minutes', () => {
    seed(vaultRoot, { board: '# board', boardMtime: BASE, ps: '# state', psMtime: BASE + 20 * MIN });
    const h = computeVaultHealth(vaultRoot, BASE + 20 * MIN);
    expect(h.status).toBe('stale');
    expect(h.board.stale).toBe(true);
    expect(h.messages[0]).toMatch(/board is 20m old/);
  });

  it('reports stale when project-state is missing even if the board is fresh', () => {
    seed(vaultRoot, { board: '# board', boardMtime: BASE });
    const h = computeVaultHealth(vaultRoot, BASE + 2 * MIN);
    expect(h.status).toBe('stale');
    expect(h.projectState.exists).toBe(false);
  });
});
