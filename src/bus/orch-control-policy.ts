import { existsSync } from 'fs';
import { join } from 'path';
import { parseEnvFile, resolveEnv } from '../utils/env.js';

export type OrchGateValue =
  | 'blocked'
  | 'draft_only'
  | 'check_prefs'
  | 'approval_required'
  | 'task_authorized'
  | 'enabled'
  | 'all_blocked'
  | 'all_enabled';

export interface ControlPolicyEnforcement {
  gate: string;
  action: string;
  target?: string;
  approvalId?: string;
  taskId?: string;
  exemptOrchestrator?: boolean;
}

interface OrchControlPolicyRow {
  gates?: Record<string, string>;
}

interface RgosCredentials {
  url: string;
  serviceKey: string;
  org: string;
}

const ALLOW_VALUES = new Set<OrchGateValue>(['enabled', 'all_enabled', 'check_prefs']);
const DEFAULT_POLICY_FETCH_TIMEOUT_MS = 750;

function policyFetchTimeoutMs(): number {
  const raw = Number(process.env.CORTEXTOS_POLICY_FETCH_TIMEOUT_MS ?? '');
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_POLICY_FETCH_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(raw), 50), 5000);
}

function loadFileEnv(filePath: string): Record<string, string> {
  return existsSync(filePath) ? parseEnvFile(filePath) : {};
}

function resolveRgosCredentials(): RgosCredentials | null {
  const env = resolveEnv();
  const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
  const org = env.org || process.env.CTX_ORG || 'revops-global';
  const fileEnv = {
    ...loadFileEnv(join(frameworkRoot, '.env')),
    ...loadFileEnv(join(frameworkRoot, 'orgs', org, 'secrets.env')),
    ...loadFileEnv(env.agentDir ? join(env.agentDir, '.env') : ''),
  };

  const url = process.env.SUPABASE_RGOS_URL || fileEnv.SUPABASE_RGOS_URL || '';
  const serviceKey =
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    fileEnv.SUPABASE_RGOS_SERVICE_KEY ||
    fileEnv.RGOS_SUPABASE_SERVICE_KEY ||
    '';

  if (!url || !serviceKey) return null;
  return { url, serviceKey, org };
}

function readOverride(gate: string): string | null {
  const json = process.env.CORTEXTOS_POLICY_OVERRIDE_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const value = parsed[gate];
      if (typeof value === 'string') return value;
    } catch {
      // Ignore malformed test overrides and fall through to live policy.
    }
  }

  const envKey = `CORTEXTOS_POLICY_${gate.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
  return process.env[envKey] || null;
}

async function fetchGateValue(gate: string): Promise<string | null> {
  const override = readOverride(gate);
  if (override) return override;

  const creds = resolveRgosCredentials();
  if (!creds) return null;

  const endpoint =
    `${creds.url}/rest/v1/orch_control_policy?org_id=eq.${encodeURIComponent(creds.org)}&select=gates&limit=1`;
  const response = await fetch(endpoint, {
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(policyFetchTimeoutMs()),
  });

  if (!response.ok) {
    throw new Error(`orch_control_policy fetch failed with ${response.status}`);
  }

  const rows = (await response.json()) as OrchControlPolicyRow[];
  return rows[0]?.gates?.[gate] ?? null;
}

function policyError(req: ControlPolicyEnforcement, value: string, detail: string): Error {
  const target = req.target ? ` target=${req.target}` : '';
  return new Error(
    `orch_control_policy blocked ${req.action}${target}: gate ${req.gate}=${value}. ${detail}`,
  );
}

export async function enforceControlPolicy(req: ControlPolicyEnforcement): Promise<void> {
  const env = resolveEnv();
  const agent = env.agentName || process.env.CTX_AGENT_NAME || '';
  if (req.exemptOrchestrator && agent === 'orchestrator') return;

  let value: string | null = null;
  try {
    value = await fetchGateValue(req.gate);
  } catch (err) {
    if (process.env.CORTEXTOS_POLICY_STRICT === '1') throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orch-control-policy] ${msg}; allowing ${req.action} because strict mode is off`);
    return;
  }

  if (!value) return;
  const normalized = value as OrchGateValue;

  if (ALLOW_VALUES.has(normalized)) return;

  const approvalId =
    req.approvalId ||
    process.env.CORTEXTOS_POLICY_APPROVAL_ID ||
    process.env.CTX_APPROVAL_ID ||
    '';
  const taskId = req.taskId || process.env.CORTEXTOS_TASK_ID || process.env.CTX_TASK_ID || '';

  if (normalized === 'approval_required') {
    if (approvalId) return;
    throw policyError(req, normalized, 'Create an approval and retry with --policy-approval-id or CTX_APPROVAL_ID.');
  }

  if (normalized === 'task_authorized') {
    if (taskId || approvalId) return;
    throw policyError(req, normalized, 'Run from an authorized task context or pass an approval id.');
  }

  if (normalized === 'draft_only') {
    throw policyError(req, normalized, 'This policy only allows drafting, not live sends.');
  }

  if (normalized === 'blocked' || normalized === 'all_blocked') {
    throw policyError(req, normalized, 'This action is disabled by the operator policy.');
  }

  throw policyError(req, normalized, 'Unrecognized gate value; refusing the live action.');
}
