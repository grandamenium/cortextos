import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir, platform } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
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
export function parseEnvFile(filePath: string): Record<string, string> {
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
 * Build the complete environment for a spawned agent runtime.
 *
 * This is shared by the long-lived PTY path and one-shot fresh-session cron
 * spawns so both receive the same CTX_* values, org secrets, agent .env, and
 * timezone/orchestrator conveniences.
 */
export function buildAgentRuntimeEnv(env: CtxEnv, config: AgentConfig): NodeJS.ProcessEnv {
  const ptyEnv: NodeJS.ProcessEnv = {
    ...getBaseRuntimeEnv(),
    CTX_INSTANCE_ID: env.instanceId,
    CTX_ROOT: env.ctxRoot,
    CTX_FRAMEWORK_ROOT: env.frameworkRoot,
    CTX_AGENT_NAME: env.agentName,
    CTX_ORG: env.org,
    CTX_AGENT_DIR: env.agentDir,
    CTX_PROJECT_ROOT: env.projectRoot,
    // Backward compat
    CRM_AGENT_NAME: env.agentName,
    CRM_TEMPLATE_ROOT: env.frameworkRoot,
  };

  // Source org-level shared secrets first. Agent .env overrides below.
  if (env.org && env.projectRoot) {
    Object.assign(ptyEnv, parseEnvFile(join(env.projectRoot, 'orgs', env.org, 'secrets.env')));
  }

  // Source agent-specific secrets.
  if (env.agentDir) {
    Object.assign(ptyEnv, parseEnvFile(join(env.agentDir, '.env')));
  }

  if (ptyEnv['CHAT_ID']) {
    ptyEnv['CTX_TELEGRAM_CHAT_ID'] = ptyEnv['CHAT_ID'];
  }

  const configTimezone = config.timezone;
  if (configTimezone) {
    ptyEnv['CTX_TIMEZONE'] = configTimezone;
    ptyEnv['TZ'] = configTimezone;
  } else if (process.env.TZ) {
    ptyEnv['CTX_TIMEZONE'] = process.env.TZ;
    ptyEnv['TZ'] = process.env.TZ;
  }

  if (env.projectRoot && env.org) {
    try {
      const contextPath = join(env.projectRoot, 'orgs', env.org, 'context.json');
      if (existsSync(contextPath)) {
        const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
        if (ctx.orchestrator) {
          ptyEnv['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
        }
      }
    } catch { /* leave unset if context.json is missing or malformed */ }
  }

  return ptyEnv;
}

function getBaseRuntimeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keepVars = [
    'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
    'TMPDIR', 'TEMP', 'TMP', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
    'NODE_PATH', 'COMSPEC', 'USERPROFILE',
    // Claude Code env passthroughs.
    // IS_SANDBOX=1 lets --dangerously-skip-permissions run under root on
    // VPS/container installs. CLAUDE_CODE_DISABLE_1M_CONTEXT controls the
    // Sonnet/Haiku 1M context opt-out documented in the .env template.
    'IS_SANDBOX', 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    // Windows path-expansion essentials. Stripping these causes phantom
    // %SystemDrive% directories from inherited Search Indexer processes
    // and Unity batchmode UPM IPC crashes (path.join(undefined,...)).
    'SystemDrive', 'SystemRoot', 'windir',
    'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
    'HOMEDRIVE', 'HOMEPATH', 'PUBLIC',
  ];
  for (const key of keepVars) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  if (platform() === 'win32') {
    if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
    if (!env['LC_ALL']) env['LC_ALL'] = 'en_US.UTF-8';
    if (!process.env['PYTHONIOENCODING']) env['PYTHONIOENCODING'] = 'utf-8';
  }

  return env;
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
