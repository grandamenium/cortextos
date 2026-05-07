import { getAgentRuntime } from '@/lib/agent-runtime';
import { createTerminalSession } from '@/lib/terminal-sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  return Response.json({ sessionId: createTerminalSession(agent.workingDir), cwd: agent.workingDir });
}
