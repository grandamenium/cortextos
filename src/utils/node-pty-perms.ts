import { existsSync, readdirSync, statSync, chmodSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Issue #07 follow-up: post-install `node_modules/node-pty/.../spawn-helper`
// frequently lands at 0o644 (no exec bit) on macOS — both `npm install` and
// `pnpm install` have been observed dropping the bit, depending on tar/zip
// implementation and the registry path used. When that happens, every
// pty.spawn() throws `posix_spawnp failed.` because the kernel refuses to
// exec a non-executable binary.
//
// cortextos doctor already auto-fixed this, but only when invoked manually.
// This module lifts the fix into a reusable helper so:
//   - The daemon can call it at startup (catches every restart)
//   - npm postinstall can call it via a standalone script (catches every
//     reinstall, including pnpm migrations gone wrong)
//   - doctor remains the operator-facing diagnostic surface but shares
//     ONE implementation
//
// Pure function: returns a result the caller can log. No console output
// here so callers control the message format (daemon vs CLI vs postinstall
// all want different styles).
// ---------------------------------------------------------------------------

export interface EnsureSpawnHelperResult {
  /** Files we touched (had exec bits added). Empty list = nothing to fix. */
  fixed: string[];
  /** Files we checked and were already executable. */
  alreadyOk: string[];
  /** Files we tried to fix but couldn't (chmod failed). */
  errors: Array<{ path: string; reason: string }>;
  /** True when the platform doesn't have exec-bit semantics. */
  skipped: boolean;
}

/**
 * Scan `<rootDir>/node_modules/node-pty/prebuilds/*\/` and
 * `<rootDir>/node_modules/node-pty/build/Release/` for spawn-helper
 * binaries. chmod 0o755 anything missing the exec bit. Idempotent —
 * already-executable files are left alone.
 *
 * Caller (daemon / doctor / postinstall) decides what to do with the
 * result (log, alert, exit, etc.).
 *
 * Windows: skipped (no exec-bit semantics). Returns `skipped: true`.
 */
export function ensureSpawnHelperExecutable(rootDir: string): EnsureSpawnHelperResult {
  const result: EnsureSpawnHelperResult = {
    fixed: [],
    alreadyOk: [],
    errors: [],
    skipped: false,
  };
  if (process.platform === 'win32') {
    result.skipped = true;
    return result;
  }
  const prebuildsDir = join(rootDir, 'node_modules', 'node-pty', 'prebuilds');
  const buildRelease = join(rootDir, 'node_modules', 'node-pty', 'build', 'Release');
  const candidates: string[] = [];
  if (existsSync(prebuildsDir)) {
    try {
      for (const entry of readdirSync(prebuildsDir)) {
        candidates.push(join(prebuildsDir, entry, 'spawn-helper'));
      }
    } catch (e) {
      // readdir failed — directory disappeared mid-scan or permission
      // issue. Record but keep going so the build/Release branch still
      // gets a chance.
      result.errors.push({ path: prebuildsDir, reason: (e as Error).message });
    }
  }
  if (existsSync(buildRelease)) {
    candidates.push(join(buildRelease, 'spawn-helper'));
  }
  for (const helperPath of candidates) {
    if (!existsSync(helperPath)) continue;
    try {
      const mode = statSync(helperPath).mode;
      // 0o111 = user|group|other exec bits. If all are zero, the kernel
      // will reject exec — that's the failure mode we're patching.
      if ((mode & 0o111) === 0) {
        chmodSync(helperPath, 0o755);
        result.fixed.push(helperPath);
      } else {
        result.alreadyOk.push(helperPath);
      }
    } catch (e) {
      result.errors.push({ path: helperPath, reason: (e as Error).message });
    }
  }
  return result;
}
