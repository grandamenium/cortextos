'use client';

import { useState, useMemo } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { PriorityBadge, StatusBadge, OrgBadge, TimeAgo } from '@/components/shared';
import { IconArrowsSort, IconSortAscending, IconSortDescending } from '@tabler/icons-react';
import type { Task } from '@/lib/types';

type SortField = 'title' | 'status' | 'priority' | 'assignee' | 'org' | 'created_at';
type SortDir = 'asc' | 'desc';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = { blocked: 0, in_progress: 1, pending: 2, verifying: 2, completed: 3 };

interface TaskListTableProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

export function TaskListTable({ tasks, onTaskClick }: TaskListTableProps) {
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const copy = [...tasks];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'status':
          cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          break;
        case 'priority':
          cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
          break;
        case 'assignee':
          cmp = (a.assignee ?? '').localeCompare(b.assignee ?? '');
          break;
        case 'org':
          cmp = a.org.localeCompare(b.org);
          break;
        case 'created_at':
          cmp = a.created_at.localeCompare(b.created_at);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [tasks, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field)
      return <IconArrowsSort className="size-3.5 text-muted-foreground/50" />;
    return sortDir === 'asc' ? (
      <IconSortAscending className="size-3.5" />
    ) : (
      <IconSortDescending className="size-3.5" />
    );
  }

  const columns: { field: SortField; label: string }[] = [
    { field: 'title', label: 'Title' },
    { field: 'status', label: 'Status' },
    { field: 'priority', label: 'Priority' },
    { field: 'assignee', label: 'Assignee' },
    { field: 'org', label: 'Org' },
    { field: 'created_at', label: 'Created' },
  ];

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead
              key={col.field}
              className="cursor-pointer select-none"
              onClick={() => toggleSort(col.field)}
            >
              <span className="inline-flex items-center gap-1">
                {col.label}
                <SortIcon field={col.field} />
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
              No tasks found
            </TableCell>
          </TableRow>
        ) : (
          sorted.map((task) => (
            <TableRow
              key={task.id}
              className="cursor-pointer"
              onClick={() => onTaskClick(task)}
            >
              <TableCell className="max-w-[300px] truncate font-medium">
                {task.title}
              </TableCell>
              <TableCell>
                <StatusBadge status={task.status} />
              </TableCell>
              <TableCell>
                <PriorityBadge priority={task.priority} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {task.assignee ?? '-'}
              </TableCell>
              <TableCell>
                <OrgBadge org={task.org} />
              </TableCell>
              <TableCell>
                <TimeAgo date={task.created_at} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
