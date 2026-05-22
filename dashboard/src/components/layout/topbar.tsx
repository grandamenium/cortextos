'use client';

import { useTheme } from 'next-themes';
import { signOut, useSession } from 'next-auth/react';
import { IconSun, IconMoon, IconLogout, IconMenu2 } from '@tabler/icons-react';
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
import { QuotaIndicator } from './quota-indicator';

interface TopbarProps {
  orgs: string[];
  currentOrg: string;
  onOrgChange: (org: string) => void;
  onMenuClick?: () => void;
}

export function Topbar({ orgs, currentOrg, onOrgChange, onMenuClick }: TopbarProps) {
  const { theme, setTheme } = useTheme();
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
        <OrgSelector orgs={orgs} currentOrg={currentOrg} onOrgChange={onOrgChange} />
      </div>

      {/* Right: Quota + Dark mode toggle + User menu */}
      <div className="flex items-center gap-1">
        <QuotaIndicator />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          <IconSun size={16} className="rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
          <IconMoon size={16} className="absolute rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
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
