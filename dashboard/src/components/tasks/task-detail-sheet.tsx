'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  PriorityBadge,
  StatusBadge,
  OrgBadge,
  TimeAgo,
} from '@/components/shared';
import { IconPencil, IconFile, IconPhoto, IconFileText, IconCode } from '@tabler/icons-react';
import { DeliverablePreview } from '@/components/tasks/deliverable-preview';
import type { Task, TaskOutput, TaskStatus, TaskPriority } from '@/lib/types';

export interface TaskDetailSheetProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (taskId: string, status: TaskStatus, note?: string) => void;
  onDelete?: (taskId: string) => void;
  onEdit?: (taskId: string) => void;
}

const STATUS_TRANSITIONS: Record<TaskStatus, { label: string; status: TaskStatus; variant: 'default' | 'outline' | 'destructive' | 'secondary' }[]> = {
  pending: [
    { label: 'Start', status: 'in_progress', variant: 'default' },
    { label: 'Block', status: 'blocked', variant: 'destructive' },
  ],
  in_progress: [
    { label: 'Complete', status: 'completed', variant: 'default' },
    { label: 'Block', status: 'blocked', variant: 'destructive' },
    { label: 'Back to Pending', status: 'pending', variant: 'outline' },
  ],
  blocked: [
    { label: 'Unblock', status: 'in_progress', variant: 'default' },
    { label: 'Back to Pending', status: 'pending', variant: 'outline' },
  ],
  completed: [
    { label: 'Reopen', status: 'pending', variant: 'outline' },
  ],
};

function getOutputIcon(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return IconPhoto;
  if (ext === 'md') return IconFileText;
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css', 'sh', 'py'].includes(ext)) return IconCode;
  return IconFile;
}

