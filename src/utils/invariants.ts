import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from './atomic.js';
import { parseEnvFile } from './env.js';
import { stripBom } from './strip-bom.js';

/**
 * Runtime invariants — the conditions that must hold for an agent to do its
 * job honestly. Distinct from the install-time checks in cli/doctor.ts, which
 * answer "is this machine capable of running cortextOS." These answer "is this
 * machine currently capable of running it WITHOUT lying to the operator."
 *
 * Every check here corresponds to a real failure observed on 2026-07-09, where
 * each fault degraded silently instead of halting:
 *   - vault absent  -> agents reported "Written to Obsidian" into a void
 *   - CTX_ROOT absent (jenni -> jenb) -> state written to a phantom home dir
 *   - cortextos not execFile-resolvable -> heartbeat watchdog ENOENT x14
 *   - system clock TZ != configured TZ -> daily notes landed on the wrong day
 *   - two daemons live on one bot fleet -> 168 Telegram 409 conflicts
 *
 * The rule this module exists to enforce: a degraded agent must refuse to run.
 */

export type InvariantStatus = 'pass' | 'fail' | 'warn';

export interface Invariant {
  name: string;
  status: InvariantStatus;
  message: string;
  /** Operator-actionable remedy. Omitted when status is 'pass'. */
  fix?: string;
}

/** A daemon's claim on a fleet. Written by the running daemon, read by everyone else. */
export interface DaemonLease {
  host: string;
  pid: number;
  instanceId: string;
  /** Epoch millis of the last refresh. */
  ts: number;
}

/**
 * A lease older than this is presumed dead — its daemon crashed or was killed
 * without releasing. Must exceed the daemon's refresh interval by enough margin
 * that a slow GC pause or a laptop resuming from sleep does not look like death.
 */
export const LEASE_STALE_MS = 90_000;

export function leasePath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'daemon.lease');
}

export function readLease(ctxRoot: string): DaemonLease | null {
  try {
    const raw = stripBom(readFileSync(leasePath(ctxRoot), 'utf-8'));
    const lease = JSON.parse(raw) as DaemonLease;
    if (typeof lease.host !== 'string' || typeof lease.ts !== 'number') return null;
    return lease;
  } catch {
    return null;
  }
}

export function writeLease(ctxRoot: string, instanceId: string): void {
  ensureDir(join(ctxRoot, 'state'));
  const lease: DaemonLease = { host: hostname(), pid: process.pid, instanceId, ts: Date.now() };
  atomicWriteSync(leasePath(ctxRoot), JSON.stringify(lease));
}

export function clearLease(ctxRoot: string): void {
  try {
    unlinkSync(leasePath(ctxRoot));
  } catch {
    /* already gone */
  }
}

/**
 * The one-brain rule, enforced rather than documented.
 *
 * Two daemons polling the same bot tokens produce Telegram 409s, double-fired
 * crons, and divergent state. On 2026-07-09 a rebooted laptop resurrected a
 * stale PM2 process list and fought the cloud VM for three hours. Nothing
 * stopped it, because "exactly one daemon runs at any time" lived only in a
 * markdown file.
 *
 * A lease held by THIS host is not a conflict — it is our own previous run,
 * and a restarting daemon must be allowed to reclaim it.
 */
export function checkDaemonLease(ctxRoot: string): Invariant {
  const lease = readLease(ctxRoot);
  if (!lease) {
    return { name: 'Single-daemon lease', status: 'pass', message: 'No competing daemon' };
  }

  const ageMs = Date.now() - lease.ts;
  if (ageMs > LEASE_STALE_MS) {
    return {
      name: 'Single-daemon lease',
      status: 'pass',
      message: `Stale lease from ${lease.host} (${Math.round(ageMs / 1000)}s old) — safe to take over`,
    };
  }

  if (lease.host === hostname()) {
    return {
      name: 'Single-daemon lease',
      status: 'pass',
      message: `Held by this host (pid ${lease.pid})`,
    };
  }

  return {
    name: 'Single-daemon lease',
    status: 'fail',
    message: `ANOTHER DAEMON IS LIVE on '${lease.host}' (pid ${lease.pid}, refreshed ${Math.round(ageMs / 1000)}s ago)`,
    fix:
      `Stop the daemon on '${lease.host}' before starting one here. Two daemons on one bot fleet ` +
      `cause Telegram 409 conflicts, double-fired crons, and divergent agent state.`,
  };
}

/**
 * The vault is the system of record. An agent that cannot write to it will
 * report saves that never happened — the single most expensive failure mode,
 * because it is indistinguishable from working.
 *
 * Existence is not enough: OneDrive can present a directory that is present but
 * not yet synced, or read-only. We prove writability.
 */
