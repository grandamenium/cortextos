'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOrg } from '@/hooks/use-org';
import {
  IconLayoutDashboard,
  IconListCheck,
  IconShieldCheck,
  IconChartDots3,
  IconDotsVertical,
  IconRobot,
  IconActivity,
  IconMessages,
  IconBook2,
  IconFlask,
  IconPuzzle,
  IconSettings,
  IconClock,
  IconTarget,
  IconX,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';

const mainTabs = [
  { label: 'Overview', href: '/', icon: IconLayoutDashboard },
  { label: 'Tasks', href: '/tasks', icon: IconListCheck },
  { label: 'Approvals', href: '/approvals', icon: IconShieldCheck },
  { label: 'Analytics', href: '/analytics', icon: IconChartDots3 },
];

const morePages = [
  { label: 'Agents', href: '/agents', icon: IconRobot },
  { label: 'Comms', href: '/comms', icon: IconMessages },
  { label: 'Activity', href: '/activity', icon: IconActivity },
  { label: 'Knowledge Base', href: '/knowledge-base', icon: IconBook2 },
  { label: 'Workflows', href: '/workflows', icon: IconClock },
  { label: 'Strategy', href: '/strategy', icon: IconTarget },
  { label: 'Experiments', href: '/experiments', icon: IconFlask },
  { label: 'Skills', href: '/skills', icon: IconPuzzle },
  { label: 'Settings', href: '/settings', icon: IconSettings },
];

export function BottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const { currentOrg } = useOrg();

  function orgHref(href: string) {
    if (currentOrg && currentOrg !== 'all') {
      return `${href}${href.includes('?') ? '&' : '?'}org=${encodeURIComponent(currentOrg)}`;
    }
    return href;
  }

  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  const isMoreActive = morePages.some(p => isActive(p.href));

  return (
    <>
      {/* More menu sheet */}
      {moreOpen && (
        <div className="fixed inset-0 z-[60] md:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute bottom-14 left-0 right-0 rounded-t-2xl bg-card border-t shadow-xl safe-area-bottom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <span className="text-sm font-medium">More</span>
              <button onClick={() => setMoreOpen(false)} className="p-1 text-muted-foreground">
                <IconX size={18} />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1 px-3 pb-4">
              {morePages.map((page) => {
                const Icon = page.icon;
                const active = isActive(page.href);
                return (
                  <Link
                    key={page.href}
                    href={orgHref(page.href)}
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg py-3 transition-colors',
                      active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
                    )}
                  >
                    <Icon size={22} strokeWidth={1.5} />
                    <span className="text-[10px] font-medium">{page.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-card/95 backdrop-blur-sm md:hidden safe-area-bottom">
        <div className="flex items-center justify-around h-14">
          {mainTabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.href);
            return (
              <Link
                key={tab.href}
                href={orgHref(tab.href)}
                className={cn(
                  'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                <Icon size={20} strokeWidth={active ? 2.5 : 1.5} />
                <span className="text-[10px] font-medium">{tab.label}</span>
              </Link>
            );
          })}
          {/* More button */}
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
              isMoreActive || moreOpen ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <IconDotsVertical size={20} strokeWidth={isMoreActive || moreOpen ? 2.5 : 1.5} />
            <span className="text-[10px] font-medium">More</span>
          </button>
        </div>
      </nav>
    </>
  );
}
