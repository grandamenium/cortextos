import { Mcp } from '@/components/inspector/Mcp';

export default async function AgentMcpPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <Mcp agentName={decodeURIComponent(name)} />;
}
