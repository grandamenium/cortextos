import { Files } from '@/components/inspector/Files';

export default async function AgentFilesPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <Files agentName={decodeURIComponent(name)} />;
}
