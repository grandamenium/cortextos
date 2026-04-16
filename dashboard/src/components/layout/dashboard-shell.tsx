'use client';

import { useState, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { BottomNav } from './bottom-nav';
import { OrgContext } from '@/hooks/use-org';
import {
  Sheet,
  SheetContent,
} from '@/components/ui/sheet';

interface DashboardShellProps {
  orgs: string[];
  children: React.ReactNode;
}

export function DashboardShell({ orgs, children }: DashboardShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [currentOrg, setCurrentOrg] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('cortextos-org');
      if (saved && (saved === 'all' || orgs.includes(saved))) return saved;
    }
    return 'all';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Persist org selection to localStorage
  useEffect(() => {
    localStorage.setItem('cortextos-org', currentOrg);
  }, [currentOrg]);

  // On mount, sync URL to match the saved org so the server re-renders with
  // the correct filter. Without this, the selector shows the saved org but
  // the page renders with all agents (no ?org= param in the URL).
  useEffect(() => {
    const urlOrg = searchParams.get('org');
    if (currentOrg === 'all' && !urlOrg) return; // both mean "all", no navigation needed
    if (currentOrg !== 'all' && urlOrg === currentOrg) return; // already in sync
    const params = new URLSearchParams(searchParams.toString());
    if (currentOrg === 'all') {
      params.delete('org');
    } else {
      params.set('org', currentOrg);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount only

  return (
    <OrgContext.Provider value={{ currentOrg, setCurrentOrg, orgs }}>
      <div className="flex h-screen">
        {/* Desktop sidebar */}
        <div className="hidden md:block">
          <Sidebar onNavigate={() => {}} />
        </div>

        {/* Mobile sidebar sheet */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-60 p-0" showCloseButton={false}>
            <Sidebar onNavigate={() => setSidebarOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar
            orgs={orgs}
            currentOrg={currentOrg}
            onOrgChange={setCurrentOrg}
            onMenuClick={() => setSidebarOpen(true)}
          />
          <main className="flex-1 overflow-auto p-4 pb-20 md:pb-5 md:p-5 lg:p-6 bg-background">
            {children}
          </main>

          {/* Mobile bottom navigation */}
          <BottomNav />
        </div>
      </div>
    </OrgContext.Provider>
  );
}
