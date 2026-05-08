import { Memory } from '@/components/inspector/Memory';

export default async function AgentMemoryPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <Memory agentName={decodeURIComponent(name)} />;
}
