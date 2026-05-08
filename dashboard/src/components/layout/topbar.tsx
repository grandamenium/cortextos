'use client';

import { useTheme } from 'next-themes';
import { signOut, useSession } from 'next-auth/react';
import { IconLogout, IconMenu2, IconPalette, IconSettings } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { OrgSelector } from './org-selector';
import { THEMES, updateDashboardSettings, useDashboardSettings, type DashboardTheme } from '@/lib/dashboard-settings';

interface TopbarProps {
  orgs: string[];
  currentOrg: string;
  onOrgChange: (org: string) => void;
  onMenuClick?: () => void;
}

export function Topbar({ orgs, currentOrg, onOrgChange, onMenuClick }: TopbarProps) {
  useTheme();
  const settings = useDashboardSettings();
  const { data: session } = useSession();

  const username = session?.user?.name ?? 'User';
  const initials = username
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b bg-card/50 px-4">
      {/* Left: Menu button (mobile) + Org Selector */}
      <div className="flex items-center gap-2">
        {onMenuClick && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onMenuClick}
            className="md:hidden h-8 w-8"
            aria-label="Open menu"
          >
            <IconMenu2 size={18} />
          </Button>
        )}
        <div className="hidden items-center gap-2 pr-2 text-sm font-semibold sm:flex">
          <span>cortextOS</span>
        </div>
        <OrgSelector orgs={orgs} currentOrg={currentOrg} onOrgChange={onOrgChange} />
      </div>

      {/* Right: Theme + Settings + User menu */}
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-lg outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" aria-label="Switch theme">
            <IconPalette size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8}>
            {THEMES.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onClick={() => updateDashboardSettings({ theme: item.id as DashboardTheme })}
                className={settings.theme === item.id ? 'font-semibold text-primary' : ''}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => window.dispatchEvent(new CustomEvent('cortextos:open-settings'))}
          aria-label="Open settings"
        >
          <IconSettings size={16} />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer">
            <Avatar size="sm">
              <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8}>
            <div className="px-2 py-1.5 text-sm">
              <p className="font-medium">{username}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => window.dispatchEvent(new CustomEvent('cortextos:open-settings'))}>
              <IconSettings size={14} />
              <span>Settings</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.location.assign('/onboarding')}>
              <span>Run onboarding</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut({ redirectTo: '/login' })}>
              <IconLogout size={14} />
              <span>Logout</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
