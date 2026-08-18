'use client';

import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IconPhotoUp, IconTrash } from '@tabler/icons-react';

interface AvatarUploadProps {
  agent: string;
  hasAvatar: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new avatar version after upload, or null after removal. */
  onSaved: (version: number | null) => void;
}

/**
 * Upload dialog for an agent's character art. Kyle's flow: generate a
 * character image in ChatGPT, save it, drop it here.
 */
export function AvatarUpload({ agent, hasAvatar, open, onOpenChange, onSaved }: AvatarUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setError('');
    setDragOver(false);
  }

  function pick(f: File) {
    if (!f.type.startsWith('image/')) {
      setError('That is not an image file');
      return;
    }
    setError('');
    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(f));
  }

  async function save() {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/avatars/${agent}`, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Upload failed');
        return;
      }
      onSaved(data.version ?? Date.now());
      reset();
      onOpenChange(false);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/avatars/${agent}`, { method: 'DELETE' });
      if (!res.ok) {
        setError('Failed to remove');
        return;
      }
      onSaved(null);
      reset();
      onOpenChange(false);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Character art for {agent}</DialogTitle>
          <DialogDescription>
            Generate a character in ChatGPT or anywhere else, then drop the image here.
            Square images with a simple background look best.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pick(f);
          }}
        />

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) pick(f);
          }}
          className={`flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-sm text-muted-foreground transition-colors ${
            dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
          }`}
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="New avatar preview"
              className="h-32 w-32 rounded-full object-cover"
            />
          ) : (
            <>
              <IconPhotoUp size={28} />
              <span>Drop an image or click to browse</span>
            </>
          )}
        </button>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          {hasAvatar ? (
            <Button variant="ghost" size="sm" onClick={remove} disabled={busy} className="text-destructive">
              <IconTrash size={15} className="mr-1" />
              Remove art
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!file || busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
