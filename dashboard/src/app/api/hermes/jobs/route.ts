import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFrameworkRoot } from '@/lib/config';
import { proxyHermesDashboard } from '@/lib/hermes-dashboard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);

async function listBusCrons() {
  try {
    const { stdout } = await execFileAsync('cortextos', ['bus', 'list-crons', '--format', 'json'], {
      cwd: getFrameworkRoot(),
      timeout: 8_000,
    });
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const search = new URL(request.url).search;
  const [busCrons, hermesResponse] = await Promise.all([
    listBusCrons(),
    proxyHermesDashboard(`/api/jobs${search}`, { method: 'GET' }).catch((error) => error as Error),
  ]);
  if (hermesResponse instanceof Error) {
    return Response.json({ busCrons, hermesJobs: [], degraded: true, error: hermesResponse.message });
  }
  const hermesPayload = await hermesResponse.json().catch(() => ({}));
  const hermesJobs = Array.isArray(hermesPayload) ? hermesPayload : Array.isArray(hermesPayload.jobs) ? hermesPayload.jobs : [];
  return Response.json({ busCrons, hermesJobs });
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    return await proxyHermesDashboard('/api/jobs', { method: 'POST', body });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
