import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir, homedir } from 'os';
import { claudeProjectDir } from '../../../src/daemon/agent-process';

/**
 * claudeProjectDir() decides whether the daemon can resume an agent's
 * conversation. When it names a directory that does not exist, shouldContinue()
 * returns false and the agent silently starts a FRESH session — no error, no
 * log line, just a lost conversation. These pin the two ways that happened.
 */
describe('claudeProjectDir', () => {
  const projects = join(homedir(), '.claude', 'projects');

  it('mangles separators into dashes', () => {
    // Path does not exist, so realpath falls back to the literal spelling.
    expect(claudeProjectDir('/agents/alice'))
      .toBe(join(projects, '-agents-alice'));
  });

  it('mangles DOTS into dashes too', () => {
    // Separator-only mangling produced "-Users-foo-.ctx-w-domain", which never
    // matches what Claude Code writes for worker sessions launched under
    // ~/.cortextos/<instance>/...
    expect(claudeProjectDir('/Users/foo/.ctx/w/domain'))
      .toBe(join(projects, '-Users-foo--ctx-w-domain'));
  });

  it('RESOLVES SYMLINKS before mangling', () => {
    const base = mkdtempSync(join(tmpdir(), 'cpd-'));
    try {
      const real = join(base, 'real', 'orgs', 'acme', 'agents', 'bob');
      mkdirSync(real, { recursive: true });
      const link = join(base, 'link');
      symlinkSync(join(base, 'real'), link);
      const viaLink = join(link, 'orgs', 'acme', 'agents', 'bob');

      // Claude Code keys history by the resolved path, so both spellings of the
      // same directory must map to one project dir. Before the fix these
      // differed and the symlinked spelling named a directory that never
      // existed, so every restart lost the conversation.
      expect(claudeProjectDir(viaLink)).toBe(claudeProjectDir(real));

      const expected = realpathSync(real).split(sep).join('-').split('.').join('-');
      expect(claudeProjectDir(viaLink)).toBe(join(projects, expected));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('falls back to the literal path when the launch dir does not exist', () => {
    const missing = join(tmpdir(), 'cpd-does-not-exist-12345', 'agent');
    expect(claudeProjectDir(missing))
      .toBe(join(projects, missing.split(sep).join('-').split('.').join('-')));
  });
});