export function checkVault(vaultPath: string | undefined, label = 'Vault'): Invariant {
  if (!vaultPath) {
    return {
      name: label,
      status: 'fail',
      message: 'CTX_VAULT is not set',
      fix: `Set CTX_VAULT=<path to the Obsidian vault> in the agent's .env`,
    };
  }
  if (!existsSync(vaultPath)) {
    return {
      name: label,
      status: 'fail',
      message: `Not found: ${vaultPath}`,
      fix:
        `The vault path does not exist on this machine. If OneDrive is not signed in, sign in and let ` +
        `the vault sync BEFORE starting the daemon. Agents cannot retain anything without it.`,
    };
  }

  const probe = join(vaultPath, `.cortextos-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'probe', 'utf-8');
    const readBack = readFileSync(probe, 'utf-8');
    unlinkSync(probe);
    if (readBack !== 'probe') {
      return {
        name: label,
        status: 'fail',
        message: `Write verification failed at ${vaultPath} (wrote 'probe', read back '${readBack}')`,
        fix: 'The vault accepted a write but returned different bytes. Suspect a sync conflict or filesystem fault.',
      };
    }
  } catch (err) {
    return {
      name: label,
      status: 'fail',
      message: `Not writable: ${vaultPath} (${(err as Error).message})`,
      fix: 'Agents will silently lose every "saved" note. Fix permissions or OneDrive sync before starting.',
    };
  }

  return { name: label, status: 'pass', message: `Writable: ${vaultPath}` };
}

/** CTX_ROOT holds heartbeats, crons, telegram offsets. A missing root means state goes nowhere. */
export function checkCtxRoot(ctxRoot: string): Invariant {
  if (!existsSync(ctxRoot)) {
    return {
      name: 'CTX_ROOT',
      status: 'fail',
      message: `Not found: ${ctxRoot}`,
      fix:
        `State directory is missing. This usually means config was copied from another machine with a ` +
        `different username. Run: cortextos init <org>, or correct CTX_ROOT.`,
    };
  }
  return { name: 'CTX_ROOT', status: 'pass', message: ctxRoot };
}

/**
 * Can the daemon actually invoke the CLI?
 *
 * The daemon must never depend on PATH. On Windows `cortextos` is a .cmd shim
 * that execFile cannot resolve, and a PM2-spawned daemon does not inherit the
 * npm global bin dir — which produced `spawn cortextos ENOENT` for every agent's
 * heartbeat watchdog, logged and never surfaced. The supported invocation is
 * `process.execPath dist/cli.js`, so that is what we verify. A PATH-resolvable
 * `cortextos` is a convenience for humans, not a requirement for the daemon.
 */
export function checkCliResolvable(frameworkRoot?: string): Invariant {
  const name = 'cortextos CLI (daemon invocation)';

  if (frameworkRoot) {
    const cliPath = join(frameworkRoot, 'dist', 'cli.js');
    if (existsSync(cliPath)) {
      try {
        execFileSync(process.execPath, [cliPath, '--version'], { stdio: 'pipe', timeout: 20_000 });
        return { name, status: 'pass', message: `PATH-independent via ${cliPath}` };
      } catch (err) {
        return {
          name,
          status: 'fail',
          message: `dist/cli.js exists but failed to run: ${(err as Error).message}`,
          fix: 'Rebuild the framework: npm run build',
        };
      }
    }
    return {
      name,
      status: 'fail',
      message: `dist/cli.js not found under ${frameworkRoot}`,
      fix: 'Build the framework: npm run build',
    };
  }

  // No frameworkRoot known — fall back to checking PATH the way legacy callers do.
  try {
    execFileSync('cortextos', ['--version'], { stdio: 'pipe', timeout: 20_000 });
    return { name, status: 'pass', message: 'Resolvable via execFile on PATH' };
  } catch {
    /* fall through */
  }
  try {
    execSync('cortextos --version', { stdio: 'pipe', timeout: 20_000 });
    return {
      name,
      status: 'warn',
      message: 'Resolvable only via a shell, and CTX_FRAMEWORK_ROOT is unset',
      fix: 'Set CTX_FRAMEWORK_ROOT so the daemon can invoke dist/cli.js directly, bypassing PATH.',
    };
  } catch {
    return {
      name,
      status: 'fail',
      message: 'Not found on PATH, and no framework root to locate dist/cli.js',
      fix: 'Install the CLI (npm install -g cortextos) or run doctor from the framework root.',
    };
  }
}

/**
 * The configured timezone is what agents reason with; the system clock is what
 * `Get-Date`, file mtimes, and cron comparisons actually use. When they diverge
 * — a UTC cloud VM running an America/Denver config — daily notes land on the
 * wrong day and morning crons fire at night.
 */
export function checkTimezone(configuredTz: string | undefined): Invariant {
  if (!configuredTz) {
    return { name: 'Timezone', status: 'warn', message: 'No timezone configured' };
  }
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!systemTz) {
    return { name: 'Timezone', status: 'warn', message: `Configured ${configuredTz}; system timezone unknown` };
  }
  if (systemTz === configuredTz) {
    return { name: 'Timezone', status: 'pass', message: `${systemTz} (matches config)` };
  }
  return {
    name: 'Timezone',
    status: 'fail',
    message: `System clock is ${systemTz} but config says ${configuredTz}`,
    fix:
      `Set this machine's timezone to ${configuredTz}, or update the agent config. Until they agree, ` +
      `daily notes and cron firing times will be wrong.`,
  };
}

