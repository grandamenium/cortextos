import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename, resolve as resolvePath, sep } from 'path';
import { homedir } from 'os';
import type { CtxEnv } from '../types/index.js';
import { ensureDir } from './atomic.js';
import { validateAgentName, validateOrgName } from './validate.js';
import { stripBom } from './strip-bom.js';

/**
 * Resolve the cortextOS environment context.
 * Equivalent of bash _ctx-env.sh - reads from env vars, .cortextos-env, .env files.
 */
export function resolveEnv(overrides?: Partial<CtxEnv>): CtxEnv {
  // Priority: overrides > env vars > .cortextos-env file > defaults

  // Try reading .cortextos-env from cwd
  let envFile: Record<string, string> = {};
  const cortextosEnvPath = join(process.cwd(), '.cortextos-env');
  if (existsSync(cortextosEnvPath)) {
    envFile = parseEnvFile(cortextosEnvPath);
  }

  const instanceId =
    overrides?.instanceId ||
    process.env.CTX_INSTANCE_ID ||
    envFile.CTX_INSTANCE_ID ||
    'default';

  const ctxRoot =
    overrides?.ctxRoot ||
    process.env.CTX_ROOT ||
    envFile.CTX_ROOT ||
    join(homedir(), '.cortextos', instanceId);

  const frameworkRoot =
    overrides?.frameworkRoot ||
    process.env.CTX_FRAMEWORK_ROOT ||
    envFile.CTX_FRAMEWORK_ROOT ||
    '';

  const agentName =
    overrides?.agentName ||
    process.env.CTX_AGENT_NAME ||
    envFile.CTX_AGENT_NAME ||
    basename(process.cwd());

  const org =
    overrides?.org ||
    process.env.CTX_ORG ||
    envFile.CTX_ORG ||
    '';

  const projectRoot =
    overrides?.projectRoot ||
    process.env.CTX_PROJECT_ROOT ||
    envFile.CTX_PROJECT_ROOT ||
    '';

  // Resolve agent directory
  let agentDir =
    overrides?.agentDir ||
    process.env.CTX_AGENT_DIR ||
    envFile.CTX_AGENT_DIR ||
    '';

  if (!agentDir && org && projectRoot) {
    agentDir = join(projectRoot, 'orgs', org, 'agents', agentName);
  } else if (!agentDir && projectRoot) {
    agentDir = join(projectRoot, 'agents', agentName);
  }

  // Resolve timezone and orchestrator from org context.json
  let timezone = overrides?.timezone || process.env.CTX_TIMEZONE || '';
  let orchestrator = overrides?.orchestrator || process.env.CTX_ORCHESTRATOR || '';

  if ((!timezone || !orchestrator) && org && projectRoot) {
    try {
      const contextPath = join(projectRoot, 'orgs', org, 'context.json');
      if (existsSync(contextPath)) {
        // stripBom: PowerShell/Notepad-saved context.json files have a BOM
        // that breaks JSON.parse at position 0 — silent fallback to wrong
        // timezone/orchestrator. See src/utils/strip-bom.ts for incident.
        const ctx = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8')));
        if (!timezone && ctx.timezone) timezone = ctx.timezone;
        if (!orchestrator && ctx.orchestrator) orchestrator = ctx.orchestrator;
      }
    } catch { /* ignore */ }
  }

  // Sandbox/live isolation (issue #313): when both CTX_FRAMEWORK_ROOT and CTX_AGENT_DIR
  // are set, the resolved agentDir MUST be subordinate to frameworkRoot. Catches the leak
  // class where a CLI subprocess inherits CTX_AGENT_DIR (or CTX_PROJECT_ROOT) from a live
  // agent shell while only CTX_FRAMEWORK_ROOT was overridden — agentDir then silently
  // points at the live install. Equality check on projectRoot vs frameworkRoot catches
  // the same divergence on the projectRoot axis.
  if (agentDir && frameworkRoot) {
    const fwRootResolved = resolvePath(frameworkRoot);
    const agentDirResolved = resolvePath(agentDir);
    if (agentDirResolved !== fwRootResolved && !agentDirResolved.startsWith(fwRootResolved + sep)) {
      throw new Error(
        `Resolved CTX_AGENT_DIR '${agentDir}' is not under CTX_FRAMEWORK_ROOT '${frameworkRoot}'. ` +
        `This indicates a sandbox/live environment leak — likely CTX_FRAMEWORK_ROOT was overridden ` +
        `but CTX_AGENT_DIR or CTX_PROJECT_ROOT was inherited from the parent shell. ` +
        `Refusing to proceed.`,
      );
    }
  }
  if (projectRoot && frameworkRoot && resolvePath(projectRoot) !== resolvePath(frameworkRoot)) {
    throw new Error(
      `CTX_PROJECT_ROOT '${projectRoot}' must equal CTX_FRAMEWORK_ROOT '${frameworkRoot}'. ` +
      `A divergence indicates a sandbox/live environment leak — likely one of the two was ` +
      `inherited from the parent shell while the other was overridden. Refusing to proceed.`,
    );
  }

  // Security (H9): Validate agent name and org before they flow into filesystem paths.
  // These come from env vars / .cortextos-env and must match [a-z0-9_-]+.
  if (agentName) {
    try {
      validateAgentName(agentName);
    } catch (err) {
      throw new Error(`CTX_AGENT_NAME is invalid: ${(err as Error).message}`);
    }
  }
  if (org) {
    // Org names from the env may use mixed-case (e.g. AcmeCorp) when the
    // org directory was created before strict lowercase validation was enforced.
    // Only reject values that contain path-traversal characters or whitespace;
    // lowercase enforcement is a CLI-layer concern, not an env-resolution concern.
    if (/[./\\<>|;'"(){}[\] ]/.test(org) || org.includes('..')) {
      throw new Error(`CTX_ORG is invalid: contains unsafe characters`);
    }
  }

  return { instanceId, ctxRoot, frameworkRoot, agentName, agentDir, org, projectRoot, timezone, orchestrator };
}

/**
 * Resolve another agent's directory from the caller's environment.
 *
 * Commands that take a target agent argument (e.g. manage-cycle) must
 * operate on the TARGET agent's files, not the caller's — writing to the
 * caller's dir creates a second, diverging registry the target never reads
 * (manage-cycle create was a silent no-op for autoresearch). Targets
 * are resolved as a sibling of the caller's agentDir first (matches every
 * deployment layout), then via the same projectRoot conventions resolveEnv
 * uses. Returns null when no candidate directory exists on disk, so callers
 * can fail loudly instead of writing into a directory no agent reads.
 * Throws on invalid agent names (path-traversal guard).
 */
export function resolveTargetAgentDir(env: CtxEnv, targetAgent: string): string | null {
  validateAgentName(targetAgent);
  if (targetAgent === env.agentName && env.agentDir) {
    return env.agentDir;
  }
  const candidates: string[] = [];
  if (env.agentDir) {
    candidates.push(join(env.agentDir, '..', targetAgent));
  }
  if (env.projectRoot && env.org) {
    candidates.push(join(env.projectRoot, 'orgs', env.org, 'agents', targetAgent));
  }
  if (env.projectRoot) {
    candidates.push(join(env.projectRoot, 'agents', targetAgent));
  }
  for (const candidate of candidates) {
    const dir = resolvePath(candidate);
    if (existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

/**
 * Write .cortextos-env file for backward compatibility with bash bus scripts.
 * Per D6: maintain this pattern.
 */
export function writeCortextosEnv(agentDir: string, env: CtxEnv): void {
  ensureDir(agentDir);
  const content = [
    `CTX_INSTANCE_ID=${env.instanceId}`,
    `CTX_ROOT=${env.ctxRoot}`,
    `CTX_FRAMEWORK_ROOT=${env.frameworkRoot}`,
    `CTX_AGENT_NAME=${env.agentName}`,
    `CTX_ORG=${env.org}`,
    `CTX_AGENT_DIR=${env.agentDir}`,
    `CTX_PROJECT_ROOT=${env.projectRoot}`,
  ].join('\n');

  writeFileSync(join(agentDir, '.cortextos-env'), content + '\n', 'utf-8');
}

/**
 * Parse a KEY=VALUE env file. Supports:
 *   - `#` comments at start of line
 *   - Surrounding single or double quotes on the value (stripped)
 *   - Inline ` #` comments on unquoted values
 * Lines with no `=` are skipped.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    // stripBom + CRLF-aware split: Windows tooling (PowerShell Out-File,
    // Notepad) writes .env files with a UTF-8 BOM at position 0 AND CRLF
    // line endings. Without stripBom the first KEY line never matches
    // because position 0 is the BOM byte; without the regex split, each
    // value gets a trailing \r that breaks downstream validators.
    const content = stripBom(readFileSync(filePath, 'utf-8'));
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue; // no '=' or empty key

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();

      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      } else {
        // Unquoted: strip inline comments starting with ' #'
        const hashIdx = value.indexOf(' #');
        if (hashIdx >= 0) {
          value = value.slice(0, hashIdx).trim();
        }
      }

      result[key] = value;
    }
  } catch {
    // Ignore read errors
  }
  return result;
}

/**
 * Source a .env file into process.env (for agent environment).
 */
export function sourceEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const vars = parseEnvFile(filePath);
  for (const [key, value] of Object.entries(vars)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
