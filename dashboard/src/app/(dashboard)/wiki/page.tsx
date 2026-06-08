export const dynamic = 'force-dynamic';

import { WikiShell } from '@/components/wiki/wiki-shell';

interface PageProps {
  searchParams: Promise<{ org?: string }>;
}

export default async function WikiPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const org = params.org ?? 'sondre-hq';
  return <WikiShell org={org} />;
}
