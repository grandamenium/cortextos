'use client';

import { useState, useEffect } from 'react';
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
  const [currentOrg, setCurrentOrg] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      // URL is authoritative: if ?org= is present, use it so server and client agree.
      // Fall back to localStorage for the common case of navigating without a param.
      const urlOrg = new URLSearchParams(window.location.search).get('org');
      if (urlOrg && (urlOrg === 'all' || orgs.includes(urlOrg))) return urlOrg;
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
