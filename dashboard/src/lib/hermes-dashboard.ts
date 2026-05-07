import { getAgentRuntime } from '@/lib/agent-runtime';

export const HERMES_DASHBOARD_DEFAULT = 'http://127.0.0.1:9119';

export async function getHermesDashboardBase(agentName?: string): Promise<string> {
  if (agentName) {
    const runtime = await getAgentRuntime(agentName).catch(() => null);
    if (runtime?.hermesDashboard) return runtime.hermesDashboard;
  }
  return process.env.HERMES_DASHBOARD_URL || HERMES_DASHBOARD_DEFAULT;
}

export async function proxyHermesDashboard(
  path: string,
  init: RequestInit = {},
  agentName?: string,
): Promise<Response> {
  const base = await getHermesDashboardBase(agentName);
  const upstream = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.HERMES_API_TOKEN ? { Authorization: `Bearer ${process.env.HERMES_API_TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  const headers = new Headers(upstream.headers);
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
