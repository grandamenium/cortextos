import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync, spawnSync } from 'child_process';

/**
 * Fleet-resilience #6 — install + uninstall the launchd-managed self-healing
 * daemons that the repo ships in `scripts/self-healing/`.
 *
 * On macOS, copies the `.sh` scripts into `<ctxRoot>/scripts/`, renders the
 * `.plist.template` files (substituting `{HOME}` and `{INSTANCE}`) into
 * `~/Library/LaunchAgents/`, and bootstraps each via `launchctl`. On Linux
 * (no launchd), the install/uninstall calls are no-ops with a single
 * informational log line — the flag stays parseable on every platform.
 *
 * The 2026-05-14 9-hour silent outage post-mortem identified this gap:
 * the scripts existed in the repo but `launchctl list | grep cortextos`
 * was empty because operators skipped the manual README load step. Folding
 * the load into `cortextos install` makes the gap structurally impossible
 * on a fresh machine.
 */

export interface InstallSelfHealingOptions {
  /** Skip the whole step (operator opt-out via `--skip-self-healing`). */
  skip?: boolean;
  /** Override source dir for tests; defaults to `<process.cwd()>/scripts/self-healing`. */
  sourceDir?: string;
  /** Override the `~/Library/LaunchAgents` target for tests. */
  launchAgentsDir?: string;
  /** Override `homedir()` for tests so plist `{HOME}` substitution is hermetic. */
  homeDirOverride?: string;
  /** Suppress `launchctl` invocations (Linux + tests). When undefined,
   *  defaults to true on non-darwin platforms. */
  skipLaunchctl?: boolean;
}

export interface InstallSelfHealingResult {
  installed: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
}

/** The 4 launchd services we manage. Keep in lock-step with files on disk. */
export const SELF_HEALING_SERVICES = [
  'watchdog',
  'agent-recover',
  'usage-monitor',
  'compact-boundary-watcher',
] as const;

type ServiceName = (typeof SELF_HEALING_SERVICES)[number];

function plistLabel(service: ServiceName): string {
  return `com.cortextos.${service}`;
}

function defaultSourceDir(): string {
  return join(process.cwd(), 'scripts', 'self-healing');
}

function defaultLaunchAgentsDir(home: string): string {
  return join(home, 'Library', 'LaunchAgents');
}

function getUid(): string {
  try {
    return execSync('id -u', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return String(process.getuid ? process.getuid() : 501);
  }
}

/** Idempotency check via `launchctl list <label>` — exit 0 = loaded. */
function isServiceLoaded(service: ServiceName, skipLaunchctl: boolean): boolean {
  if (skipLaunchctl) return false;
  const r = spawnSync('launchctl', ['list', plistLabel(service)], { stdio: 'pipe' });
  return r.status === 0;
}

/** Bootstrap a single plist via the modern launchctl idiom, falling back to
 *  legacy `load -w` for older macOS. Mirrors `src/cli/tunnel.ts:259-281`. */
function bootstrapService(plistPath: string, label: string, skipLaunchctl: boolean): { ok: boolean; reason?: string } {
  if (skipLaunchctl) return { ok: true };
  const uid = getUid();
  // Stale-registration cleanup (best effort — both forms; one may exist).
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'pipe' });
  spawnSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'pipe' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (r.status === 0) return { ok: true };
  const legacy = spawnSync('launchctl', ['load', '-w', plistPath], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (legacy.status === 0) return { ok: true };
  return { ok: false, reason: (legacy.stderr || legacy.stdout || r.stderr || r.stdout || 'unknown').trim().slice(0, 200) };
}

function unloadService(plistPath: string, label: string, skipLaunchctl: boolean): void {
  if (skipLaunchctl) return;
  const uid = getUid();
  const r = spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'pipe' });
  if (r.status !== 0) {
    spawnSync('launchctl', ['unload', '-w', plistPath], { stdio: 'pipe' });
  }
}

function renderPlist(templatePath: string, home: string, instance: string): string {
  const tpl = readFileSync(templatePath, 'utf-8');
  return tpl.replace(/\{HOME\}/g, home).replace(/\{INSTANCE\}/g, instance);
}

/**
 * Install + load all 4 self-healing services. On Linux returns immediately
 * with `installed: []` so the flag is platform-uniform.
 */
