'use client';

import { IconChevronRight } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { CommitSummary } from './types';

interface CommitListProps {
  commits: CommitSummary[];
  loading: boolean;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.round((now - then) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function CommitList({ commits, loading, selectedSha, onSelect }: CommitListProps) {
  if (loading) {
    return (
      <div className="rounded-xl border bg-card overflow-hidden">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[68px] border-b last:border-b-0 p-3">
            <div className="h-4 w-3/4 bg-muted/40 rounded animate-pulse" />
            <div className="h-3 w-1/2 bg-muted/30 rounded animate-pulse mt-2" />
          </div>
        ))}
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        No commits ahead of upstream/main on this branch.
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {commits.map((c, idx) => {
        const selected = c.sha === selectedSha;
        return (
          <button
            key={c.sha}
            onClick={() => onSelect(c.sha)}
            className={cn(
              'group w-full text-left flex items-start gap-3 p-3 border-b last:border-b-0 transition-colors',
              'hover:bg-muted/40 focus:outline-none focus:bg-muted/40',
              selected && 'bg-primary/10 hover:bg-primary/10',
            )}
            aria-current={selected ? 'true' : undefined}
          >
            <span
              className={cn(
                'mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-mono tabular-nums shrink-0',
                selected
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
              )}
              aria-hidden
            >
              {idx + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate leading-tight">{c.subject}</div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-mono">{c.shortSha}</span>
                <span className="text-muted-foreground/40">·</span>
                <span className="truncate max-w-[140px]">{c.author}</span>
                <span className="text-muted-foreground/40">·</span>
                <span>{relativeDate(c.date)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
                <span>
                  {c.filesChanged} {c.filesChanged === 1 ? 'file' : 'files'}
                </span>
                <span className="text-emerald-600/90 dark:text-emerald-400/90">+{c.insertions}</span>
                <span className="text-red-600/90 dark:text-red-400/90">−{c.deletions}</span>
              </div>
            </div>
            <IconChevronRight
              size={14}
              className={cn(
                'mt-1 shrink-0 transition-colors',
                selected ? 'text-primary' : 'text-muted-foreground/40 group-hover:text-muted-foreground',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
