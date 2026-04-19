import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Two temp dirs: one for state (CTX_ROOT), one for framework (CTX_FRAMEWORK_ROOT).
// Both env vars must be set BEFORE we import ../config, because that module
// resolves its path constants at import time.
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'cortextos-state-'));
const tmpFramework = fs.mkdtempSync(path.join(os.tmpdir(), 'cortextos-framework-'));
process.env.CTX_ROOT = tmpState;
process.env.CTX_FRAMEWORK_ROOT = tmpFramework;

fs.mkdirSync(path.join(tmpState, 'orgs'), { recursive: true });
fs.mkdirSync(path.join(tmpFramework, 'orgs'), { recursive: true });

let getOrgs: typeof import('../../../dashboard/src/lib/config')['getOrgs'];

beforeAll(async () => {
  const configMod = await import('../../../dashboard/src/lib/config');
  getOrgs = configMod.getOrgs;
});

function resetOrgs(): void {
  for (const base of [path.join(tmpState, 'orgs'), path.join(tmpFramework, 'orgs')]) {
    for (const entry of fs.readdirSync(base)) {
      fs.rmSync(path.join(base, entry), { recursive: true, force: true });
    }
  }
}

function mkorg(base: 'state' | 'framework', name: string): void {
  const root = base === 'state' ? tmpState : tmpFramework;
  fs.mkdirSync(path.join(root, 'orgs', name), { recursive: true });
}

describe('getOrgs case-insensitive dedupe', () => {
  it('same org in both dirs with drifted casing: returns ONE entry using framework casing', () => {
    resetOrgs();
    // This is the exact scenario observed in production: canonical AcmeCorp
    // in framework root, stale lowercase acmecorp in state dir from a
    // historical kb-* invocation with a lowercase --org argument.
    mkorg('framework', 'AcmeCorp');
    mkorg('state', 'acmecorp');
    mkorg('state', 'AcmeCorp');

    const orgs = getOrgs();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toBe('AcmeCorp');
  });

  it('org only in state (no framework entry): returns state casing as fallback', () => {
    resetOrgs();
    mkorg('state', 'leftover');

    const orgs = getOrgs();
    expect(orgs).toEqual(['leftover']);
  });

  it('org only in framework: returns framework casing', () => {
    resetOrgs();
    mkorg('framework', 'AcmeCorp');

    const orgs = getOrgs();
    expect(orgs).toEqual(['AcmeCorp']);
  });

  it('both dirs empty: returns empty array', () => {
    resetOrgs();
    expect(getOrgs()).toEqual([]);
  });

  it('multiple orgs: framework wins per-org, state-only orgs included', () => {
    resetOrgs();
    // widgetco exists in both with matching casing; AcmeCorp has drift;
    // stateonly exists only in state.
    mkorg('framework', 'widgetco');
    mkorg('state', 'widgetco');
    mkorg('framework', 'AcmeCorp');
    mkorg('state', 'acmecorp');
    mkorg('state', 'stateonly');

    const orgs = getOrgs().sort();
    expect(orgs).toEqual(['AcmeCorp', 'stateonly', 'widgetco']);
  });
});
