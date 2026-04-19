import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getOrgs, getBrandName } from '@/lib/config';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { syncAll } from '@/lib/sync';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect('/login');

  // Sync filesystem state to SQLite on every page load
  // This ensures the dashboard always reflects the latest agent activity
  try {
    syncAll();
  } catch (e) {
    console.error('Sync failed:', e);
  }

  const orgs = getOrgs();
  const brandName = getBrandName();

  return <DashboardShell orgs={orgs} brandName={brandName}>{children}</DashboardShell>;
}
