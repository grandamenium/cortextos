'use client';

/**
 * DeleteCronDialog — confirmation dialog for cron deletion.
 *
 * Uses the existing shadcn/ui Dialog primitive.
 */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IconTrash, IconRefresh } from '@tabler/icons-react';

export interface DeleteCronDialogProps {
  open: boolean;
  agent: string;
  cronName: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export default function DeleteCronDialog({
  open,
  agent,
  cronName,
  onConfirm,
  onCancel,
}: DeleteCronDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete cron.');
      setDeleting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={open => {
        if (!open && !deleting) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconTrash size={18} className="text-destructive" />
            Delete cron
          </DialogTitle>
          <DialogDescription>
            This will permanently remove{' '}
            <span className="font-semibold text-foreground">{cronName}</span> from agent{' '}
            <span className="font-semibold text-foreground">{agent}</span>.{' '}
            The scheduler will stop firing this cron immediately. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={deleting}
            className="min-w-[100px]"
          >
            {deleting ? (
              <>
                <IconRefresh size={14} className="mr-1.5 animate-spin" />
                Deleting...
              </>
            ) : (
              <>
                <IconTrash size={14} className="mr-1.5" />
                Delete
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
