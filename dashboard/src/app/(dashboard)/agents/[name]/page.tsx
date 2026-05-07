import { redirect } from 'next/navigation';

export default async function AgentDefaultPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  redirect(`/agents/${encodeURIComponent(decodeURIComponent(name))}/chat`);
}
