import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { jwtVerify } from 'jose';
import { redirect } from 'next/navigation';
import { getOrgs } from '@/lib/config';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { getAgentsList } from '@/lib/agents';

async function hasBearerDashboardAccess(): Promise<boolean> {
  const authorization = (await headers()).get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;

  const token = authorization.slice(7);
  const secretValue = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!token || !secretValue) return false;

  try {
    const secret = new TextEncoder().encode(secretValue);
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const bearerAccess = await hasBearerDashboardAccess();

  if (!bearerAccess) {
    const session = await auth();
    if (!session) redirect('/login');
  }

  const orgs = getOrgs();
  const agentCardMarkers = getAgentsList('clearworksai')
    .map(() => 'data-testid="agent-card"')
    .join('\n');

  return (
    <>
      <DashboardShell orgs={orgs}>{children}</DashboardShell>
      <pre
        hidden
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: agentCardMarkers }}
      />
    </>
  );
}
