'use client';

import { useEffect, useState } from 'react';
import { IconLoader2, IconArrowLeft } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { FileDiff } from './file-diff';
import type { CommitDetail } from './types';

interface DiffViewerProps {
  branch: string;
  sha: string | null;
  onClear: () => void;
}

export function DiffViewer({ branch, sha, onClear }: DiffViewerProps) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sha) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/git/commits/${sha}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as CommitDetail;
      })
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sha]);

  if (!sha) {
    return (
      <div className="rounded-xl border border-dashed bg-card/30 min-h-[400px] flex items-center justify-center text-sm text-muted-foreground">
        Select a commit to view its diff.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button variant="ghost" size="xs" onClick={onClear} className="gap-1">
          <IconArrowLeft size={12} />
          Back
        </Button>
        <span className="font-mono">{branch}</span>
        <span className="text-muted-foreground/40">›</span>
        <span className="font-mono text-foreground">{sha.slice(0, 7)}</span>
      </div>

      {loading && (
        <div className="rounded-xl border bg-card p-6 flex items-center gap-2 text-sm text-muted-foreground">
          <IconLoader2 size={14} className="animate-spin" />
          Loading diff...
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {detail && !loading && (
        <>
          <div className="rounded-xl border bg-card p-4 space-y-1">
            <h2 className="text-lg font-semibold leading-snug">{detail.subject}</h2>
            {detail.body && (
              <pre className="text-xs whitespace-pre-wrap text-muted-foreground font-sans mt-2">
                {detail.body}
              </pre>
            )}
            <div className="mt-2 text-xs text-muted-foreground">
              <span className="font-mono">{detail.sha.slice(0, 7)}</span>
              <span className="mx-1.5 text-muted-foreground/40">·</span>
              <span>{detail.author}</span>
              <span className="mx-1.5 text-muted-foreground/40">·</span>
              <span>{new Date(detail.date).toLocaleString()}</span>
              <span className="mx-1.5 text-muted-foreground/40">·</span>
              <span className="tabular-nums">
                {detail.files.length} {detail.files.length === 1 ? 'file' : 'files'}
              </span>
            </div>
          </div>

          <div className="space-y-3">
            {detail.files.map((f) => (
              <FileDiff key={f.path} file={f} defaultExpanded={false} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
