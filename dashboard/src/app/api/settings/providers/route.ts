import fs from 'fs/promises';
import path from 'path';
import * as yaml from 'js-yaml';
import { getHermesHome } from '@/lib/agent-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ProviderRecord = {
  name: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
  configured: boolean;
};

function configPath() {
  return path.join(getHermesHome(), 'config.yaml');
}

function mask(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function normalizeProviders(config: Record<string, unknown>): ProviderRecord[] {
  const providers = config.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
  return Object.entries(providers as Record<string, Record<string, unknown>>).map(([name, provider]) => {
    const apiKey = provider.api_key ?? provider.apiKey ?? provider.key;
    return {
      name,
      type: String(provider.type ?? provider.provider ?? name),
      apiKey: mask(apiKey),
      baseUrl: typeof provider.base_url === 'string' ? provider.base_url : typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined,
      configured: typeof apiKey === 'string' && apiKey.length > 0,
    };
  });
}

async function readConfig(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(configPath(), 'utf-8').catch(() => '');
  if (!raw) return {};
  return (yaml.load(raw) ?? {}) as Record<string, unknown>;
}

export async function GET() {
  const config = await readConfig();
  return Response.json({ providers: normalizeProviders(config), path: configPath() });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!name || !type) return Response.json({ error: 'name and type are required' }, { status: 400 });

  const config = await readConfig();
  const providers = (config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers))
    ? { ...(config.providers as Record<string, unknown>) }
    : {};
  providers[name] = {
    ...(providers[name] && typeof providers[name] === 'object' ? providers[name] as Record<string, unknown> : {}),
    type,
    ...(apiKey ? { api_key: apiKey } : {}),
  };
  const nextConfig = { ...config, providers };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), yaml.dump(nextConfig), 'utf-8');
  return Response.json({ providers: normalizeProviders(nextConfig) });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const type = typeof body.type === 'string' ? body.type : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  if (!type) return Response.json({ ok: false, error: 'type is required' }, { status: 400 });
  const envName = `${type.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const available = Boolean(apiKey || process.env[envName]);
  return Response.json({ ok: available, message: available ? 'Provider credentials present.' : `No ${envName} found.` });
}
