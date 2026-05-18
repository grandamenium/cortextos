// `cortextos doctor` — auto-remediation counterpart to `cortextos status`.
//
// Where `status` reports problems, `doctor` proposes (and with --fix actually
// executes) the standard remediations for them. Wave-1 Task #63 shipped the
// `/auth-doctor` runbook SKILL; this is its CLI counterpart that consolidates
// the most common operator fixups into one command so an operator who pasted
// `cortextos status` to a chat and saw red can just paste `cortextos doctor
// --fix` to get back to green.
//
// Design contract (mirrors status.ts):
//   * Pure-ish core: `collectDoctorPlan()` takes a StatusReport + an options
//     bag (instance, frameworkRoot, ctxRoot, only/skip filters, env, fs/exec
//     overrides for tests) and returns a structured DoctorPlan. The commander
//     wrapper is intentionally thin — every real decision is in collectPlan
//     so the test suite can drive it without parsing argv.
//   * Dry-run by default. --fix is the ONLY way to actually execute
//     remediations — same safety pattern as `cortextos scope-plugins`.
//   * JSON output for piping into chronicles / dashboards.
//   * HOME-portable: ALL paths derived from `homedir()` + env vars
//     (CTX_FRAMEWORK_ROOT, CTX_INSTANCE_ID). Multi-host conformance test
//     enforces this — no hardcoded `/Users/<user>/cortextos` literals.
//
// Check registry (each is a `DoctorCheck` with detect / plan / execute):
//   regen-ecosystem      — ecosystem.config.js looks stale (hardcoded user path)
//   restart-halted       — halted agents from circuit-breaker auth-storm
//   clear-stale-errors   — agent .errors/ dir has >5 stale entries
//   apply-scope-plugins  — agents missing per-agent .claude/settings.json
//   daemon-env-missing   — daemon.env missing canonical 3 vars
//   host-field-missing   — enabled-agents.json entry missing `host` field
//   manifest-drift       — agents on disk not in agents.yaml (semantic; surface only)
//   crash-loop-recent    — ≥3 crashes in last 15 min (surface only, needs operator)
//
// What's intentionally NOT here:
//   - Anything that requires a token rotation, OAuth login, or operator
//     consent beyond "I typed --fix". The CLI doctor is for things that
//     deterministically fix the issue without a human approving each step.
//     Sensitive ops (apt install, claude login, restart of crash-looping
//     agent) surface a plan but never auto-execute.

import { Command } from 'commander';
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { collectStatus, type StatusReport } from './status.js';
import { currentHostId } from '../daemon/agent-manager.js';

// ---------------------------------------------------------------------------
// Public types — exported for tests + downstream consumers (dashboard, hooks)
// that want the same plan shape `cortextos doctor --json` emits.
// ---------------------------------------------------------------------------

/** Severity — info < warn < error. Drives sort order in human render. */
export type Severity = 'info' | 'warn' | 'error';

/**
 * A single remediation step inside a check's plan. Commands listed here are
 * what WOULD be executed in --fix mode — they're also displayed verbatim in
 * dry-run output so the operator can hand-run them if they want to.
 */
export interface CommandSpec {
  /** Argv array form. First element is the executable, rest are args. */
  argv: string[];
  /** Human-friendly one-liner shown in dry-run output. */
  description: string;
}

/**
 * A check's diagnosis — what was detected, why it matters, what we'd do.
 * Returned by `DoctorCheck.detect` (or null when nothing's wrong).
 */
export interface Issue {
  /** Operator-facing one-liner. */
  summary: string;
  /** Optional structured payload (e.g. list of halted agent names). */
  details?: unknown;
  /** Default severity carried over to the planned step. */
  severity: Severity;
}

/**
 * A planned remediation — what the doctor proposes to do for one issue. The
 * shape is identical between dry-run and --fix; --fix just additionally runs
 * the `execute()` and attaches a `result`.
 */
export interface PlannedStep {
  /** Check id (e.g. `regen-ecosystem`). */
  id: string;
  /** Operator-facing label. */
  label: string;
  /** What the detector found. */
  issue: Issue;
  /** Human-readable description of the fix (multi-line OK). */
  fixDescription: string;
  /** Commands that would be run. May be empty for surface-only checks. */
  commands: CommandSpec[];
  /** True when this check can be safely auto-executed by --fix. */
  autoFixable: boolean;
}

/**
 * Result of actually running a planned step (only present in --fix mode).
 */
