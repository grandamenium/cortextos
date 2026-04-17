import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import {
  addAllowedRoot,
  removeAllowedRoot,
  readAllowedRoots,
  computeValidRoots,
  isPathUnderRoots,
  SYSTEM_BLOCKLIST,
} from '../../../src/utils/allowed-roots.js';

// Adversarial path-traversal / root-enforcement tests for the deliverables
// allowed-roots system. These guard the media API resolver's security
// contract: agent-controlled relative paths must never resolve to a file
// outside an allowed root, no matter what escaping they attempt.

let tmpRoot: string;
let configPath: string;
let ctxRoot: string;
let allowedExtra: string;
let forbiddenSibling: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ctx-roots-'));
  ctxRoot = join(tmpRoot, 'ctx');
  allowedExtra = join(tmpRoot, 'allowed-extra');
  forbiddenSibling = join(tmpRoot, 'forbidden-sibling');
  mkdirSync(ctxRoot, { recursive: true });
  mkdirSync(allowedExtra, { recursive: true });
  mkdirSync(forbiddenSibling, { recursive: true });
  configPath = join(ctxRoot, 'config', 'allowed-roots.json');
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('readAllowedRoots', () => {
  it('returns empty when file missing', () => {
    expect(readAllowedRoots(configPath)).toEqual({ additional_roots: [] });
  });

  it('returns empty when file contains invalid JSON', () => {
    mkdirSync(join(ctxRoot, 'config'));
    writeFileSync(configPath, '{not json');
    expect(readAllowedRoots(configPath)).toEqual({ additional_roots: [] });
  });

  it('strips non-string entries defensively', () => {
    mkdirSync(join(ctxRoot, 'config'));
    writeFileSync(
      configPath,
      JSON.stringify({ additional_roots: [allowedExtra, 42, null, { x: 1 }] }),
    );
    const out = readAllowedRoots(configPath);
    expect(out.additional_roots).toEqual([allowedExtra.replace(/\\/g, '/')]);
  });
});

describe('addAllowedRoot — adversarial inputs', () => {
  it('rejects empty paths', () => {
    expect(addAllowedRoot(configPath, '').success).toBe(false);
    expect(addAllowedRoot(configPath, '   ').success).toBe(false);
  });

  it('rejects relative paths', () => {
    const r = addAllowedRoot(configPath, '../../../etc');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/absolute/i);
  });

  it('rejects every entry on the system blocklist', () => {
    for (const blocked of SYSTEM_BLOCKLIST) {
      const r = addAllowedRoot(configPath, blocked);
      expect(r.success, `should block ${blocked}`).toBe(false);
      // Either reason is fine — "not absolute" (Windows drive paths on Unix)
      // or "blocklist". The key requirement is that every blocklisted path
      // is refused.
      expect(r.error).toBeDefined();
    }
  });

  it('rejects nonexistent paths', () => {
    const r = addAllowedRoot(configPath, join(tmpRoot, 'does-not-exist'));
    expect(r.success).toBe(false);
  });

  it('rejects duplicate entries', () => {
    expect(addAllowedRoot(configPath, allowedExtra).success).toBe(true);
    const r = addAllowedRoot(configPath, allowedExtra);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/already/i);
  });

  it('accepts a valid absolute path and persists it', () => {
    const r = addAllowedRoot(configPath, allowedExtra);
    expect(r.success).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const re = readAllowedRoots(configPath);
    expect(re.additional_roots).toContain(allowedExtra.replace(/\\/g, '/'));
  });
});

describe('removeAllowedRoot', () => {
  it('removes a previously-added path', () => {
    addAllowedRoot(configPath, allowedExtra);
    const r = removeAllowedRoot(configPath, allowedExtra);
    expect(r.success).toBe(true);
    expect(readAllowedRoots(configPath).additional_roots).not.toContain(
      allowedExtra.replace(/\\/g, '/'),
    );
  });

  it('is a no-op when path was never added', () => {
    const r = removeAllowedRoot(configPath, allowedExtra);
    expect(r.success).toBe(true);
  });
});

describe('isPathUnderRoots — traversal resistance', () => {
  const roots = ['/home/user/ctx', '/allowed/extra'];

  it('accepts exact root match', () => {
    expect(isPathUnderRoots('/home/user/ctx', roots)).toBe(true);
  });

  it('accepts nested path under a root', () => {
    expect(isPathUnderRoots('/home/user/ctx/sub/file.md', roots)).toBe(true);
  });

  it('rejects a path that is only a prefix sibling (not under root)', () => {
    // Classic startsWith() bug: /home/user/ctx-evil starts with /home/user/ctx
    // but is NOT inside /home/user/ctx. Must be rejected.
    expect(isPathUnderRoots('/home/user/ctx-evil/secrets', roots)).toBe(false);
    expect(isPathUnderRoots('/home/user/ctxevil', roots)).toBe(false);
  });

  it('rejects sibling of allowed-extra', () => {
    expect(isPathUnderRoots('/allowed/extra-evil/x', roots)).toBe(false);
  });

  it('rejects a parent directory of a root', () => {
    expect(isPathUnderRoots('/home/user', roots)).toBe(false);
    expect(isPathUnderRoots('/home', roots)).toBe(false);
    expect(isPathUnderRoots('/', roots)).toBe(false);
  });

  it('rejects unrelated paths', () => {
    expect(isPathUnderRoots('/etc/passwd', roots)).toBe(false);
    expect(isPathUnderRoots('/root/.ssh/id_rsa', roots)).toBe(false);
  });
});

