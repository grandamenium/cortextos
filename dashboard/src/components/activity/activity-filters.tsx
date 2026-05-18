'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { IconX } from '@tabler/icons-react';
import type { EventType } from '@/lib/types';
import type { EventFeedFilters } from './event-feed';

const EVENT_TYPES: { value: EventType; label: string }[] = [
  { value: 'message', label: 'Message' },
  { value: 'task', label: 'Task' },
  { value: 'approval', label: 'Approval' },
  { value: 'error', label: 'Error' },
  { value: 'milestone', label: 'Milestone' },
  { value: 'heartbeat', label: 'Heartbeat' },
  { value: 'action', label: 'Action' },
];

interface ActivityFiltersProps {
  filters: EventFeedFilters;
  onFiltersChange: (filters: EventFeedFilters) => void;
  agents: string[];
  orgs: string[];
}

export function ActivityFilters({
  filters,
  onFiltersChange,
  agents,
  orgs,
}: ActivityFiltersProps) {
  const toggleType = (type: EventType) => {
    const types = filters.types.includes(type)
      ? filters.types.filter((t) => t !== type)
      : [...filters.types, type];
    onFiltersChange({ ...filters, types });
  };

  const hasActive =
    filters.types.length > 0 ||
    filters.agent !== '' ||
    filters.org !== '' ||
    filters.from !== undefined ||
    filters.to !== undefined;

  const clearAll = () => {
    onFiltersChange({
      types: [],
      agent: '',
      org: '',
      from: undefined,
      to: undefined,
    });
  };

  return (
    <div className="space-y-4">
      {/* Type checkboxes */}
      <div>
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Event Types
        </span>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-3">
          {EVENT_TYPES.map((et) => (
            <label key={et.value} className="flex min-h-8 items-center gap-1.5 rounded-lg border bg-background/40 px-2 cursor-pointer sm:min-h-0 sm:border-0 sm:bg-transparent sm:px-0">
              <Checkbox
                checked={filters.types.includes(et.value)}
                onCheckedChange={() => toggleType(et.value)}
              />
              <Label className="text-sm cursor-pointer">{et.label}</Label>
            </label>
          ))}
        </div>
      </div>

      {/* Agent + Org + Date range */}
      <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
        <div className="col-span-2 sm:col-span-1">
          <Label className="text-xs text-muted-foreground">Agent</Label>
          <Select
            value={filters.agent || 'all'}
            onValueChange={(v) =>
              onFiltersChange({ ...filters, agent: v === 'all' ? '' : (v ?? '') })
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-[160px]">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="text-xs text-muted-foreground">Org</Label>
          <Select
            value={filters.org || 'all'}
            onValueChange={(v) =>
              onFiltersChange({ ...filters, org: v === 'all' ? '' : (v ?? '') })
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-[160px]">
              <SelectValue placeholder="All orgs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All orgs</SelectItem>
              {orgs.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">From</Label>
          <Input
            type="date"
            value={filters.from ?? ''}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                from: e.target.value || undefined,
              })
            }
            className="h-8 w-full text-xs sm:w-[140px]"
          />
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input
            type="date"
            value={filters.to ?? ''}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                to: e.target.value || undefined,
              })
            }
            className="h-8 w-full text-xs sm:w-[140px]"
          />
        </div>

        {hasActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="col-span-2 h-8 gap-1 text-xs text-muted-foreground sm:col-span-1"
          >
            <IconX className="size-3" />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
