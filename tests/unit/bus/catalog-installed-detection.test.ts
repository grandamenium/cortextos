/**
 * tests/unit/bus/catalog-installed-detection.test.ts — regression guard for #295.
 *
 * `browseCatalog` derived `installed` solely from `.installed-community.json`,
 * which is only written by `installCommunityItem`. Items present on disk but
 * installed by any other route (shipped/default skills, manual copies) were
 * therefore reported `installed: false` forever, breaking the catalog-browse
 * cron's new-vs-existing recommendation logic.
 *
 * The fix cross-references the item's actual on-disk target directory (the same
 * path `installCommunityItem` writes to) in addition to the registry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { browseCatalog } from '../../../src/bus/catalog';

let frameworkRoot: string;
let ctxRoot: string;
let agentDir: string;

function writeCatalog(items: Array<{ name: string; type: 'skill' | 'agent' | 'org' }>) {
  const catalog = {
    version: '1.0.0',
    updated_at: '2026-04-15T00:00:00Z',
    items: items.map(i => ({
      name: i.name,
      description: 'test',
      author: 'test',
      type: i.type,
      version: '1.0.0',
      tags: [],
      dependencies: [],
      install_path: `community/skills/${i.name}`,
    })),
  };
  writeFileSync(join(frameworkRoot, 'community', 'catalog.json'), JSON.stringify(catalog));
}

function find(items: Array<{ name: string; installed?: boolean }>, name: string) {
  return items.find(i => i.name === name);
}

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'browse-fw-'));
  ctxRoot = mkdtempSync(join(tmpdir(), 'browse-ctx-'));
  agentDir = mkdtempSync(join(tmpdir(), 'browse-agent-'));
  mkdirSync(join(frameworkRoot, 'community'), { recursive: true });
});

afterEach(() => {
  for (const d of [frameworkRoot, ctxRoot, agentDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('browseCatalog installed-detection (#295)', () => {
  it('reports installed:true for a skill present on disk even with no registry entry', () => {
    writeCatalog([{ name: 'heartbeat', type: 'skill' }]);
    // Skill exists in the harness skills dir but was NEVER recorded in
    // .installed-community.json (shipped/default install path).
    mkdirSync(join(agentDir, '.claude', 'skills', 'heartbeat'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'skills', 'heartbeat', 'SKILL.md'), '# heartbeat');

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(r.status).toBe('ok');
    expect(find(r.items, 'heartbeat')?.installed).toBe(true);
  });

  it('still reports installed:true when recorded in the registry (no on-disk dir)', () => {
    writeCatalog([{ name: 'tasks', type: 'skill' }]);
    writeFileSync(
      join(ctxRoot, '.installed-community.json'),
      JSON.stringify({ tasks: { version: '1.0.0', type: 'skill', installed_at: 'x', path: 'y' } }),
    );

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(find(r.items, 'tasks')?.installed).toBe(true);
  });

  it('reports installed:false when neither on disk nor in the registry', () => {
    writeCatalog([{ name: 'autoresearch', type: 'skill' }]);
    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(find(r.items, 'autoresearch')?.installed).toBe(false);
  });

  it('detects on-disk presence for non-skill (agent) items under templates/personas', () => {
    writeCatalog([{ name: 'analyst', type: 'agent' }]);
    mkdirSync(join(frameworkRoot, 'templates', 'personas', 'analyst'), { recursive: true });

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(find(r.items, 'analyst')?.installed).toBe(true);
  });

  it('detects on-disk presence for org items under templates/orgs', () => {
    writeCatalog([{ name: 'sales', type: 'org' }]);
    mkdirSync(join(frameworkRoot, 'templates', 'orgs', 'sales'), { recursive: true });

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(find(r.items, 'sales')?.installed).toBe(true);
  });

  it('falls back to frameworkRoot/.claude/skills when agentDir is not supplied', () => {
    writeCatalog([{ name: 'comms', type: 'skill' }]);
    // No agentDir → skills are resolved under frameworkRoot.
    mkdirSync(join(frameworkRoot, '.claude', 'skills', 'comms'), { recursive: true });

    const r = browseCatalog(frameworkRoot, ctxRoot, {});
    expect(find(r.items, 'comms')?.installed).toBe(true);
  });

  it('treats a present (even empty) skill dir as installed — matches installCommunityItem already_exists semantics', () => {
    writeCatalog([{ name: 'tasks', type: 'skill' }]);
    // Bare directory, no SKILL.md payload. installCommunityItem's own
    // already_exists guard uses the same bare existsSync check, so browse must
    // agree or the two views of "installed" drift (#295).
    mkdirSync(join(agentDir, '.claude', 'skills', 'tasks'), { recursive: true });

    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(find(r.items, 'tasks')?.installed).toBe(true);
  });

  it('unknown item type falls back to registry-only detection (no on-disk target)', () => {
    // type 'org' present in catalog but registry-only; force an unrecognised
    // type via a hand-written catalog to exercise the null-target branch.
    const catalog = {
      version: '1.0.0',
      updated_at: '2026-04-15T00:00:00Z',
      items: [{
        name: 'mystery', description: 't', author: 't', type: 'plugin',
        version: '1.0.0', tags: [], dependencies: [], install_path: 'community/skills/mystery',
      }],
    };
    writeFileSync(join(frameworkRoot, 'community', 'catalog.json'), JSON.stringify(catalog));
    // Even if a same-named dir exists somewhere, an unknown type yields no
    // resolvable target, so detection is registry-only → false here.
    const r = browseCatalog(frameworkRoot, ctxRoot, { agentDir });
    expect(find(r.items, 'mystery')?.installed).toBe(false);
  });
});
