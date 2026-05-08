'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const shortcuts = [
  ['⌘K', 'Command palette'],
  ['⌘,', 'Settings'],
  ['?', 'Keyboard shortcuts'],
  ['/', 'Chat slash commands'],
  ['Enter', 'Send chat message'],
  ['Shift Enter', 'New line'],
];

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (event.key === '?' && !editing) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Keyboard Shortcuts</DialogTitle></DialogHeader>
        <div className="grid gap-2">
          {shortcuts.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>{label}</span>
              <kbd className="rounded border bg-muted px-2 py-1 font-mono text-xs">{key}</kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
