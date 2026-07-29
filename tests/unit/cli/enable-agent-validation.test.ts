/**
 * Regression tests for the multi-bug batch PR:
 *
 * - BUG-035: discoverProjectRoot() — cwd-independent project root discovery
 * - BUG-013: corrupt-registry handling, now owned by mutateEnabledAgents()
 *
 * The point of these tests is to lock in the contract: enable's CLI must work
 * from any cwd, and corrupt JSON must NEVER be silently destroyed. See the
 * comment on the second describe block for what changed and why.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverProjectRoot } from '../../../src/cli/enable-agent';
import { mutateEnabledAgents, CorruptRegistryError } from '../../../src/utils/enabled-agents';

describe('BUG-035 + BUG-013: enable-agent validation', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  const origFw = process.env.CTX_FRAMEWORK_ROOT;
  const origPr = process.env.CTX_PROJECT_ROOT;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-batch-'));
    process.env.HOME = tmpHome;
    delete process.env.CTX_FRAMEWORK_ROOT;
    delete process.env.CTX_PROJECT_ROOT;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origFw === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = origFw;
    if (origPr === undefined) delete process.env.CTX_PROJECT_ROOT;
    else process.env.CTX_PROJECT_ROOT = origPr;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('discoverProjectRoot (BUG-035)', () => {
    it('honors CTX_FRAMEWORK_ROOT when set', () => {
      process.env.CTX_FRAMEWORK_ROOT = '/some/explicit/path';
      expect(discoverProjectRoot()).toBe('/some/explicit/path');
    });

    it('falls back to CTX_PROJECT_ROOT when CTX_FRAMEWORK_ROOT is unset', () => {
      process.env.CTX_PROJECT_ROOT = '/legacy/path';
      expect(discoverProjectRoot()).toBe('/legacy/path');
    });

    it('discovers ~/cortextos when both env vars are unset and the canonical install exists', () => {
      // Create a fake ~/cortextos with an orgs/ dir (the canonical marker)
      mkdirSync(join(tmpHome, 'cortextos', 'orgs'), { recursive: true });
      expect(discoverProjectRoot()).toBe(join(tmpHome, 'cortextos'));
    });

    it('also recognizes ~/cortextos via legacy agents/ dir', () => {
      mkdirSync(join(tmpHome, 'cortextos', 'agents'), { recursive: true });
      expect(discoverProjectRoot()).toBe(join(tmpHome, 'cortextos'));
    });

    it('falls back to process.cwd() when nothing else applies (legacy behavior preserved)', () => {
      // No env vars, no ~/cortextos at all
      expect(discoverProjectRoot()).toBe(process.cwd());
    });
  });

  /**
   * These cases used to target `readEnabledAgents()` in `src/cli/enable-agent.ts`.
   * That function is gone: the five hand-rolled read/mutate/write sequences across
   * add-agent, start, import-agent, install and enable-agent are now one locked
   * helper, `mutateEnabledAgents()`. The tests were rewritten rather than deleted,
   * because the invariant they were protecting still matters — but ONE ASSERTION
   * HAS DELIBERATELY FLIPPED, and it is not a relaxation:
   *
   *   old: back the corrupt file up, warn, and RETURN `{}` — the caller then
   *        carried on and wrote a fresh registry over it.
   *   new: back the corrupt file up, warn, and THROW. Nothing is written.
   *
   * The old behaviour was an atomic wipe with a receipt. It looked safe because
   * the bytes were preserved in a `.broken-*` copy, but the live registry still
   * lost every entry — and a missing entry does not mean "disabled".
   * `AgentManager.readInstanceEnableList()` returns `{}` for a missing or
   * unreadable registry, and `discoverAndStart()` only skips an agent on an
   * explicit `enabled === false`. So wiping the registry drops those flags and
   * the daemon's next discovery pass STARTS every agent the user deliberately
   * disabled. The failure mode is unwanted execution, not just lost data.
   *
   * Hence the assertion that carries the weight below is not "it threw" — it is
   * that the on-disk registry is byte-identical afterwards.
   */
  describe('mutateEnabledAgents (supersedes readEnabledAgents / BUG-013)', () => {
    const ctxRoot = () => join(tmpHome, '.cortextos', 'default');
    const configDir = () => join(ctxRoot(), 'config');
    const registry = () => join(configDir(), 'enabled-agents.json');

    function setupConfigFile(content: string): string {
      mkdirSync(configDir(), { recursive: true });
      writeFileSync(registry(), content);
      return registry();
    }

    const backups = () =>
      readdirSync(configDir()).filter(f => f.startsWith('enabled-agents.json.broken-'));

    it('passes {} to the mutator when the file does not exist (legitimate empty state)', () => {
      let seen: Record<string, any> | undefined;
      const wrote = mutateEnabledAgents(ctxRoot(), agents => { seen = { ...agents }; });

      expect(seen).toEqual({});
      expect(wrote).toBe(true);
      expect(JSON.parse(readFileSync(registry(), 'utf-8'))).toEqual({});
    });

    it('passes the parsed object to the mutator on valid JSON', () => {
      setupConfigFile('{"commander":{"enabled":true,"org":"testorg"}}');

      let seen: Record<string, any> | undefined;
      mutateEnabledAgents(ctxRoot(), agents => { seen = { ...agents }; });

      expect(seen).toEqual({ commander: { enabled: true, org: 'testorg' } });
    });

    it('persists the mutation, preserving entries it did not touch', () => {
      setupConfigFile('{"commander":{"enabled":true}}');

      mutateEnabledAgents(ctxRoot(), agents => { agents.scout = { enabled: false }; });

      expect(JSON.parse(readFileSync(registry(), 'utf-8'))).toEqual({
        commander: { enabled: true },
        scout: { enabled: false },
      });
    });

    it('skips the write entirely when the mutator returns false', () => {
      const path = setupConfigFile('{"commander":{"enabled":true}}');
      const before = statSync(path).mtimeMs;

      const wrote = mutateEnabledAgents(ctxRoot(), () => false);

      expect(wrote).toBe(false);
      // mtime is the point, not just the content: the dashboard's file watcher
      // keys on it, so a no-op "registration" must not look like a change.
      expect(statSync(path).mtimeMs).toBe(before);
    });

    // The four corrupt-input shapes. Each asserts the same three things: it
    // throws, it leaves a backup, and — the one that actually matters — the
    // live registry is untouched.
    const corrupt: Array<[string, string]> = [
      ['malformed JSON', 'this is not json{{{'],
      ['an array', '["this", "should", "be", "an", "object"]'],
      ['null', 'null'],
      ['a bare string', '"a string"'],
    ];

    for (const [label, content] of corrupt) {
      it(`throws on ${label}, backs it up, and leaves the registry byte-identical`, () => {
        const path = setupConfigFile(content);

        expect(() => mutateEnabledAgents(ctxRoot(), agents => { agents.scout = {}; }))
          .toThrow(CorruptRegistryError);

        expect(backups().length).toBeGreaterThan(0);
        // The whole point: no overwrite, no wipe, no resurrected agents.
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, 'utf-8')).toBe(content);
      });
    }

    it('does not back up the file when JSON is valid', () => {
      setupConfigFile('{}');
      mutateEnabledAgents(ctxRoot(), () => {});
      expect(backups()).toHaveLength(0);
    });
  });
});
