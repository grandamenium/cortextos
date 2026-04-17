'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOrg } from '@/hooks/use-org';
import {
  IconLayoutDashboard,
  IconRobot,
  IconListCheck,
  IconShieldCheck,
  IconActivity,
  IconChartDots3,
  IconFlask,
  IconBook2,
  IconPuzzle,
  IconSettings,
  IconSearch,
  IconClock,
  IconTarget,
  IconMessages,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  badge?: number;
  section?: string;
}

const navItems: NavItem[] = [
  // Core
  { label: 'Overview', href: '/', icon: IconLayoutDashboard, section: 'core' },
  { label: 'Agents', href: '/agents', icon: IconRobot, section: 'core' },
  { label: 'Tasks', href: '/tasks', icon: IconListCheck, section: 'core' },
  { label: 'Activity', href: '/activity', icon: IconActivity, section: 'core' },

  // Operations
  { label: 'Comms', href: '/comms', icon: IconMessages, section: 'ops' },
  { label: 'Approvals', href: '/approvals', icon: IconShieldCheck, section: 'ops' },
  { label: 'Workflows', href: '/workflows', icon: IconClock, section: 'ops' },
  { label: 'Strategy', href: '/strategy', icon: IconTarget, section: 'ops' },
  { label: 'Analytics', href: '/analytics', icon: IconChartDots3, section: 'ops' },

  // Intelligence
  { label: 'Knowledge Base', href: '/knowledge-base', icon: IconBook2, section: 'intel' },
  { label: 'Experiments', href: '/experiments', icon: IconFlask, section: 'intel' },
  { label: 'Skills', href: '/skills', icon: IconPuzzle, section: 'intel' },
];

const sectionLabels: Record<string, string> = {
  core: '',
  ops: 'Operations',
  intel: 'Intelligence',
};

interface SidebarProps {
  pendingApprovals?: number;
  inProgressTasks?: number;
  onNavigate?: () => void;
  onSearchClick?: () => void;
}

export function Sidebar({
  pendingApprovals = 0,
  inProgressTasks = 0,
  onNavigate,
  onSearchClick,
}: SidebarProps) {
  const pathname = usePathname();
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

  function getBadge(item: NavItem): number {
    if (item.href === '/approvals') return pendingApprovals;
    if (item.href === '/tasks') return inProgressTasks;
    return 0;
  }

  // Group items by section
  const sections = ['core', 'ops', 'intel'];

  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r bg-card/50">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
          cO
        </div>
        <span className="text-sm font-semibold tracking-tight">cortextOS</span>
      </div>

      {/* Search trigger */}
      <div className="px-3 pb-2">
        <button
          onClick={onSearchClick}
          className="flex w-full items-center gap-2 rounded-md border bg-background/50 px-3 py-1.5 text-xs text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
        >
          <IconSearch size={14} />
          <span>Search...</span>
          <kbd className="ml-auto rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">
            /
          </kbd>
        </button>
      </div>

      <Separator />

      {/* Navigation */}
      <nav className="flex flex-1 flex-col overflow-y-auto px-2 py-2">
        {sections.map((section) => {
          const items = navItems.filter((i) => i.section === section);
          const label = sectionLabels[section];

          return (
            <div key={section} className="mb-1">
              {label && (
                <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  {label}
                </p>
              )}
              {items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                const badge = getBadge(item);

                return (
                  <Link
                    key={item.href}
                    href={orgHref(item.href)}
                    onClick={onNavigate}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-all',
                      active
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                    )}
                  >
                    <Icon
                      size={16}
                      className={cn(
                        'shrink-0 transition-colors',
                        active ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground'
                      )}
                    />
                    <span className="truncate">{item.label}</span>
                    {badge > 0 && (
                      <Badge
                        variant={active ? 'default' : 'secondary'}
                        className="ml-auto h-4.5 min-w-5 px-1 text-[10px] font-medium"
                      >
                        {badge}
                      </Badge>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <Separator />

      {/* Settings at bottom */}
      <div className="px-2 py-2">
        <Link
          href={orgHref('/settings')}
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-all',
            isActive('/settings')
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          )}
        >
          <IconSettings size={16} className="shrink-0" />
          <span>Settings</span>
        </Link>
      </div>
    </aside>
  );
}