export function TaskDetailSheet({
  task,
  open,
  onOpenChange,
  onStatusChange,
  onDelete,
  onEdit,
}: TaskDetailSheetProps) {
  const [note, setNote] = useState('');
  const [updating, setUpdating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPriority, setEditPriority] = useState<string>('normal');
  const [editAssignee, setEditAssignee] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deliverables state
  const [outputs, setOutputs] = useState<TaskOutput[]>([]);
  const [deliverablesEnabled, setDeliverablesEnabled] = useState(false);
  const [previewOutput, setPreviewOutput] = useState<TaskOutput | null>(null);

  // Fetch outputs and deliverables setting when task detail opens
  const fetchTaskOutputs = useCallback(async (taskId: string, org: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (res.ok) {
        const data = await res.json();
        setOutputs(Array.isArray(data.outputs) ? data.outputs : []);
      }
    } catch { /* non-fatal */ }

    try {
      const res = await fetch(`/api/org/config?org=${encodeURIComponent(org)}`);
      if (res.ok) {
        const data = await res.json();
        setDeliverablesEnabled(!!data.config?.require_deliverables);
      }
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (open && task) {
      fetchTaskOutputs(task.id, task.org);
    } else {
      setOutputs([]);
      setPreviewOutput(null);
    }
  }, [open, task?.id, task?.org, fetchTaskOutputs, task]);

  if (!task) return null;

  const transitions = STATUS_TRANSITIONS[task.status] ?? [];

  function startEditing() {
    setEditTitle(task!.title);
    setEditDesc(task!.description || '');
    setEditPriority(task!.priority);
    setEditAssignee(task!.assignee || '');
    setEditing(true);
    setError(null);
  }

  async function saveEdit() {
    if (!task || !editTitle.trim()) {
      setError('Title is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDesc.trim(),
          priority: editPriority,
          assignee: editAssignee.trim() || undefined,
        }),
      });
      if (res.ok) {
        setEditing(false);
        onEdit?.(task.id);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to save');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(newStatus: TaskStatus) {
    if (!task) return;
    setUpdating(true);
    setError(null);
    try {
      await onStatusChange(task.id, newStatus, note.trim() || undefined);
      setNote('');
    } catch {
      setError('Failed to update status');
    } finally {
      setUpdating(false);
    }
  }

  return (
    <>
    <Sheet open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setEditing(false); setConfirmDelete(false); setError(null); setPreviewOutput(null); } }}>
      <SheetContent side="right" className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          {editing ? (
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="text-lg font-semibold"
              placeholder="Task title..."
            />
          ) : (
            <div className="flex items-start gap-2 pr-8">
              <SheetTitle className="flex-1">{task.title}</SheetTitle>
              <Button variant="ghost" size="icon-sm" onClick={startEditing} title="Edit task" className="shrink-0">
                <IconPencil size={14} />
              </Button>
            </div>
          )}
          <SheetDescription>Task ID: {task.id}</SheetDescription>
        </SheetHeader>

        {/* Error banner */}
        {error && (
          <div className="mx-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-4 px-4">
          {/* Status + Priority + Org row */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={task.status} />
            {editing ? (
              <Select value={editPriority} onValueChange={(v) => { if (v) setEditPriority(v); }}>
                <SelectTrigger className="w-28 h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <PriorityBadge priority={task.priority} />
            )}
            <OrgBadge org={task.org} />
            {task.needs_approval && (
              <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                Needs Approval
              </span>
            )}
          </div>

          <Separator />

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
            <div>
              <span className="text-muted-foreground">Assignee</span>
              {editing ? (
                <Input
                  value={editAssignee}
                  onChange={(e) => setEditAssignee(e.target.value)}
                  placeholder="agent name or human"
                  className="mt-1 h-7 text-sm"
                />
              ) : (
                <p className="font-medium">{task.assignee ?? 'Unassigned'}</p>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">Project</span>
              <p className="font-medium">{task.project ?? '-'}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Created</span>
              <div><TimeAgo date={task.created_at} /></div>
            </div>
            {task.updated_at && (
              <div>
                <span className="text-muted-foreground">Updated</span>
                <div><TimeAgo date={task.updated_at} /></div>
              </div>
            )}
            {task.completed_at && (
              <div>
                <span className="text-muted-foreground">Completed</span>
                <div><TimeAgo date={task.completed_at} /></div>
              </div>
            )}
          </div>

          {/* Description */}
          <Separator />
          {editing ? (
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">Description</Label>
              <Textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={4}
                placeholder="Task description..."
              />
            </div>
          ) : task.description ? (
            <div>
              <p className="text-sm text-muted-foreground mb-1">Description</p>
              <p className="text-sm whitespace-pre-wrap">{task.description}</p>
            </div>
          ) : null}

          {/* Edit save/cancel */}
          {editing && (
            <div className="flex gap-2">
              <Button size="sm" onClick={saveEdit} disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          )}

          {/* Existing notes */}
          {!editing && task.notes && (
            <>
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground mb-1">Notes</p>
                <p className="text-sm whitespace-pre-wrap">{task.notes}</p>
              </div>
            </>
          )}

          {/* Deliverables section — visible when require_deliverables is enabled */}
          {!editing && deliverablesEnabled && (
            <>
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground mb-2">
                  Deliverables{outputs.length > 0 && ` (${outputs.length})`}
                </p>
                {outputs.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No deliverables attached.</p>
                ) : (
                  <div className="space-y-1">
                    {outputs.map((output, idx) => {
                      const Icon = getOutputIcon(output.value);
                      const filename = output.value.split('/').pop() ?? output.value;
                      return (
                        <button
                          key={idx}
                          onClick={() => setPreviewOutput(output)}
                          className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50 transition-colors"
                          onMouseEnter={(e) => {
                            e.currentTarget.style.cursor = 'pointer';
                            const label = e.currentTarget.querySelector('[data-deliverable-label]') as HTMLElement | null;
                            if (label) label.style.textDecoration = 'underline';
                          }}
                          onMouseLeave={(e) => {
                            const label = e.currentTarget.querySelector('[data-deliverable-label]') as HTMLElement | null;
                            if (label) label.style.textDecoration = 'none';
                          }}
                          style={{ cursor: 'pointer' } as React.CSSProperties}
                        >
                          <Icon size={16} className="shrink-0 text-primary" />
                          <div className="min-w-0 flex-1">
                            <p data-deliverable-label className="font-medium text-sm text-primary break-words">{output.label ?? filename}</p>
                            <p className="text-xs text-muted-foreground break-all">{filename}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          {!editing && (
            <>
              <Separator />
              {/* Note input + status buttons */}
              <div className="space-y-3">
                <div className="grid gap-2">
                  <Label htmlFor="task-note">Add note (optional)</Label>
                  <Textarea
                    id="task-note"
                    placeholder="Note for status change..."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={2000}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {!editing && (
          <SheetFooter>
            <div className="flex flex-wrap items-center gap-2 w-full">
              {transitions.map((t) => (
                <Button
                  key={t.status}
                  variant={t.variant}
                  size="sm"
                  disabled={updating || deleting}
                  onClick={() => handleStatusChange(t.status)}
                >
                  {t.label}
                </Button>
              ))}
              <div className="ml-auto">
                {confirmDelete ? (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-destructive mr-1">Delete?</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={deleting}
                      onClick={async () => {
                        if (!task || !onDelete) return;
                        setDeleting(true);
                        await onDelete(task.id);
                        setDeleting(false);
                        setConfirmDelete(false);
                      }}
                    >
                      {deleting ? 'Deleting...' : 'Yes'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                    >
                      No
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>

    {/* Deliverable preview — fixed-position sibling outside the Sheet.
        Three responsive breakpoints match the reference layout. */}
    {open && previewOutput && (
      <>
        {/* Desktop: full height panel, left edge to sheet edge */}
        <div className="hidden lg:block fixed inset-y-0 left-0 right-96 z-[55] animate-in slide-in-from-left-4 duration-200">
          <DeliverablePreview output={previewOutput} onClose={() => setPreviewOutput(null)} />
        </div>

        {/* Tablet: centered modal with backdrop */}
        <div className="hidden md:block lg:hidden fixed inset-0 z-[60]">
          <div className="fixed inset-0 bg-black/40" onClick={() => setPreviewOutput(null)} />
          <div className="fixed inset-4 z-[61] bg-background rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <DeliverablePreview output={previewOutput} onClose={() => setPreviewOutput(null)} />
          </div>
        </div>

        {/* Mobile: full takeover */}
        <div className="block md:hidden fixed inset-0 z-[60] bg-background animate-in slide-in-from-bottom duration-200">
          <DeliverablePreview output={previewOutput} onClose={() => setPreviewOutput(null)} />
        </div>
      </>
    )}
    </>
  );
}
