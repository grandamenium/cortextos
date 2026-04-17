import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { CtxEnv } from '../types/index.js';
import { ensureDir } from './atomic.js';
import { validateAgentName, validateOrgName } from './validate.js';

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
        const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
        if (!timezone && ctx.timezone) timezone = ctx.timezone;
        if (!orchestrator && ctx.orchestrator) orchestrator = ctx.orchestrator;
      }
    } catch { /* ignore */ }
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
function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
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
