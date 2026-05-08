import { NextRequest } from 'next/server';
import { proxyHermesDashboard } from '@/lib/hermes-dashboard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function forward(request: NextRequest, id: string, method: string) {
  const body = method === 'GET' ? undefined : await request.text();
  const search = new URL(request.url).search;
  return proxyHermesDashboard(`/api/jobs/${encodeURIComponent(id)}${search}`, { method, body });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { return await forward(request, id, 'GET'); } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { return await forward(request, id, 'PATCH'); } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { return await forward(request, id, 'POST'); } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { return await forward(request, id, 'DELETE'); } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
