import { Skills } from '@/components/inspector/Skills';

export default async function AgentSkillsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <Skills agentName={decodeURIComponent(name)} />;
}
