'use client';

import { useState, useMemo, useRef } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { PriorityBadge, StatusBadge, OrgBadge, TimeAgo } from '@/components/shared';
import { IconArrowsSort, IconSortAscending, IconSortDescending } from '@tabler/icons-react';
import type { Task, TaskStatus } from '@/lib/types';

type SortField = 'title' | 'status' | 'priority' | 'assignee' | 'org' | 'project' | 'created_at' | 'due_date';
type SortDir = 'asc' | 'desc';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = { blocked: 0, in_progress: 1, pending: 2, completed: 3 };

interface TaskListTableProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => void;
  onFieldUpdate?: (taskId: string, field: string, value: string) => void;
}

function StatusCell({ task, onStatusChange }: { task: Task; onStatusChange?: (id: string, s: TaskStatus) => void }) {
  const [open, setOpen] = useState(false);
  if (!onStatusChange) return <StatusBadge status={task.status} />;
  return (
    <Select
      value={task.status}
      onValueChange={(val) => { if (val) onStatusChange(task.id, val as TaskStatus); setOpen(false); }}
      open={open}
      onOpenChange={setOpen}
    >
      <SelectTrigger
        className="h-auto p-0 border-0 bg-transparent shadow-none focus:ring-0 hover:opacity-70"
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue><StatusBadge status={task.status} /></SelectValue>
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        <SelectItem value="pending">Pending</SelectItem>
        <SelectItem value="in_progress">In Progress</SelectItem>
        <SelectItem value="blocked">Blocked</SelectItem>
        <SelectItem value="completed">Completed</SelectItem>
      </SelectContent>
    </Select>
  );
}

function PriorityCell({ task, onUpdate }: { task: Task; onUpdate?: (id: string, f: string, v: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!onUpdate) return <PriorityBadge priority={task.priority} />;
  return (
    <Select
      value={task.priority}
      onValueChange={(val) => { if (val) onUpdate(task.id, 'priority', val); setOpen(false); }}
      open={open}
      onOpenChange={setOpen}
    >
      <SelectTrigger
        className="h-auto p-0 border-0 bg-transparent shadow-none focus:ring-0 hover:opacity-70"
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue><PriorityBadge priority={task.priority} /></SelectValue>
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        <SelectItem value="urgent">Urgent</SelectItem>
        <SelectItem value="high">High</SelectItem>
        <SelectItem value="normal">Normal</SelectItem>
        <SelectItem value="low">Low</SelectItem>
      </SelectContent>
    </Select>
  );
}

function TextCell({ value, placeholder, onSave }: { value?: string | null; placeholder: string; onSave?: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setDraft(value || '');
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function save() {
    setEditing(false);
    const current = value ?? '';
    if (draft !== current && onSave) onSave(draft.trim());
  }

  if (!onSave) return <span className="text-muted-foreground">{value || '-'}</span>;

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        onClick={(e) => e.stopPropagation()}
        className="h-6 py-0 px-1 text-xs min-w-[80px] max-w-[150px]"
      />
    );
  }

  return (
    <span
      className="text-muted-foreground cursor-text hover:text-foreground hover:underline decoration-dotted"
      onClick={startEdit}
      title="Click to edit"
    >
      {value || <span className="italic opacity-40">{placeholder}</span>}
    </span>
  );
}

export function TaskListTable({ tasks, onTaskClick, onStatusChange, onFieldUpdate }: TaskListTableProps) {
  const [sortField, setSortField] = useState<SortField>('project');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const sorted = useMemo(() => {
    const copy = [...tasks];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'title':      cmp = a.title.localeCompare(b.title); break;
        case 'status':     cmp = (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4); break;
        case 'priority':   cmp = (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4); break;
        case 'assignee':   cmp = (a.assignee ?? '').localeCompare(b.assignee ?? ''); break;
        case 'org':        cmp = a.org.localeCompare(b.org); break;
        case 'project':    cmp = (a.project ?? '').localeCompare(b.project ?? ''); break;
        case 'created_at': cmp = a.created_at.localeCompare(b.created_at); break;
        case 'due_date':   cmp = (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'); break;
      }
      if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp;
      // Secondary sort: project field always groups by org (LLC), then status priority
      if (sortField !== 'org') {
        const orgCmp = a.org.localeCompare(b.org);
        if (orgCmp !== 0) return orgCmp;
      }
      if (sortField !== 'project') {
        const projCmp = (a.project ?? '').localeCompare(b.project ?? '');
        if (projCmp !== 0) return projCmp;
      }
      return (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4);
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
    if (sortField !== field) return <IconArrowsSort className="size-3.5 text-muted-foreground/50" />;
    return sortDir === 'asc' ? <IconSortAscending className="size-3.5" /> : <IconSortDescending className="size-3.5" />;
  }

  const columns: { field: SortField; label: string; hideBelow?: string }[] = [
    { field: 'title',      label: 'Title' },
    { field: 'status',     label: 'Status' },
    { field: 'priority',   label: 'Priority',  hideBelow: 'sm' },
    { field: 'assignee',   label: 'Assignee',  hideBelow: 'md' },
    { field: 'project',    label: 'Project',   hideBelow: 'md' },
    { field: 'org',        label: 'Company',   hideBelow: 'lg' },
    { field: 'due_date',   label: 'Due',       hideBelow: 'lg' },
    { field: 'created_at', label: 'Created',   hideBelow: 'xl' },
  ];

  const hideClass: Record<string, string> = {
    sm: 'hidden sm:table-cell',
    md: 'hidden md:table-cell',
    lg: 'hidden lg:table-cell',
  };

  return (
    <div className="overflow-x-auto">
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead
              key={col.field}
              className={`cursor-pointer select-none${col.hideBelow ? ` ${hideClass[col.hideBelow]}` : ''}`}
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
            <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
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
              <TableCell className="max-w-[200px] sm:max-w-[260px] truncate font-medium">
                {task.title}
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <StatusCell task={task} onStatusChange={onStatusChange} />
              </TableCell>
              <TableCell className="hidden sm:table-cell" onClick={(e) => e.stopPropagation()}>
                <PriorityCell task={task} onUpdate={onFieldUpdate} />
              </TableCell>
              <TableCell className="hidden md:table-cell" onClick={(e) => e.stopPropagation()}>
                <TextCell
                  value={task.assignee}
                  placeholder="Unassigned"
                  onSave={onFieldUpdate ? (v) => onFieldUpdate(task.id, 'assignee', v) : undefined}
                />
              </TableCell>
              <TableCell className="hidden md:table-cell" onClick={(e) => e.stopPropagation()}>
                <TextCell
                  value={task.project}
                  placeholder="No project"
                  onSave={onFieldUpdate ? (v) => onFieldUpdate(task.id, 'project', v) : undefined}
                />
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <OrgBadge org={task.org} />
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                {task.due_date ? (
                  (() => {
                    const overdue = new Date(task.due_date).getTime() < Date.now()
                      && task.status !== 'completed' && task.status !== 'cancelled';
                    return (
                      <span className={`text-xs font-medium ${overdue ? 'text-red-600 font-semibold' : 'text-muted-foreground'}`}>
                        {overdue ? '⚠ ' : ''}{task.due_date}
                      </span>
                    );
                  })()
                ) : (
                  <span className="text-xs text-muted-foreground/40 italic">—</span>
                )}
              </TableCell>
              <TableCell className="hidden xl:table-cell">
                <TimeAgo date={task.created_at} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
    </div>
  );
}
