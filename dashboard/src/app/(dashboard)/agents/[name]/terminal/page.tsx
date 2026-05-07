import { Terminal } from '@/components/inspector/Terminal';

export default async function AgentTerminalPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <Terminal agentName={decodeURIComponent(name)} />;
}
