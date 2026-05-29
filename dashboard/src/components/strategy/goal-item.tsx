'use client';

import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  IconGripVertical,
  IconPencil,
  IconTrash,
  IconCheck,
  IconX,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Goal } from '@/lib/types';

interface GoalItemProps {
  goal: Goal;
  onUpdate: (id: string, title: string, progress: number) => void;
  onDelete: (id: string) => void;
}

export function GoalItem({ goal, onUpdate, onDelete }: GoalItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(goal.title);
  const [editProgress, setEditProgress] = useState(goal.progress);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: goal.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleSave = () => {
    const trimmed = editTitle.trim();
    if (trimmed.length === 0) return;
    onUpdate(goal.id, trimmed, editProgress);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditTitle(goal.title);
    setEditProgress(goal.progress);
    setIsEditing(false);
  };

  const handleStartEdit = () => {
    setEditTitle(goal.title);
    setEditProgress(goal.progress);
    setIsEditing(true);
    setConfirmDelete(false);
  };

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete(goal.id);
  };

  if (isEditing) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="rounded-lg border border-amber-500/30 bg-card p-4 space-y-3"
      >
        <Input
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          placeholder="Goal title"
          className="text-sm"
          maxLength={200}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') handleCancel();
          }}
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground w-8 tabular-nums">
            {editProgress}%
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={editProgress}
            onChange={(e) => setEditProgress(Number(e.target.value))}
            className="flex-1 h-1.5 accent-amber-500 cursor-pointer"
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave} variant="default">
            <IconCheck className="h-3.5 w-3.5 mr-1" />
            Save
          </Button>
          <Button size="sm" onClick={handleCancel} variant="outline">
            <IconX className="h-3.5 w-3.5 mr-1" />
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-3 rounded-lg border border-foreground/5 bg-card p-3 transition-colors hover:border-foreground/10 ${
        isDragging ? 'opacity-50 shadow-lg' : ''
      }`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <IconGripVertical className="h-4 w-4" />
      </button>

      {/* Goal content */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium truncate">{goal.title}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {goal.progress}%
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-amber-500 transition-[width] duration-300"
            style={{ width: `${goal.progress}%` }}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleStartEdit}
          className="h-7 w-7 p-0"
        >
          <IconPencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDelete}
          className={`h-7 w-7 p-0 ${confirmDelete ? 'text-red-400 hover:text-red-300' : ''}`}
        >
          <IconTrash className="h-3.5 w-3.5" />
        </Button>
        {confirmDelete && (
          <span className="text-xs text-red-400 animate-pulse">Click again</span>
        )}
      </div>
    </div>
  );
}