export function installSelfHealing(
  ctxRoot: string,
  instance: string,
  opts: InstallSelfHealingOptions = {},
): InstallSelfHealingResult {
  if (opts.skip) {
    return { installed: [], skipped: [...SELF_HEALING_SERVICES], failed: [] };
  }

  if (process.platform !== 'darwin') {
    console.log('  self-healing: skipping (launchd not available on this platform)');
    return { installed: [], skipped: [...SELF_HEALING_SERVICES], failed: [] };
  }

  const sourceDir = opts.sourceDir ?? defaultSourceDir();
  if (!existsSync(sourceDir)) {
    console.log(`  self-healing: skipping (source dir not found: ${sourceDir})`);
    return { installed: [], skipped: [...SELF_HEALING_SERVICES], failed: [] };
  }

  const home = opts.homeDirOverride ?? homedir();
  const launchAgentsDir = opts.launchAgentsDir ?? defaultLaunchAgentsDir(home);
  const skipLaunchctl = opts.skipLaunchctl ?? false;

  // Stage 1: copy shell scripts to <ctxRoot>/scripts/
  const scriptsTarget = join(ctxRoot, 'scripts');
  mkdirSync(scriptsTarget, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    if (!entry.endsWith('.sh')) continue;
    const src = join(sourceDir, entry);
    const dst = join(scriptsTarget, entry);
    copyFileSync(src, dst);
    try { chmodSync(dst, 0o755); } catch { /* best effort */ }
  }

  // Stage 2: render + write + load each plist.
  mkdirSync(launchAgentsDir, { recursive: true });
  const result: InstallSelfHealingResult = { installed: [], skipped: [], failed: [] };

  for (const service of SELF_HEALING_SERVICES) {
    const label = plistLabel(service);
    const tplName = `${label}.plist.template`;
    const templatePath = join(sourceDir, tplName);
    const plistPath = join(launchAgentsDir, `${label}.plist`);

    if (!existsSync(templatePath)) {
      result.failed.push({ name: service, reason: `template not found: ${tplName}` });
      continue;
    }

    try {
      const rendered = renderPlist(templatePath, home, instance);
      writeFileSync(plistPath, rendered, 'utf-8');
      try { chmodSync(plistPath, 0o644); } catch { /* best effort */ }

      // Idempotency: if the service is already loaded, leave it alone — a
      // re-bootstrap would briefly interrupt it without functional benefit.
      if (isServiceLoaded(service, skipLaunchctl)) {
        result.skipped.push(service);
        continue;
      }

      const load = bootstrapService(plistPath, label, skipLaunchctl);
      if (load.ok) {
        result.installed.push(service);
      } else {
        result.failed.push({ name: service, reason: load.reason ?? 'launchctl bootstrap failed' });
      }
    } catch (err) {
      result.failed.push({ name: service, reason: (err as Error).message.slice(0, 200) });
    }
  }

  return result;
}

/**
 * Uninstall counterpart: `launchctl bootout` each service, remove the
 * plist files. Leaves the staged shell scripts under `<ctxRoot>/scripts/`
 * alone — `cortextos uninstall` removes the whole `ctxRoot` after this
 * runs anyway.
 */
export function uninstallSelfHealing(
  _ctxRoot: string,
  _instance: string,
  opts: InstallSelfHealingOptions = {},
): { unloaded: string[]; failed: string[] } {
  if (process.platform !== 'darwin') {
    return { unloaded: [], failed: [] };
  }

  const home = opts.homeDirOverride ?? homedir();
  const launchAgentsDir = opts.launchAgentsDir ?? defaultLaunchAgentsDir(home);
  const skipLaunchctl = opts.skipLaunchctl ?? false;

  const result: { unloaded: string[]; failed: string[] } = { unloaded: [], failed: [] };
  for (const service of SELF_HEALING_SERVICES) {
    const label = plistLabel(service);
    const plistPath = join(launchAgentsDir, `${label}.plist`);
    try {
      unloadService(plistPath, label, skipLaunchctl);
      if (existsSync(plistPath)) rmSync(plistPath, { force: true });
      result.unloaded.push(service);
    } catch (err) {
      result.failed.push(`${service}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return result;
}