describe('computeValidRoots', () => {
  it('always includes CTX_ROOT even when config file missing', () => {
    const roots = computeValidRoots(ctxRoot, configPath);
    expect(roots).toContain(ctxRoot.replace(/\\/g, '/'));
  });

  it('dedupes CTX_ROOT if it is also in additional_roots', () => {
    addAllowedRoot(configPath, ctxRoot);
    const roots = computeValidRoots(ctxRoot, configPath);
    const normalized = ctxRoot.replace(/\\/g, '/');
    expect(roots.filter(r => r === normalized).length).toBe(1);
  });

  it('includes both CTX_ROOT and extra roots', () => {
    addAllowedRoot(configPath, allowedExtra);
    const roots = computeValidRoots(ctxRoot, configPath);
    expect(roots).toContain(ctxRoot.replace(/\\/g, '/'));
    expect(roots).toContain(allowedExtra.replace(/\\/g, '/'));
  });
});

describe('realpath-based traversal (integration)', () => {
  // This test simulates the full media-route security check: build the roots,
  // simulate a relative path with ../ escape, resolve it, and verify that
  // isPathUnderRoots correctly rejects the escaped path.
  it('rejects ../ traversal that escapes CTX_ROOT', () => {
    addAllowedRoot(configPath, allowedExtra);
    writeFileSync(join(forbiddenSibling, 'secret.txt'), 'SECRET');

    const roots = computeValidRoots(ctxRoot, configPath).map(r => r.replace(/\\/g, '/'));
    // Simulate what the API would compute: join(ctxRoot, '../forbidden-sibling/secret.txt')
    const escaped = join(ctxRoot, '..', 'forbidden-sibling', 'secret.txt')
      .replace(/\\/g, '/');

    expect(isPathUnderRoots(escaped, roots)).toBe(false);
  });

  it('rejects absolute path that is not under any root', () => {
    addAllowedRoot(configPath, allowedExtra);
    const roots = computeValidRoots(ctxRoot, configPath).map(r => r.replace(/\\/g, '/'));
    expect(isPathUnderRoots('/etc/passwd', roots)).toBe(false);
    expect(isPathUnderRoots(forbiddenSibling.replace(/\\/g, '/'), roots)).toBe(false);
  });

  it('accepts path that is genuinely under an allowed extra root', () => {
    addAllowedRoot(configPath, allowedExtra);
    const fileInAllowed = join(allowedExtra, 'inside.md').replace(/\\/g, '/');
    writeFileSync(fileInAllowed, '# ok');

    const roots = computeValidRoots(ctxRoot, configPath).map(r => r.replace(/\\/g, '/'));
    expect(isPathUnderRoots(fileInAllowed, roots)).toBe(true);
  });

  it('rejects a symlink target that escapes the root when NOT realpath-resolved', () => {
    // Skip on platforms that don't support symlinks reliably in tmp
    if (process.platform === 'win32') return;

    const link = join(allowedExtra, 'link-to-secret');
    writeFileSync(join(forbiddenSibling, 'secret.txt'), 'SECRET');
    try {
      symlinkSync(join(forbiddenSibling, 'secret.txt'), link);
    } catch {
      return; // cannot create symlinks in this sandbox
    }

    // The lexical path (under allowedExtra) would pass isPathUnderRoots.
    // This test documents that the media route MUST call realpathSync to
    // resolve the symlink to its real target before calling isPathUnderRoots
    // — otherwise the check could be bypassed via symlinks. The realpath
    // target `forbiddenSibling/secret.txt` is correctly rejected below.
    const roots = computeValidRoots(ctxRoot, configPath).map(r => r.replace(/\\/g, '/'));
    const linkLexical = link.replace(/\\/g, '/');
    const realTarget = join(forbiddenSibling, 'secret.txt').replace(/\\/g, '/');

    expect(isPathUnderRoots(linkLexical, [allowedExtra.replace(/\\/g, '/')])).toBe(true);
    expect(isPathUnderRoots(realTarget, roots)).toBe(false);
  });
});

describe('null-byte and control-char inputs', () => {
  it('does not crash on null-byte paths', () => {
    // Adding a path with null byte should fail cleanly (existsSync returns false)
    const r = addAllowedRoot(configPath, '/tmp/evil\0/../etc');
    expect(r.success).toBe(false);
  });

  it('does not crash on extremely long paths', () => {
    const longPath = '/' + 'a'.repeat(4096);
    const r = addAllowedRoot(configPath, longPath);
    expect(r.success).toBe(false);
  });
});

// sep is referenced to silence unused-import warning on some platforms.
void sep;
