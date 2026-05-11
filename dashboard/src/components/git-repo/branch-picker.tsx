'use client';

import { IconChevronDown, IconGitBranch } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface BranchPickerProps {
  branches: string[];
  current: string;
  selected: string;
  onSelect: (branch: string) => void;
}

export function BranchPicker({ branches, current, selected, onSelect }: BranchPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(props) => (
          <Button {...props} variant="outline" size="default" className="min-w-[220px] justify-between">
            <span className="flex items-center gap-2 truncate">
              <IconGitBranch size={14} className="text-muted-foreground" />
              <span className="font-mono text-[13px] truncate">{selected || '—'}</span>
              {selected === current && (
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  HEAD
                </span>
              )}
            </span>
            <IconChevronDown size={14} className="text-muted-foreground" />
          </Button>
        )}
      />
      <DropdownMenuContent className="min-w-[260px]" align="start">
        {branches.map((b) => (
          <DropdownMenuItem
            key={b}
            onClick={() => onSelect(b)}
            className="flex items-center gap-2"
          >
            <IconGitBranch size={14} className="text-muted-foreground" />
            <span className="font-mono text-[13px] flex-1 truncate">{b}</span>
            {b === current && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                HEAD
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
