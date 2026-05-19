import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const AGENT_LIVE_STATE_BUCKET = 'agent-live-state';

export interface AgentLiveStateIdentity {
  ctxRoot?: string;
  org?: string;
  agent?: string;
  taskId?: string;
}

export interface AgentLiveStateFileFlags {
  hasLog: boolean;
  hasDiff: boolean;
  hasScreenshot: boolean;
}

export interface AgentLiveStateHandle extends Required<AgentLiveStateIdentity> {
  dir: string;
  storagePrefix: string;
  files: {
    log: string;
    diff: string;
    screenshot: string;
    manifest: string;
  };
}

interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

function safeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'unknown';
}

function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_RGOS_URL || process.env.RGOS_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url: url.replace(/\/$/, ''), serviceKey };
}

function storageObjectUrl(config: SupabaseConfig, storagePath: string): string {
  return `${config.url}/storage/v1/object/${AGENT_LIVE_STATE_BUCKET}/${storagePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function fileFlags(handle: AgentLiveStateHandle): AgentLiveStateFileFlags {
  return {
    hasLog: existsSync(handle.files.log),
    hasDiff: existsSync(handle.files.diff),
    hasScreenshot: existsSync(handle.files.screenshot),
  };
}

export function createAgentLiveStateHandle(identity: AgentLiveStateIdentity): AgentLiveStateHandle | null {
  const ctxRoot = identity.ctxRoot || process.env.CTX_ROOT;
  const org = identity.org || process.env.CTX_ORG;
  const agent = identity.agent || process.env.CTX_AGENT_NAME;
  const taskId = identity.taskId;
  if (!ctxRoot || !org || !agent || !taskId) return null;

  const cleanOrg = safeSegment(org);
  const cleanAgent = safeSegment(agent);
  const cleanTask = safeSegment(taskId);
  const dir = join(ctxRoot, 'orgs', cleanOrg, 'agents', cleanAgent, 'output', cleanTask);
  mkdirSync(dir, { recursive: true });

  return {
    ctxRoot,
    org: cleanOrg,
    agent: cleanAgent,
    taskId: cleanTask,
    dir,
    storagePrefix: `${cleanOrg}/${cleanAgent}/${cleanTask}`,
    files: {
      log: join(dir, 'live.log'),
      diff: join(dir, 'live.diff'),
      screenshot: join(dir, 'live.screenshot.png'),
      manifest: join(dir, 'manifest.json'),
    },
  };
}

export function writeAgentLiveManifest(handle: AgentLiveStateHandle, extra: Record<string, unknown> = {}): void {
  const flags = fileFlags(handle);
  const manifest = {
    org: handle.org,
    agent: handle.agent,
    task_id: handle.taskId,
    storage_prefix: handle.storagePrefix,
    updated_at: new Date().toISOString(),
    ...flags,
    ...extra,
  };
  writeFileSync(handle.files.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export function appendAgentLiveLog(handle: AgentLiveStateHandle, chunk: string): void {
  mkdirSync(dirname(handle.files.log), { recursive: true });
  appendFileSync(handle.files.log, chunk, 'utf-8');
  writeAgentLiveManifest(handle);
}

export function writeAgentLiveDiff(handle: AgentLiveStateHandle, diff: string): void {
  mkdirSync(dirname(handle.files.diff), { recursive: true });
  writeFileSync(handle.files.diff, diff, 'utf-8');
  writeAgentLiveManifest(handle);
}

async function uploadObject(config: SupabaseConfig, storagePath: string, body: Buffer | string, contentType: string): Promise<void> {
  const res = await fetch(storageObjectUrl(config, storagePath), {
    method: 'POST',
    headers: {
      apikey: config.serviceKey,
      authorization: `Bearer ${config.serviceKey}`,
      'content-type': contentType,
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Supabase storage upload failed ${res.status}: ${await res.text()}`);
  }
}

async function upsertMetadata(config: SupabaseConfig, handle: AgentLiveStateHandle, flags: AgentLiveStateFileFlags): Promise<void> {
  const res = await fetch(`${config.url}/rest/v1/agent_live_state?on_conflict=org,agent,task_id`, {
    method: 'POST',
    headers: {
      apikey: config.serviceKey,
      authorization: `Bearer ${config.serviceKey}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      org: handle.org,
      agent: handle.agent,
      task_id: handle.taskId,
      storage_prefix: handle.storagePrefix,
      has_log: flags.hasLog,
      has_diff: flags.hasDiff,
      has_screenshot: flags.hasScreenshot,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    throw new Error(`Supabase agent_live_state upsert failed ${res.status}: ${await res.text()}`);
  }
}

export async function mirrorAgentLiveState(handle: AgentLiveStateHandle | null): Promise<{ ok: boolean; error?: string }> {
  if (!handle) return { ok: false, error: 'missing live state handle' };
  const config = supabaseConfig();
  if (!config) return { ok: false, error: 'Supabase RGOS service config missing' };

  try {
    writeAgentLiveManifest(handle);
    const flags = fileFlags(handle);
    const uploads: Promise<void>[] = [];
    if (flags.hasLog) {
      uploads.push(uploadObject(config, `${handle.storagePrefix}/live.log`, readFileSync(handle.files.log), 'text/plain'));
    }
    if (flags.hasDiff) {
      uploads.push(uploadObject(config, `${handle.storagePrefix}/live.diff`, readFileSync(handle.files.diff), 'text/plain'));
    }
    if (flags.hasScreenshot) {
      uploads.push(uploadObject(config, `${handle.storagePrefix}/live.screenshot.png`, readFileSync(handle.files.screenshot), 'image/png'));
    }
    uploads.push(uploadObject(config, `${handle.storagePrefix}/manifest.json`, readFileSync(handle.files.manifest), 'application/json'));
    await Promise.all(uploads);
    await upsertMetadata(config, handle, flags);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function tailFile(filePath: string, maxLines = 50): string {
  if (!existsSync(filePath)) return '';
  const size = statSync(filePath).size;
  const maxBytes = 64 * 1024;
  const content = readFileSync(filePath, 'utf-8').slice(Math.max(0, size - maxBytes));
  return content.split(/\r?\n/).slice(-maxLines).join('\n').trimEnd();
}
