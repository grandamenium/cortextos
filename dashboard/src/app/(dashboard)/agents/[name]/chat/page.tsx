import { Chat } from '@/components/inspector/Chat';

export default async function AgentChatPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <Chat agentName={decodeURIComponent(name)} />;
}
