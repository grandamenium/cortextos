import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// CTX_ROOT and CTX_FRAMEWORK_ROOT are module-level consts in config.ts, read
// once at import time. Set them BEFORE the dynamic import below, and keep them
// DIFFERENT from each other — if they were equal, every assertion here would
// pass trivially and prove nothing about which root was chosen.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdir-state-'));
const frameworkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdir-framework-'));
process.env.CTX_ROOT = stateRoot;
process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

let getAgentDir: typeof import('../config')['getAgentDir'];
let getAgentsForOrg: typeof import('../config')['getAgentsForOrg'];

beforeAll(async () => {
  const mod = await import('../config');
  getAgentDir = mod.getAgentDir;
  getAgentsForOrg = mod.getAgentsForOrg;

  expect(stateRoot).not.toBe(frameworkRoot);
});

/**
 * getAgentDir used to pick between the framework root and CTX_ROOT with an
 * existsSync probe. That made resolution timing-dependent: the same logical
 * agent resolved to a different directory depending on whether the framework
 * path happened to exist yet. A lock keyed on such a path excludes nothing
 * during the creation window — precisely where creation races live.
 *
 * Every test below fails against that old implementation. That is the point:
 * they pin *determinism*, not merely the happy path.
 */
describe('getAgentDir path resolution', () => {
  it('returns the framework path when NOTHING exists on disk', () => {
    // Old behaviour: neither path exists -> falls through to the CTX_ROOT path.
    expect(getAgentDir('ghost', 'acme')).toBe(
      path.join(frameworkRoot, 'orgs', 'acme', 'agents', 'ghost'),
    );
  });

  it('returns the framework path even when ONLY the state-dir copy exists', () => {
    // The decoy case. A state-dir copy is the one thing that could tempt a
    // resolver away from the framework root, and the CLI would never read it.
    const decoy = path.join(stateRoot, 'orgs', 'acme', 'agents', 'decoybot');
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, 'config.json'), '{"decoy":true}\n');

    expect(fs.existsSync(decoy)).toBe(true);
    expect(getAgentDir('decoybot', 'acme')).toBe(
      path.join(frameworkRoot, 'orgs', 'acme', 'agents', 'decoybot'),
    );
  });

  it('resolves identically before and after the framework dir is created', () => {
    // The timing-dependence assertion, stated directly. Under the old code the
    // two calls returned DIFFERENT roots, which is the whole defect.
    const before = getAgentDir('racer', 'acme');

    const created = path.join(frameworkRoot, 'orgs', 'acme', 'agents', 'racer');
    fs.mkdirSync(created, { recursive: true });

    const after = getAgentDir('racer', 'acme');

    expect(before).toBe(after);
    expect(after).toBe(created);
  });

  it('never returns a path under CTX_ROOT, in any on-disk state', () => {
    const flatDecoy = path.join(stateRoot, 'agents', 'flatbot');
    fs.mkdirSync(flatDecoy, { recursive: true });

    for (const resolved of [
      getAgentDir('flatbot'),
      getAgentDir('missing'),
      getAgentDir('missing', 'acme'),
      getAgentDir('decoybot', 'acme'),
    ]) {
      expect(resolved.startsWith(stateRoot)).toBe(false);
      expect(resolved.startsWith(frameworkRoot)).toBe(true);
    }
  });

  it('uses the flat <framework>/agents/<name> shape when no org is given', () => {
    expect(getAgentDir('flatbot')).toBe(path.join(frameworkRoot, 'agents', 'flatbot'));
  });

  it('is a pure function of its arguments — no filesystem probe', () => {
    const first = getAgentDir('purity', 'acme');

    const p = path.join(frameworkRoot, 'orgs', 'acme', 'agents', 'purity');
    fs.mkdirSync(p, { recursive: true });
    expect(getAgentDir('purity', 'acme')).toBe(first);

    fs.rmSync(p, { recursive: true, force: true });
    expect(getAgentDir('purity', 'acme')).toBe(first);
  });
});

/**
 * The asymmetry is deliberate and load-bearing, so pin it. getAgentDir is
 * RESOLUTION (single-valued); getAgentsForOrg is DISCOVERY (a union, harmless
 * for listing). dashboard/src/lib/sync.ts imports getAgentsForOrg and never
 * getAgentDir — collapsing the union to match the resolver would break sync's
 * ability to see agents it has only state-dir evidence for.
 */
describe('getAgentsForOrg discovery is intentionally NOT narrowed', () => {
  it('still unions the state dir and the framework root', () => {
    fs.mkdirSync(path.join(stateRoot, 'orgs', 'unionorg', 'agents', 'fromstate'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(frameworkRoot, 'orgs', 'unionorg', 'agents', 'fromframework'), {
      recursive: true,
    });

    expect(getAgentsForOrg('unionorg').sort()).toEqual(['fromframework', 'fromstate']);
  });
});
