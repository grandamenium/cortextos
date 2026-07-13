import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getOrgs } from '@/lib/config';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { syncAll } from '@/lib/sync';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers();
  const pathname = requestHeaders.get('x-dashboard-pathname') ?? '';
  const isPublicSopRoute = pathname === '/sops' || pathname.startsWith('/sops/');
  const isPublicWikiRoute = pathname === '/wiki';
  const isPublicRoute = isPublicSopRoute || isPublicWikiRoute;

  const session = isPublicRoute ? null : await auth();
  if (!isPublicRoute && !session) redirect('/login');

  if (!isPublicRoute) {
    // Sync filesystem state to SQLite on every page load
    // This ensures the dashboard always reflects the latest agent activity
    try {
      syncAll();
    } catch (e) {
      console.error('Sync failed:', e);
    }
  }

  const orgs = getOrgs();

  return <DashboardShell orgs={orgs}>{children}</DashboardShell>;
}