export interface ExecutedStep extends PlannedStep {
  result: {
    ok: boolean;
    message: string;
    /** When commands were run, per-command stdout/stderr (truncated to 2KB each). */
    commandOutputs?: Array<{
      argv: string[];
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  };
}

/**
 * The full plan returned by `collectDoctorPlan`. Always includes the source
 * StatusReport so callers don't have to re-fetch it.
 */
export interface DoctorPlan {
  generatedAt: string;
  host: { hostId: string; instance: string };
  source: StatusReport;
  steps: PlannedStep[];
  /** Top-level summary line ("3 issues found, 2 auto-fixable"). */
  summary: string;
}

/** Result of `--fix` mode — plan + executed-step results. */
export interface DoctorRunResult extends Omit<DoctorPlan, 'steps'> {
  steps: ExecutedStep[];
  succeeded: number;
  failed: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Options + dependency-injection seams (for tests)
// ---------------------------------------------------------------------------

/** Hook for substituting `spawnSync` in tests so we don't shell out. */
export type ExecRunner = (cmd: string, args: string[], opts?: { cwd?: string }) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Hook for the filesystem actions doctor performs (only used in --fix). */
export interface DoctorFsHooks {
  /** Move src → dst (recursive directory move). Default: fs.renameSync. */
  moveDir?: (src: string, dst: string) => void;
  /** Create directory recursively. Default: fs.mkdirSync recursive. */
  mkdirp?: (path: string) => void;
  /** Write a text file (creates parent dirs). Default: writeFileSync. */
  writeText?: (path: string, content: string) => void;
}

export interface DoctorOptions {
  instance?: string;
  /** Filter — only run checks whose id matches (exact). Repeatable via CLI. */
  only?: string[];
  /** Filter — skip checks whose id matches (exact). Repeatable via CLI. */
  skip?: string[];
  /** When true, actually execute the planned remediations. Default false. */
  fix?: boolean;
  /** Opt-in for host-field auto-add (multi-host risk). */
  fixHostFields?: boolean;
  /** Override for tests. */
  ctxRoot?: string;
  /** Override for tests. */
  frameworkRoot?: string;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
  /** Override for tests — defaults to fetching a live StatusReport. */
  statusProvider?: () => Promise<StatusReport>;
  /** Override for tests — defaults to spawnSync. */
  exec?: ExecRunner;
  /** Override for tests — defaults to real fs. */
  fs?: DoctorFsHooks;
  /** Now() override for deterministic tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Default fs / exec implementations
// ---------------------------------------------------------------------------

function defaultExec(cmd: string, args: string[], opts: { cwd?: string } = {}): {
  exitCode: number; stdout: string; stderr: string;
} {
  // We use spawnSync rather than execSync — no shell interpretation, so
  // argv values flow through without injection risk. All callers pass a
  // fixed argv (constructed from typed fields like agent names that the
  // bus + manifest already validate).
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: 'pipe',
  });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  };
}

const defaultFs: Required<DoctorFsHooks> = {
  moveDir: (src, dst) => {
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
  },
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  writeText: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  },
};

// ---------------------------------------------------------------------------
// DoctorCheck: the per-check spec. Each detect() returns null (no issue) or
// an Issue; plan() turns an Issue into a PlannedStep; execute() runs it.
// ---------------------------------------------------------------------------

/** Context handed to each check's detect/plan/execute. */
export interface CheckContext {
  report: StatusReport;
  ctxRoot: string;
  frameworkRoot: string;
  env: NodeJS.ProcessEnv;
  fixHostFields: boolean;
  now: Date;
}

/** Result of running a check's execute() in --fix mode. */
export interface CheckExecuteResult {
  ok: boolean;
  message: string;
  commandOutputs?: ExecutedStep['result']['commandOutputs'];
}

export interface DoctorCheck {
  id: string;
  label: string;
  severity: Severity;
  detect(ctx: CheckContext): Issue | null;
  plan(issue: Issue, ctx: CheckContext): {
    fixDescription: string;
    commands: CommandSpec[];
    autoFixable: boolean;
  };
  execute(issue: Issue, ctx: CheckContext, exec: ExecRunner, fs: Required<DoctorFsHooks>): CheckExecuteResult;
}

// ---------------------------------------------------------------------------
// Canonical daemon.env vars — kept in sync with the file shipped at
// ~/.cortextos/<instance>/config/daemon.env. If any are missing, the
// daemon-env-missing check fires.
// ---------------------------------------------------------------------------

const CANONICAL_DAEMON_ENV_VARS = [
  'CTX_BUS_AUTH_GRACE_UNTIL',
  'CTX_REQUIRE_EXPLICIT_ENABLE',
  'CTX_DEBUG_ALLOW_CRASH_TRIGGER',
] as const;

const STALE_ERROR_THRESHOLD = 5;
const CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const CRASH_LOOP_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * regen-ecosystem — ecosystem.config.js still has a hardcoded user path.
 *
 * The Task #74 portability fix (2026-05-17) made the generator emit
 * `path.join(HOME, ...)`. A stale ecosystem.config.js that still has
 * `/Users/<user>/cortextos/...` baked in will work on the original host but
 * break on any other (Mac mini). Detection: read ecosystem.config.js, look for
 * literal `/Users/<x>/cortextos` paths that AREN'T inside HOME-relative joins.
 */
export const regenEcosystemCheck: DoctorCheck = {
  id: 'regen-ecosystem',
  label: 'ecosystem.config.js stale (hardcoded user path)',
  severity: 'warn',
  detect(ctx) {
    const ecoPath = join(ctx.frameworkRoot, 'ecosystem.config.js');
    if (!existsSync(ecoPath)) {
      return {
        summary: `ecosystem.config.js missing at ${ecoPath}`,
        severity: 'warn',
      };
    }
    let content: string;
    try {
      content = readFileSync(ecoPath, 'utf-8');
    } catch (err) {
      return {
        summary: `ecosystem.config.js unreadable: ${(err as Error).message}`,
        severity: 'warn',
      };
    }
    // Heuristic: a fresh file from `cortextos ecosystem` references
    // `path.join(HOME, ...)`. If the file lacks HOME references AND contains
    // `/Users/<user>/cortextos` literals, it's stale.
    const hasHomeJoin = /path\.join\(HOME/.test(content);
    const hardcodedPath = /\/Users\/[a-z][a-z0-9_]*\/cortextos\//.exec(content);
    if (!hasHomeJoin && hardcodedPath) {
      return {
        summary: `ecosystem.config.js has hardcoded path ${hardcodedPath[0]} (no HOME-relative joins)`,
        details: { match: hardcodedPath[0] },
        severity: 'warn',
      };
    }
    return null;
  },
  plan(_issue, ctx) {
    return {
      fixDescription: `Re-run \`cortextos ecosystem --instance ${ctx.report.host.instance}\` to regenerate HOME-portable ecosystem.config.js. After regen, reload PM2 with \`pm2 reload ecosystem.config.js --update-env\`.`,
      commands: [
        {
          argv: ['cortextos', 'ecosystem', '--instance', ctx.report.host.instance],
          description: 'Regenerate ecosystem.config.js',
        },
      ],
      autoFixable: true,
    };
  },
  execute(_issue, ctx, exec) {
    const r = exec('cortextos', ['ecosystem', '--instance', ctx.report.host.instance], {
      cwd: ctx.frameworkRoot,
    });
    return {
      ok: r.exitCode === 0,
      message: r.exitCode === 0
        ? `regenerated ecosystem.config.js (cortextos ecosystem)`
        : `cortextos ecosystem exited ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`,
      commandOutputs: [{
        argv: ['cortextos', 'ecosystem', '--instance', ctx.report.host.instance],
        exitCode: r.exitCode,
        stdout: r.stdout.slice(0, 2048),
        stderr: r.stderr.slice(0, 2048),
      }],
    };
  },
};

/**
 * restart-halted — any agent in `halted` status from the circuit-breaker
 * auth-storm halt (Task #60). Surfaces the list + cortextos restart commands,
 * but auto-execution is gated: only runs if the operator explicitly opted in
 * via --fix. The README pattern: operator confirms auth is fixed THEN runs
 * doctor --fix; we don't try to validate auth here.
 */
export const restartHaltedCheck: DoctorCheck = {
  id: 'restart-halted',
  label: 'halted agents (auth-storm circuit breaker)',
  severity: 'error',
  detect(ctx) {
    const halted = ctx.report.agents
      .filter(a => a.status === 'halted')
      .map(a => a.name);
    if (halted.length === 0) return null;
    return {
      summary: `${halted.length} halted agent(s): ${halted.join(', ')}`,
      details: { agents: halted },
      severity: 'error',
    };
  },
  plan(issue, _ctx) {
    const halted = (issue.details as { agents: string[] }).agents;
    return {
      fixDescription: `Restart each halted agent (after confirming the underlying auth issue is fixed). Will run \`cortextos restart <name>\` for each.`,
      commands: halted.map(name => ({
        argv: ['cortextos', 'restart', name],
        description: `Restart agent ${name}`,
      })),
      autoFixable: true,
    };
  },
  execute(issue, _ctx, exec) {
    const halted = (issue.details as { agents: string[] }).agents;
    const outputs: ExecutedStep['result']['commandOutputs'] = [];
    let allOk = true;
    for (const name of halted) {
      const r = exec('cortextos', ['restart', name]);
      outputs!.push({
        argv: ['cortextos', 'restart', name],
        exitCode: r.exitCode,
        stdout: r.stdout.slice(0, 2048),
        stderr: r.stderr.slice(0, 2048),
      });
      if (r.exitCode !== 0) allOk = false;
    }
    return {
      ok: allOk,
      message: allOk
        ? `restarted ${halted.length} halted agent(s)`
        : `restart had ${outputs!.filter(o => o.exitCode !== 0).length} failure(s) out of ${halted.length}`,
      commandOutputs: outputs,
    };
  },
};

/**
 * clear-stale-errors — agents with >5 entries in inbox/<agent>/.errors/
 * accumulate noise that masks new failures. We archive them to
 * `.errors-archived-<iso>/` so the live count drops while preserving history
 * for forensics. Cheap, safe, and easily reversible (operator can mv back).
 */
export const clearStaleErrorsCheck: DoctorCheck = {
  id: 'clear-stale-errors',
  label: 'stale .errors entries (>5)',
  severity: 'warn',
  detect(ctx) {
    const offenders = ctx.report.bus.rows
      .filter(r => r.errors > STALE_ERROR_THRESHOLD)
      .map(r => ({ agent: r.agent, count: r.errors }));
    if (offenders.length === 0) return null;
    return {
      summary: offenders.length === 1
        ? `${offenders[0].agent} has ${offenders[0].count} stale .errors entries`
        : `${offenders.length} agents have >5 stale .errors entries`,
      details: { offenders },
      severity: 'warn',
    };
  },
  plan(issue, ctx) {
    const offenders = (issue.details as { offenders: Array<{ agent: string; count: number }> }).offenders;
    const ts = ctx.now.toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
    const cmds = offenders.map(o => ({
      argv: [
        'mv',
        join(ctx.ctxRoot, 'inbox', o.agent, '.errors'),
        join(ctx.ctxRoot, 'inbox', o.agent, `.errors-archived-${ts}`),
      ],
      description: `Archive ${o.count} stale .errors for ${o.agent}`,
    }));
    return {
      fixDescription: `Move each agent's full .errors/ dir to .errors-archived-${ts}/ to drop the live count while preserving history.`,
      commands: cmds,
      autoFixable: true,
    };
  },
  execute(issue, ctx, _exec, fs) {
    const offenders = (issue.details as { offenders: Array<{ agent: string; count: number }> }).offenders;
    const ts = ctx.now.toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
    const results: string[] = [];
    let ok = true;
    for (const o of offenders) {
      const src = join(ctx.ctxRoot, 'inbox', o.agent, '.errors');
      const dst = join(ctx.ctxRoot, 'inbox', o.agent, `.errors-archived-${ts}`);
      try {
        fs.moveDir(src, dst);
        results.push(`${o.agent}: ${o.count} -> ${dst}`);
      } catch (err) {
        ok = false;
        results.push(`${o.agent}: FAILED (${(err as Error).message})`);
      }
    }
    return { ok, message: results.join('; ') };
  },
};

/**
 * apply-scope-plugins — agents in agents.yaml lacking the per-agent
 * `.claude/settings.json` written by `cortextos scope-plugins --apply` (Task #57).
 * Each unscoped agent inherits the user's full 50-plugin enabledPlugins map,
 * which bloats Claude's context. The fix runs scope-plugins for us.
 */
export const applyScopePluginsCheck: DoctorCheck = {
  id: 'apply-scope-plugins',
  label: 'agents missing per-agent .claude/settings.json',
  severity: 'info',
  detect(ctx) {
    if (!ctx.report.manifest.loaded) return null;
    // Walk orgs/*/agents/<name>/.claude/settings.json. We only check for
    // file existence (not content), because the scope-plugins command itself
    // is responsible for content correctness — doctor just notices the gap.
    const missing: string[] = [];
    for (const a of ctx.report.agents) {
      if (!a.inManifest) continue; // drift handled by manifest-drift check
      const candidate = locateAgentSettingsPath(ctx.frameworkRoot, a.name);
      if (!candidate) continue; // can't locate; skip rather than false-positive
      if (!existsSync(candidate)) missing.push(a.name);
    }
    if (missing.length === 0) return null;
    return {
      summary: `${missing.length} agent(s) lack a per-agent .claude/settings.json: ${missing.join(', ')}`,
      details: { missing },
      severity: 'info',
    };
  },
  plan(_issue, _ctx) {
    return {
      fixDescription: `Run \`cortextos scope-plugins --apply\` to write per-agent settings.json overrides for every agent in agents.yaml. Idempotent — re-running is a no-op once converged.`,
      commands: [
        { argv: ['cortextos', 'scope-plugins', '--apply'], description: 'Apply per-agent plugin scoping' },
      ],
      autoFixable: true,
    };
  },
  execute(_issue, ctx, exec) {
    const r = exec('cortextos', ['scope-plugins', '--apply'], { cwd: ctx.frameworkRoot });
    return {
      ok: r.exitCode === 0,
      message: r.exitCode === 0
        ? `scope-plugins --apply succeeded`
        : `scope-plugins --apply exited ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`,
      commandOutputs: [{
        argv: ['cortextos', 'scope-plugins', '--apply'],
        exitCode: r.exitCode,
        stdout: r.stdout.slice(0, 2048),
        stderr: r.stderr.slice(0, 2048),
      }],
    };
  },
};

/**
 * daemon-env-missing — daemon.env should always have the canonical 3 vars
 * (CTX_BUS_AUTH_GRACE_UNTIL, CTX_REQUIRE_EXPLICIT_ENABLE,
 * CTX_DEBUG_ALLOW_CRASH_TRIGGER). Operators sometimes hand-edit this file
 * and drop a line; the daemon then silently loses the gating that file
 * provides. Fix: append the missing vars with safe defaults.
 *
 * Sensitive detail: we APPEND only — never rewrite the file from scratch
 * — so any custom operator overrides are preserved. Operator must reload
 * pm2 to pick up changes (we note that in the plan description).
 */
export const daemonEnvMissingCheck: DoctorCheck = {
  id: 'daemon-env-missing',
  label: 'daemon.env missing canonical vars',
  severity: 'warn',
  detect(ctx) {
    const path = join(ctx.ctxRoot, 'config', 'daemon.env');
    if (!existsSync(path)) {
      return {
        summary: `daemon.env missing at ${path}`,
        details: { missing: [...CANONICAL_DAEMON_ENV_VARS], path },
        severity: 'warn',
      };
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      return {
        summary: `daemon.env unreadable: ${(err as Error).message}`,
        details: { missing: [...CANONICAL_DAEMON_ENV_VARS], path },
        severity: 'warn',
      };
    }
    const missing = CANONICAL_DAEMON_ENV_VARS.filter(varName => {
      // Match `VAR=` at start of any non-comment line.
      const re = new RegExp(`^\\s*${varName}\\s*=`, 'm');
      return !re.test(content);
    });
    if (missing.length === 0) return null;
    return {
      summary: `daemon.env missing ${missing.length} canonical var(s): ${missing.join(', ')}`,
      details: { missing, path },
      severity: 'warn',
    };
  },
  plan(issue, _ctx) {
    const missing = (issue.details as { missing: string[]; path: string }).missing;
    const path = (issue.details as { missing: string[]; path: string }).path;
    return {
      fixDescription:
        `Append ${missing.length} missing canonical var(s) to ${path} with safe defaults. ` +
        `Operator MUST reload pm2 to pick up changes: \`pm2 reload ecosystem.config.js --update-env\`.`,
      commands: [
        // We surface a single "append-to-file" pseudo-command in dry-run
        // output. The actual write happens via the fs hook in execute().
        {
          argv: ['append-to-file', path, ...missing],
          description: `Append ${missing.join(', ')} to daemon.env (safe defaults)`,
        },
      ],
      autoFixable: true,
    };
  },
  execute(issue, _ctx, _exec, fs) {
    const { missing, path } = issue.details as { missing: string[]; path: string };
    // Build a small additive block. Preserve whatever was already there.
    let existing = '';
    if (existsSync(path)) {
      try { existing = readFileSync(path, 'utf-8'); } catch { /* fall through */ }
    }
    const additions = missing.map(v => defaultDaemonEnvLine(v)).join('\n');
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    const block =
      `${existing}${sep}\n# Added by \`cortextos doctor --fix\` on ${new Date().toISOString()}\n` +
      `# Operator must reload pm2 to pick up these vars:\n` +
      `#   pm2 reload ecosystem.config.js --update-env\n${additions}\n`;
    try {
      fs.writeText(path, block);
      return { ok: true, message: `appended ${missing.length} var(s) to ${path}` };
    } catch (err) {
      return { ok: false, message: `failed to append: ${(err as Error).message}` };
    }
  },
};

/** Safe-default values matching the shipped daemon.env. */
function defaultDaemonEnvLine(varName: string): string {
  switch (varName) {
    case 'CTX_BUS_AUTH_GRACE_UNTIL':
      // Default: 1h grace so the daemon doesn't immediately fail-closed.
      return `CTX_BUS_AUTH_GRACE_UNTIL=${new Date(Date.now() + 60 * 60 * 1000).toISOString()}`;
    case 'CTX_REQUIRE_EXPLICIT_ENABLE':
      return `CTX_REQUIRE_EXPLICIT_ENABLE=1`;
    case 'CTX_DEBUG_ALLOW_CRASH_TRIGGER':
      return `CTX_DEBUG_ALLOW_CRASH_TRIGGER=0`;
    default:
      return `${varName}=`;
  }
}

/**
 * host-field-missing — enabled-agents.json entries lacking a `host` field.
 * On multi-host fleets the host field is what stops sam from spawning on
 * the Mac mini when the orgs/ tree is git-synced. Auto-fix would write the
 * CURRENT host id, which is correct on a single-host fleet but WRONG on a
 * fleet where the operator just hasn't backfilled some entries — we'd
 * silently bind them all to whichever host ran doctor. Gated behind an
 * explicit --fix-host-fields flag.
 */
export const hostFieldMissingCheck: DoctorCheck = {
  id: 'host-field-missing',
  label: 'enabled-agents.json entries missing `host`',
  severity: 'info',
  detect(ctx) {
    const path = join(ctx.ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(path)) return null; // nothing to check
    let parsed: Record<string, { host?: string }> | null = null;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return {
        summary: `enabled-agents.json at ${path} is not valid JSON`,
        details: { path },
        severity: 'warn',
      };
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const missing = Object.entries(parsed)
      .filter(([_, v]) => !v || typeof v !== 'object' || !v.host)
      .map(([k]) => k);
    if (missing.length === 0) return null;
    return {
      summary: `${missing.length} enabled-agents.json entry/entries lack a host field: ${missing.join(', ')}`,
      details: { missing, path },
      severity: 'info',
    };
  },
  plan(issue, ctx) {
    const { missing, path } = issue.details as { missing: string[]; path: string };
    const hostId = currentHostId();
    const autoFixable = ctx.fixHostFields === true;
    const desc = autoFixable
      ? `Backfill host="${hostId}" for ${missing.length} entry/entries in ${path}.`
      : `Refusing to auto-fix without --fix-host-fields (multi-host risk: this would bind ${missing.length} entries to "${hostId}" even if some belong elsewhere). Re-run with --fix --fix-host-fields to opt in.`;
    return {
      fixDescription: desc,
      commands: autoFixable
        ? [{ argv: ['edit-json', path, `host=${hostId}`, ...missing], description: `Backfill host="${hostId}" for ${missing.length} entries` }]
        : [],
      autoFixable,
    };
  },
  execute(issue, ctx, _exec, fs) {
    if (!ctx.fixHostFields) {
      return { ok: false, message: 'skipped — --fix-host-fields not set (refusing to bind to current host blindly)' };
    }
    const { missing, path } = issue.details as { missing: string[]; path: string };
    let obj: Record<string, Record<string, unknown>>;
    try {
      obj = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      return { ok: false, message: `failed to re-read enabled-agents.json: ${(err as Error).message}` };
    }
    const hostId = currentHostId();
    for (const name of missing) {
      if (!obj[name] || typeof obj[name] !== 'object') obj[name] = {};
      obj[name].host = hostId;
    }
    try {
      fs.writeText(path, JSON.stringify(obj, null, 2));
      return { ok: true, message: `backfilled host=${hostId} for ${missing.length} entries` };
    } catch (err) {
      return { ok: false, message: `failed to write: ${(err as Error).message}` };
    }
  },
};

/**
 * manifest-drift — agents on disk not in agents.yaml. Surface-only: which
 * agent dir SHOULD or shouldn't be in the manifest is a semantic decision
 * (is `claw-research` a forgotten orphan or an active in-progress agent?
 * doctor can't tell). We show the list + the manifest path so the operator
 * has everything they need to make the call.
 */
export const manifestDriftCheck: DoctorCheck = {
  id: 'manifest-drift',
  label: 'agents on disk not in agents.yaml',
  severity: 'info',
  detect(ctx) {
    const drift = ctx.report.manifest.driftOnDisk;
    if (drift.length === 0) return null;
    return {
      summary: `${drift.length} agent dir(s) on disk not in agents.yaml: ${drift.join(', ')}`,
      details: { drift },
      severity: 'info',
    };
  },
  plan(issue, ctx) {
    const { drift } = issue.details as { drift: string[] };
    return {
      fixDescription:
        `Semantic decision — operator must decide each drift entry. ` +
        `Add to ${join(ctx.frameworkRoot, 'agents.yaml')} under \`agents:\` if these are real agents, ` +
        `or rm -rf the dir if they're stale. Drift: ${drift.join(', ')}.`,
      commands: [],
      autoFixable: false,
    };
  },
  execute(_issue, _ctx, _exec, _fs) {
    // Surface-only — never executes.
    return { ok: false, message: 'surface-only — operator decides per drift entry' };
  },
};

/**
 * crash-loop-recent — ≥3 entries in the daemon crash history within the
 * last 15 min. Surface-only with a triage checklist. We refuse to
 * auto-restart anything from this check — by design — because the most
 * likely cause is disk space / claude-safe lockfile / OAuth, and blindly
 * restarting just makes the loop louder.
 */
export const crashLoopRecentCheck: DoctorCheck = {
  id: 'crash-loop-recent',
  label: 'recent crash loop detected',
  severity: 'error',
  detect(ctx) {
    const cutoff = ctx.now.getTime() - CRASH_LOOP_WINDOW_MS;
    const recent = ctx.report.crashes.filter(c => {
      const t = Date.parse(c.ts);
      return Number.isFinite(t) && t >= cutoff;
    });
    if (recent.length < CRASH_LOOP_THRESHOLD) return null;
    return {
      summary: `${recent.length} crash(es) in the last 15 min`,
      details: { recent },
      severity: 'error',
    };
  },
  plan(_issue, ctx) {
    return {
      fixDescription:
        `Crash loop needs operator triage — doctor refuses to auto-restart. Checklist:\n` +
        `  1. Read recent stderr: tail -200 ~/.pm2/logs/cortextos-daemon-error.log\n` +
        `  2. Check claude-safe lock: ls -la ${join(ctx.ctxRoot, 'state')}/claude-safe.log* 2>/dev/null\n` +
        `  3. Check free disk: df -h ${homedir()}\n` +
        `  4. Try \`cortextos doctor-deps\` for prerequisites (PM2 / Claude CLI / node-pty health).`,
      commands: [],
      autoFixable: false,
    };
  },
  execute(_issue, _ctx, _exec, _fs) {
    return { ok: false, message: 'surface-only — needs operator triage' };
  },
};

// ---------------------------------------------------------------------------
// Locating the per-agent .claude/settings.json (mirrors scope-plugins logic
// but doesn't depend on the AgentManifestEntry shape — we just scan).
// ---------------------------------------------------------------------------

function locateAgentSettingsPath(frameworkRoot: string, agentName: string): string | null {
  const orgsDir = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsDir)) return null;
  let orgs: string[];
  try {
    orgs = readdirSync(orgsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return null;
  }
  for (const org of orgs) {
    const candidate = join(orgsDir, org, 'agents', agentName, '.claude', 'settings.json');
    const agentDir = join(orgsDir, org, 'agents', agentName);
    if (existsSync(agentDir)) return candidate; // return expected location even if file absent
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check registry — order matters for output. Highest-severity first so
// operators scanning a long report see the urgent stuff at the top.
// ---------------------------------------------------------------------------

export const ALL_CHECKS: readonly DoctorCheck[] = [
  crashLoopRecentCheck,    // error — read first
  restartHaltedCheck,      // error
  regenEcosystemCheck,     // warn
  daemonEnvMissingCheck,   // warn
  clearStaleErrorsCheck,   // warn
  applyScopePluginsCheck,  // info
  hostFieldMissingCheck,   // info
  manifestDriftCheck,      // info
];

// ---------------------------------------------------------------------------
// Plan collection — runs all (filtered) checks and assembles a DoctorPlan.
// ---------------------------------------------------------------------------

export async function collectDoctorPlan(opts: DoctorOptions = {}): Promise<DoctorPlan> {
  const env = opts.env ?? process.env;
  const instance = opts.instance ?? env.CTX_INSTANCE_ID ?? 'default';
  const ctxRoot = opts.ctxRoot ?? join(homedir(), '.cortextos', instance);
  const frameworkRoot = opts.frameworkRoot
    ?? env.CTX_FRAMEWORK_ROOT
    ?? join(homedir(), 'cortextos');
  const now = opts.now ? opts.now() : new Date();

  const report = opts.statusProvider
    ? await opts.statusProvider()
    : await collectStatus({ instance, ctxRoot, frameworkRoot, env });

  const ctx: CheckContext = {
    report,
    ctxRoot,
    frameworkRoot,
    env,
    fixHostFields: opts.fixHostFields === true,
    now,
  };

  const onlySet = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const skipSet = opts.skip && opts.skip.length > 0 ? new Set(opts.skip) : null;

  const steps: PlannedStep[] = [];
  for (const check of ALL_CHECKS) {
    if (onlySet && !onlySet.has(check.id)) continue;
    if (skipSet && skipSet.has(check.id)) continue;
    let issue: Issue | null;
    try {
      issue = check.detect(ctx);
    } catch (err) {
      // A failing detector must not take down the whole report — pattern
      // mirrors status.ts (each section swallows its own errors).
      issue = {
        summary: `detect() threw: ${(err as Error).message}`,
        severity: 'warn',
      };
    }
    if (!issue) continue;
    let planned: ReturnType<DoctorCheck['plan']>;
    try {
      planned = check.plan(issue, ctx);
    } catch (err) {
      planned = {
        fixDescription: `plan() threw: ${(err as Error).message}`,
        commands: [],
        autoFixable: false,
      };
    }
    steps.push({
      id: check.id,
      label: check.label,
      issue,
      fixDescription: planned.fixDescription,
      commands: planned.commands,
      autoFixable: planned.autoFixable,
    });
  }

  const autoFixable = steps.filter(s => s.autoFixable).length;
  const summary = steps.length === 0
    ? 'No issues found.'
    : `${steps.length} issue(s) found, ${autoFixable} auto-fixable.`;

  return {
    generatedAt: now.toISOString(),
    host: { hostId: report.host.hostId, instance: report.host.instance },
    source: report,
    steps,
    summary,
  };
}

/**
 * Execute --fix: collect the plan, then for each auto-fixable step run the
 * check's execute() and attach the result. Non-auto-fixable steps are
 * recorded with `skipped` status. Never throws — execute failures become
 * `ok=false` so the operator sees the partial-success picture.
 */
export async function executeDoctorPlan(opts: DoctorOptions = {}): Promise<DoctorRunResult> {
  const plan = await collectDoctorPlan(opts);
  const env = opts.env ?? process.env;
  const instance = opts.instance ?? env.CTX_INSTANCE_ID ?? 'default';
  const ctxRoot = opts.ctxRoot ?? join(homedir(), '.cortextos', instance);
  const frameworkRoot = opts.frameworkRoot ?? env.CTX_FRAMEWORK_ROOT ?? join(homedir(), 'cortextos');
  const now = opts.now ? opts.now() : new Date();
  const exec = opts.exec ?? defaultExec;
  const fs: Required<DoctorFsHooks> = {
    moveDir: opts.fs?.moveDir ?? defaultFs.moveDir,
    mkdirp: opts.fs?.mkdirp ?? defaultFs.mkdirp,
    writeText: opts.fs?.writeText ?? defaultFs.writeText,
  };
  const ctx: CheckContext = {
    report: plan.source,
    ctxRoot,
    frameworkRoot,
    env,
    fixHostFields: opts.fixHostFields === true,
    now,
  };

  const executedSteps: ExecutedStep[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const step of plan.steps) {
    if (!step.autoFixable) {
      executedSteps.push({
        ...step,
        result: { ok: false, message: 'skipped — not auto-fixable (surface-only check)' },
      });
      skipped++;
      continue;
    }
    const check = ALL_CHECKS.find(c => c.id === step.id);
    if (!check) {
      // Shouldn't happen — collectDoctorPlan sources steps from ALL_CHECKS.
      executedSteps.push({
        ...step,
        result: { ok: false, message: `internal: no check registered for id=${step.id}` },
      });
      failed++;
      continue;
    }
    let result: CheckExecuteResult;
    try {
      result = check.execute(step.issue, ctx, exec, fs);
    } catch (err) {
      result = { ok: false, message: `execute() threw: ${(err as Error).message}` };
    }
    executedSteps.push({ ...step, result });
    if (result.ok) succeeded++;
    else failed++;
  }

  return {
    generatedAt: plan.generatedAt,
    host: plan.host,
    source: plan.source,
    summary: plan.summary,
    steps: executedSteps,
    succeeded,
    failed,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Rendering — human + json. Both exported so dashboard / chronicle hooks
// can reuse the same layout.
// ---------------------------------------------------------------------------

/** Render a DoctorPlan as human-readable text (default mode). */
export function renderDoctorPlanText(plan: DoctorPlan): string {
  const lines: string[] = [];
  lines.push(`cortextos doctor — ${plan.generatedAt}`);
  lines.push(`host: ${plan.host.hostId}  instance: ${plan.host.instance}`);
  lines.push('');
  if (plan.steps.length === 0) {
    lines.push('  No issues found.');
    return lines.join('\n');
  }
  let i = 1;
  for (const step of plan.steps) {
    const sevTag = step.issue.severity === 'error' ? '!' : step.issue.severity === 'warn' ? '~' : ' ';
    lines.push(`[${i}] ${sevTag} ${step.id} — ${step.issue.summary}`);
    // Indent the fix description for readability; first line "fix: ..." others 8 spaces in.
    const fixLines = step.fixDescription.split('\n');
    lines.push(`    fix: ${fixLines[0]}`);
    for (let k = 1; k < fixLines.length; k++) lines.push(`         ${fixLines[k]}`);
    for (const c of step.commands) {
      lines.push(`    cmd: ${c.argv.map(quoteArg).join(' ')}`);
    }
    if (!step.autoFixable) {
      lines.push(`    (not auto-fixable — surface-only)`);
    }
    i++;
  }
  lines.push('');
  lines.push(plan.summary);
  const autoFixable = plan.steps.filter(s => s.autoFixable).length;
  if (autoFixable > 0) {
    lines.push(`Run with --fix to execute the ${autoFixable} auto-remediable check(s).`);
  }
  return lines.join('\n');
}

/** Render a --fix run's result as human-readable text. */
export function renderDoctorRunText(run: DoctorRunResult): string {
  const lines: string[] = [];
  lines.push(`cortextos doctor --fix — ${run.generatedAt}`);
  lines.push(`host: ${run.host.hostId}  instance: ${run.host.instance}`);
  lines.push('');
  if (run.steps.length === 0) {
    lines.push('  No issues found.');
    return lines.join('\n');
  }
  const total = run.steps.length;
  let idx = 1;
  for (const step of run.steps) {
    const status = step.result.ok ? 'OK' : step.autoFixable ? 'FAIL' : 'SKIP';
    lines.push(`[${idx}/${total}] ${step.id} — ${step.issue.summary}`);
    lines.push(`        ${status}  ${step.result.message}`);
    idx++;
  }
  lines.push('');
  lines.push(
    `Result: ${run.succeeded} succeeded, ${run.failed} failed, ${run.skipped} skipped ` +
    `(${run.steps.length} total).`,
  );
  return lines.join('\n');
}

/** Best-effort shell quoting for displaying a planned argv. */
function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_\-./@:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Commander wrapper. Thin — every real decision is in collectDoctorPlan /
// executeDoctorPlan so unit tests don't have to simulate argv.
// ---------------------------------------------------------------------------

/**
 * Collect repeated options (commander gives the same flag multiple times as
 * a comma-list with our prior-array initializer). We accept repeated --only
 * or --skip via the function-form initializer.
 */
function collectRepeatedFlag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export const doctorCommand = new Command('doctor')
  .description(
    'Auto-remediation counterpart to `cortextos status`. Inspects the fleet, ' +
    'identifies common issues, and proposes (or with --fix, executes) the standard ' +
    'remediation for each. Dry-run by default.',
  )
  .option('--instance <id>', 'Instance ID (default: $CTX_INSTANCE_ID or "default")')
  .option('--json', 'Emit structured plan/result as JSON')
  .option('--fix', 'Actually execute the remediation (default: dry-run)')
  .option('--fix-host-fields', 'Opt-in: also backfill `host` in enabled-agents.json (multi-host risk)')
  .option('--only <id>', 'Only run checks matching this id (repeatable)', collectRepeatedFlag, [] as string[])
  .option('--skip <id>', 'Skip checks matching this id (repeatable)', collectRepeatedFlag, [] as string[])
  .action(async (options: {
    instance?: string;
    json?: boolean;
    fix?: boolean;
    fixHostFields?: boolean;
    only?: string[];
    skip?: string[];
  }) => {
    const opts: DoctorOptions = {
      instance: options.instance,
      only: options.only,
      skip: options.skip,
      fix: options.fix === true,
      fixHostFields: options.fixHostFields === true,
    };

    if (!options.fix) {
      const plan = await collectDoctorPlan(opts);
      if (options.json) {
        process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
      } else {
        process.stdout.write(renderDoctorPlanText(plan) + '\n');
      }
      return;
    }

    const run = await executeDoctorPlan(opts);
    if (options.json) {
      process.stdout.write(JSON.stringify(run, null, 2) + '\n');
    } else {
      process.stdout.write(renderDoctorRunText(run) + '\n');
    }
    // Exit non-zero on any failure so CI / chronicles can detect partial success.
    if (run.failed > 0) process.exitCode = 1;
  });