/**
 * Every agent's .cortextos-env carries an absolute CTX_ROOT. When a system is
 * copied to a machine with a different username, these files are the ones that
 * get missed — patch-vm-username.ps1's `-Include *.env` glob cannot match a file
 * named `.cortextos-env`. The agents then point at a home directory that does
 * not exist, and say nothing.
 */
export function checkAgentEnvPaths(frameworkRoot: string): Invariant[] {
  const orgsDir = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsDir)) return [];

  const broken: string[] = [];
  let scanned = 0;

  try {
    for (const org of readdirSync(orgsDir)) {
      const agentsRoot = join(orgsDir, org, 'agents');
      if (!existsSync(agentsRoot)) continue;
      for (const agent of readdirSync(agentsRoot)) {
        const envPath = join(agentsRoot, agent, '.cortextos-env');
        if (!existsSync(envPath)) continue;
        scanned++;
        const vars = parseEnvFile(envPath);
        const root = vars.CTX_ROOT;
        if (root && !existsSync(root)) {
          broken.push(`${org}/${agent} -> ${root}`);
        }
      }
    }
  } catch {
    /* ignore scan errors */
  }

  if (scanned === 0) return [];
  if (broken.length === 0) {
    return [{ name: 'Agent CTX_ROOT paths', status: 'pass', message: `${scanned} agent env file(s) resolve` }];
  }
  return [
    {
      name: 'Agent CTX_ROOT paths',
      status: 'fail',
      message: `${broken.length}/${scanned} agents point at a nonexistent CTX_ROOT: ${broken.slice(0, 3).join('; ')}${broken.length > 3 ? ` (+${broken.length - 3} more)` : ''}`,
      fix:
        `Rewrite CTX_ROOT in each agent's .cortextos-env to this machine's path. These files are the ones ` +
        `username-patch scripts miss, because '.cortextos-env' does not match the glob '*.env'.`,
    },
  ];
}

/** Read `timezone` from an agent's config.json, tolerating a BOM. */
export function readAgentTimezone(agentDir: string): string | undefined {
  try {
    const cfg = JSON.parse(stripBom(readFileSync(join(agentDir, 'config.json'), 'utf-8')));
    return typeof cfg.timezone === 'string' ? cfg.timezone : undefined;
  } catch {
    return undefined;
  }
}

/** Read CTX_VAULT from an agent's .env. */
export function readAgentVault(agentDir: string): string | undefined {
  const vars = parseEnvFile(join(agentDir, '.env'));
  return vars.CTX_VAULT || undefined;
}

export interface RuntimeInvariantOptions {
  ctxRoot: string;
  frameworkRoot: string;
  /** Agent whose vault + timezone define the fleet's expectations (usually the orchestrator). */
  orchestratorDir?: string;
  /** Skip the lease check when the caller IS the daemon holding it. */
  skipLease?: boolean;
}

/**
 * Run every runtime invariant. Returns them in severity order so a caller that
 * truncates output still shows the failures.
 */
export function runRuntimeInvariants(opts: RuntimeInvariantOptions): Invariant[] {
  const results: Invariant[] = [];

  results.push(checkCtxRoot(opts.ctxRoot));
  if (!opts.skipLease) results.push(checkDaemonLease(opts.ctxRoot));
  results.push(checkCliResolvable(opts.frameworkRoot));

  if (opts.orchestratorDir && existsSync(opts.orchestratorDir)) {
    results.push(checkVault(readAgentVault(opts.orchestratorDir)));
    results.push(checkTimezone(readAgentTimezone(opts.orchestratorDir)));
  }

  results.push(...checkAgentEnvPaths(opts.frameworkRoot));

  const rank: Record<InvariantStatus, number> = { fail: 0, warn: 1, pass: 2 };
  return results.sort((a, b) => rank[a.status] - rank[b.status]);
}

/** True when any invariant failed — the caller must refuse to run. */
export function hasFailures(invariants: Invariant[]): boolean {
  return invariants.some((i) => i.status === 'fail');
}

/** A terse operator-facing summary suitable for a Telegram message. */
export function formatAlert(invariants: Invariant[]): string {
  const failures = invariants.filter((i) => i.status === 'fail');
  if (failures.length === 0) return 'cortextOS doctor: all runtime invariants pass.';

  const lines = [
    `cortextOS HALTED on ${hostname()} — ${failures.length} runtime invariant(s) failed.`,
    '',
  ];
  for (const f of failures) {
    lines.push(`* ${f.name}: ${f.message}`);
    if (f.fix) lines.push(`  Fix: ${f.fix}`);
  }
  lines.push('', 'Agents are NOT running. Nothing you tell them will be retained until this is fixed.');
  return lines.join('\n');
}
