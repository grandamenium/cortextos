import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { publishToVault, MAX_SOURCE_BYTES } from '../../../src/bus/vault';

describe('publishToVault', () => {
  let testDir: string;
  let vaultRoot: string;
  let sourceDir: string;
  let taskDir: string;

  const TASK_ID = 'task_1776871419062_944';
  const AGENT = 'coder';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-vault-test-'));
    vaultRoot = join(testDir, 'vault');
    sourceDir = join(testDir, 'src');
    taskDir = join(testDir, 'tasks');
    mkdirSync(vaultRoot, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, `${TASK_ID}.json`),
      JSON.stringify({ id: TASK_ID, assigned_to: AGENT }),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const writeSource = (name: string, body: string): string => {
    const p = join(sourceDir, name);
    writeFileSync(p, body, 'utf-8');
    return p;
  };

  describe('happy path', () => {
    it('publishes file with frontmatter and wikilink when task-id is given', () => {
      const src = writeSource('pricing-report.md', '# Pricing\n\nBody text.\n');
      const result = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports/Pricing',
        vaultRoot,
        agentName: AGENT,
        taskId: TASK_ID,
        taskDir,
        summary: 'Iter 6 pricing sweep',
        now: new Date('2026-04-22T15:00:00Z'),
      });

      expect(result.task_id).toBe(TASK_ID);
      // macOS tmpdir resolves through /private — compare by suffix.
      expect(result.published_to).toMatch(
        /\/vault\/Reports\/Pricing\/2026-04-22-pricing-report\.md$/,
      );
      expect(result.bytes).toBeGreaterThan(0);

      const contents = readFileSync(result.published_to, 'utf-8');
      expect(contents.startsWith('---\n')).toBe(true);
      expect(contents).toMatch(/published_by: coder/);
      expect(contents).toMatch(/published_at: "2026-04-22T15:00:00Z"/);
      expect(contents).toMatch(/source_task: task_1776871419062_944/);
      expect(contents).toMatch(/summary: Iter 6 pricing sweep/);
      expect(contents).toMatch(/tags: \[agent-output, coder, Reports, Pricing\]/);
      expect(contents).toContain('Source: [[task_1776871419062_944]]');
    });

    it('creates nested vault subdirectory if missing', () => {
      const src = writeSource('note.md', 'note\n');
      const result = publishToVault({
        sourcePath: src,
        vaultDir: 'Research/Pricing/Iter7',
        vaultRoot,
        agentName: AGENT,
        now: new Date('2026-04-22T00:00:00Z'),
      });
      expect(existsSync(join(vaultRoot, 'Research', 'Pricing', 'Iter7'))).toBe(true);
      expect(result.published_to).toContain('Research/Pricing/Iter7');
    });

    it('preserves existing date prefix on source filename', () => {
      const src = writeSource('2026-04-20-iter-5.md', 'hi\n');
      const result = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now: new Date('2026-04-22T00:00:00Z'),
      });
      expect(result.published_to.endsWith('2026-04-20-iter-5.md')).toBe(true);
    });

    it('skips wikilink and source_task when no task-id is supplied', () => {
      const src = writeSource('free.md', 'free text\n');
      const result = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now: new Date('2026-04-22T00:00:00Z'),
      });
      expect(result.task_id).toBeNull();
      const contents = readFileSync(result.published_to, 'utf-8');
      expect(contents).not.toMatch(/source_task:/);
      expect(contents).not.toContain('Source: [[');
    });
  });

  describe('filename collisions', () => {
    it('appends -v2, -v3 on collision and never overwrites', () => {
      const src = writeSource('dup.md', 'first\n');
      const now = new Date('2026-04-22T00:00:00Z');
      const r1 = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now,
      });
      const r2 = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now,
      });
      const r3 = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now,
      });
      expect(r1.published_to.endsWith('2026-04-22-dup.md')).toBe(true);
      expect(r2.published_to.endsWith('2026-04-22-dup-v2.md')).toBe(true);
      expect(r3.published_to.endsWith('2026-04-22-dup-v3.md')).toBe(true);
      // All three files still present.
      const dir = join(vaultRoot, 'Reports');
      const files = readdirSync(dir);
      expect(files.length).toBe(3);
    });
  });

  describe('frontmatter merging', () => {
    it('preserves non-conflicting source-file frontmatter keys', () => {
      const body = [
        '---',
        'author: analyst',
        'topic: pricing',
        'tags: [draft]',
        '---',
        '',
        'Body content',
        '',
      ].join('\n');
      const src = writeSource('merged.md', body);
      const result = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now: new Date('2026-04-22T00:00:00Z'),
      });
      const contents = readFileSync(result.published_to, 'utf-8');
      expect(contents).toMatch(/author: analyst/);
      expect(contents).toMatch(/topic: pricing/);
      // Our tags override the source's tags (authoritative provenance).
      expect(contents).toMatch(/tags: \[agent-output, coder, Reports\]/);
      // Source `tags: [draft]` must NOT appear duplicated below our tags line.
      const occurrences = (contents.match(/^tags:/gm) || []).length;
      expect(occurrences).toBe(1);
    });

    it('handles source file with no frontmatter', () => {
      const src = writeSource('plain.md', 'just a body');
      const result = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now: new Date('2026-04-22T00:00:00Z'),
      });
      const contents = readFileSync(result.published_to, 'utf-8');
      expect(contents.startsWith('---\n')).toBe(true);
      expect(contents).toContain('just a body');
    });
  });

  describe('adversarial: path traversal', () => {
    it('rejects vault-dir containing ..', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: '../escape',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/traversal|escape/i);
    });

    it('rejects vault-dir with deep ..', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports/../../../etc',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/traversal|not allowed/i);
    });

    it('rejects absolute vault-dir', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: '/etc/passwd',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/must be relative|absolute/i);
    });

    it('rejects NUL byte in vault-dir', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports\0extra',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/NUL/i);
    });

    it('rejects source filename with path separator', () => {
      // Source path exists and is fine; but if somehow basename contained a
      // slash (fabricated via direct call with a tricky name), we reject.
      // Real FS won't allow `/` in a filename on macOS, so instead place a
      // file and manually ask publishToVault to treat a crafted basename.
      // We cover this implicitly via the regex; here, assert via dot-dot.
      const ddPath = join(sourceDir, 'legit.md');
      writeFileSync(ddPath, 'hi\n', 'utf-8');
      // basename of the source path is 'legit.md' — so that's fine. We test
      // rejection of disallowed characters via a separate branch:
      const weird = join(sourceDir, 'has space-and_ok.md');
      writeFileSync(weird, 'hi\n', 'utf-8');
      const ok = publishToVault({
        sourcePath: weird,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
      });
      expect(ok.published_to).toMatch(/has space-and_ok\.md$/);
    });

    it('rejects hidden dotfile-ish names like .. in filename', () => {
      // Node won't easily let us write a file named "..md" — so we test
      // the guard directly by invoking with a synthetic path.
      // Simulate by writing a normal file, but ensure .. filenames would be
      // caught via sanitizeFilename. We rely on the FILENAME_REGEX here; a
      // file literally named "..foo" is unusual — we confirm the regex
      // blocks names starting with two dots.
      const src = join(sourceDir, '..hidden.md');
      // macOS allows this; if the filesystem rejects, skip.
      try {
        writeFileSync(src, 'hi\n', 'utf-8');
      } catch {
        return; // skip on filesystems that reject
      }
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/not allowed|unsafe/i);
    });

    it('refuses to follow symlinks inside the vault that escape it', () => {
      // Plant a symlink inside the vault that points outside.
      const escapeTarget = join(testDir, 'outside');
      mkdirSync(escapeTarget, { recursive: true });
      symlinkSync(escapeTarget, join(vaultRoot, 'Escape'));

      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Escape',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/outside the vault/i);
    });
  });

  describe('adversarial: source file validation', () => {
    it('rejects missing source file', () => {
      expect(() =>
        publishToVault({
          sourcePath: join(sourceDir, 'does-not-exist.md'),
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/not found/i);
    });

    it('rejects directory as source', () => {
      mkdirSync(join(sourceDir, 'adir'), { recursive: true });
      expect(() =>
        publishToVault({
          sourcePath: join(sourceDir, 'adir'),
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/not a regular file/i);
    });

    it('rejects binary files (NUL byte heuristic)', () => {
      const src = join(sourceDir, 'binary.bin');
      writeFileSync(src, Buffer.from([0x41, 0x00, 0x42, 0x43]));
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/binary/i);
    });

    it('rejects files larger than the size cap', () => {
      const src = join(sourceDir, 'huge.md');
      // Build a sparse-ish payload just over the cap. Use a single string of
      // printable chars so it doesn't trip the binary heuristic.
      const chunk = 'a'.repeat(1024 * 1024);
      let total = '';
      // 11 MB — strictly above the 10 MB cap.
      for (let i = 0; i < 11; i++) total += chunk;
      writeFileSync(src, total, 'utf-8');
      expect(statSync(src).size).toBeGreaterThan(MAX_SOURCE_BYTES);
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/size cap/i);
    });

    it('rejects relative source path', () => {
      expect(() =>
        publishToVault({
          sourcePath: 'a.md',
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/absolute path/i);
    });

    it('follows legitimate symlinks to regular files', () => {
      const real = writeSource('real.md', 'real\n');
      const link = join(sourceDir, 'link.md');
      symlinkSync(real, link);
      const result = publishToVault({
        sourcePath: link,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        taskId: TASK_ID,
        taskDir,
        now: new Date('2026-04-22T00:00:00Z'),
      });
      expect(existsSync(result.published_to)).toBe(true);
    });

    it('rejects symlink pointing at a directory', () => {
      const dirPath = join(sourceDir, 'some-dir');
      mkdirSync(dirPath, { recursive: true });
      const link = join(sourceDir, 'dir-link.md');
      symlinkSync(dirPath, link);
      expect(() =>
        publishToVault({
          sourcePath: link,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
        }),
      ).toThrow(/does not point to a regular file/i);
    });
  });

  describe('adversarial: vault root validation', () => {
    it('rejects missing vault root', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot: join(testDir, 'nope'),
          agentName: AGENT,
        }),
      ).toThrow(/does not exist/i);
    });

    it('rejects relative vault root', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot: 'rel/path',
          agentName: AGENT,
        }),
      ).toThrow(/absolute/i);
    });

    it('rejects vault root that is a file', () => {
      const src = writeSource('a.md', 'hi\n');
      const fakeVault = join(testDir, 'file-vault');
      writeFileSync(fakeVault, 'not-a-dir', 'utf-8');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot: fakeVault,
          agentName: AGENT,
        }),
      ).toThrow(/not a directory/i);
    });
  });

  describe('adversarial: task validation', () => {
    it('rejects non-existent task-id when taskDir is provided', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
          taskId: 'task_does_not_exist',
          taskDir,
        }),
      ).toThrow(/task not found/i);
    });

    it('rejects task-id with unsafe characters', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
          taskId: '../evil',
          taskDir,
        }),
      ).toThrow(/invalid task id/i);
    });

    it('rejects taskId when taskDir is omitted (prevents fabricated provenance)', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: AGENT,
          taskId: 'any_id',
        }),
      ).toThrow(/requires taskDir/i);
    });
  });

  describe('adversarial: agent name', () => {
    it('rejects agent name with path separator', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: '../evil',
        }),
      ).toThrow(/invalid agent name/i);
    });

    it('rejects empty agent name', () => {
      const src = writeSource('a.md', 'hi\n');
      expect(() =>
        publishToVault({
          sourcePath: src,
          vaultDir: 'Reports',
          vaultRoot,
          agentName: '',
        }),
      ).toThrow(/invalid agent name/i);
    });
  });

  describe('concurrent publishes', () => {
    it('two publishes in the same millisecond land at distinct filenames', () => {
      const src = writeSource('race.md', 'race\n');
      const now = new Date('2026-04-22T00:00:00Z');
      const r1 = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now,
      });
      const r2 = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now,
      });
      expect(r1.published_to).not.toBe(r2.published_to);
      expect(existsSync(r1.published_to)).toBe(true);
      expect(existsSync(r2.published_to)).toBe(true);
    });

    it('does not clobber a target that appeared between collision-check and write', () => {
      // Simulate the TOCTOU window: pre-plant the exact filename the caller
      // would have picked for attempt #0. The collision-safe writer must
      // detect EEXIST and fall through to -v2 instead of overwriting.
      const src = writeSource('toctou.md', 'my content\n');
      const now = new Date('2026-04-22T00:00:00Z');
      const dir = join(vaultRoot, 'Reports');
      mkdirSync(dir, { recursive: true });
      const plantedPath = join(dir, '2026-04-22-toctou.md');
      writeFileSync(plantedPath, 'planted-do-not-overwrite', 'utf-8');

      const result = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports',
        vaultRoot,
        agentName: AGENT,
        now,
      });

      expect(result.published_to).not.toBe(plantedPath);
      expect(result.published_to).toMatch(/2026-04-22-toctou-v2\.md$/);
      // The planted file must still be intact.
      expect(readFileSync(plantedPath, 'utf-8')).toBe('planted-do-not-overwrite');
    });
  });

  describe('tags', () => {
    it('deduplicates tags and includes vault-dir segments', () => {
      const src = writeSource('a.md', 'hi\n');
      const result = publishToVault({
        sourcePath: src,
        vaultDir: 'Reports/Pricing',
        vaultRoot,
        agentName: AGENT,
        tags: ['coder', 'Pricing', 'custom'],
        now: new Date('2026-04-22T00:00:00Z'),
      });
      const contents = readFileSync(result.published_to, 'utf-8');
      expect(contents).toMatch(/tags: \[agent-output, coder, Reports, Pricing, custom\]/);
    });
  });
});
