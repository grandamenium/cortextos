export const dynamic = 'force-dynamic';

import { WikiShell } from '@/components/wiki/wiki-shell';
import { getVaultStatus } from '@/lib/vault';

interface PageProps {
  searchParams: Promise<{ org?: string }>;
}

export default async function WikiPage({ searchParams }: PageProps) {
  const params = await searchParams;
  return <WikiShell org={params.org} initialVaultStatus={getVaultStatus()} />;
}
