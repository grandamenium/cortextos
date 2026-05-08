import fs from 'fs/promises';
import path from 'path';
import * as yaml from 'js-yaml';
import { getAgentRuntime, getHermesHome } from '@/lib/agent-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type McpServer = {
  name: string;
  command: string;
  args: string[];
  disabled: boolean;
  status: 'running' | 'disabled';
};

function normalizeServers(config: Record<string, unknown>): McpServer[] {
  const raw = (config.mcp_servers ?? config.mcpServers ?? {}) as Record<string, unknown>;
  return Object.entries(raw).map(([name, value]) => {
    const item = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
    const disabled = item.disabled === true || item.enabled === false;
    return {
      name,
      command: typeof item.command === 'string' ? item.command : '',
      args: Array.isArray(item.args) ? item.args.map(String) : [],
      disabled,
      status: disabled ? 'disabled' : 'running',
    };
  });
}

async function readConfig(configPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(configPath, 'utf-8').catch(() => '');
  return (yaml.load(raw) || {}) as Record<string, unknown>;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  const configPath = agent.runtime === 'hermes'
    ? path.join(getHermesHome(), 'config.yaml')
    : path.join(agent.home, '.mcp.yaml');
  const config = await readConfig(configPath);
  return Response.json({
    servers: normalizeServers(config),
    config: yaml.dump(config),
    configPath,
    restartRequired: false,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  const body = (await request.json().catch(() => ({}))) as { server?: string; disabled?: boolean; config?: string };
  const configPath = agent.runtime === 'hermes'
    ? path.join(getHermesHome(), 'config.yaml')
    : path.join(agent.home, '.mcp.yaml');

  let config: Record<string, unknown>;
  if (typeof body.config === 'string') {
    config = (yaml.load(body.config) || {}) as Record<string, unknown>;
  } else {
    config = await readConfig(configPath);
    const servers = (config.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
    if (!body.server || !servers[body.server]) {
      return Response.json({ error: 'server not found' }, { status: 404 });
    }
    servers[body.server] = { ...servers[body.server], disabled: body.disabled === true };
    config.mcp_servers = servers;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.dump(config, { lineWidth: 100 }), 'utf-8');
  return Response.json({ ok: true, servers: normalizeServers(config), restartRequired: true });
}
