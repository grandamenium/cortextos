'use client';

import { useState } from 'react';
import {
  IconArrowUp,
  IconArrowDown,
  IconRefresh,
  IconExternalLink,
  IconCircleCheck,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { GitStatus, CommitSummary } from './types';

interface StatusCardProps {
  status: GitStatus | null;
  commits: CommitSummary[];
  onFetched: () => void;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.round((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function githubCompareUrl(remoteUrl: string | null, branch: string): string | null {
  if (!remoteUrl) return null;
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) return null;
  const [, owner, repo] = m;
  return `https://github.com/${owner}/${repo}/compare/main...${encodeURIComponent(branch)}`;
}

export function StatusCard({ status, commits, onFetched }: StatusCardProps) {
  const [fetching, setFetching] = useState(false);

  async function handleFetch() {
    setFetching(true);
    try {
      await fetch('/api/git/fetch', { method: 'POST' });
    } catch {
      // silent
    }
    setFetching(false);
    onFetched();
  }

  if (!status) {
    return <div className="h-32 rounded-xl border bg-card/50 animate-pulse" />;
  }

  const totalFiles = commits.reduce((acc, c) => acc + c.filesChanged, 0);
  const totalInsertions = commits.reduce((acc, c) => acc + c.insertions, 0);
  const totalDeletions = commits.reduce((acc, c) => acc + c.deletions, 0);
  const ready = status.ahead > 0 && status.behind === 0;
  const compareUrl = githubCompareUrl(status.upstreamRemoteUrl, status.branch);

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <AheadBadge ahead={status.ahead} />
          <BehindBadge behind={status.behind} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Last fetched <span className="text-foreground/80">{relativeTime(status.lastFetchedAt)}</span>
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            <span className="font-mono">{status.upstream}</span>
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleFetch}
            disabled={fetching}
            className="gap-1.5"
          >
            <IconRefresh size={14} className={cn(fetching && 'animate-spin')} />
            {fetching ? 'Fetching...' : 'Fetch upstream'}
          </Button>
        </div>
      </div>

      <div className="border-t pt-3 flex flex-wrap items-center gap-3 text-sm">
        {ready ? (
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <IconCircleCheck size={16} />
            <span>
              Looks ready —{' '}
              <span className="tabular-nums font-medium">{status.ahead}</span>{' '}
              {status.ahead === 1 ? 'commit' : 'commits'},{' '}
              <span className="tabular-nums font-medium">{totalFiles}</span>{' '}
              {totalFiles === 1 ? 'file' : 'files'} changed
              {' '}
              (<span className="tabular-nums text-emerald-600/90 dark:text-emerald-400/90">+{totalInsertions}</span>
              {' '}
              <span className="tabular-nums text-red-600/90 dark:text-red-400/90">−{totalDeletions}</span>)
            </span>
          </div>
        ) : status.behind > 0 ? (
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <IconAlertTriangle size={16} />
            <span>
              Branch is <span className="tabular-nums font-medium">{status.behind}</span>{' '}
              {status.behind === 1 ? 'commit' : 'commits'} behind{' '}
              <span className="font-mono">{status.upstream}</span> — rebase or merge before opening a PR
            </span>
          </div>
        ) : (
          <div className="text-muted-foreground">No commits ahead of {status.upstream}</div>
        )}

        {compareUrl && (
          <a
            href={compareUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Open compare on GitHub
            <IconExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

function AheadBadge({ ahead }: { ahead: number }) {
  const active = ahead > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums transition-colors',
        active
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'border-border bg-muted/30 text-muted-foreground',
      )}
    >
      <IconArrowUp size={12} />
      {ahead} ahead
    </span>
  );
}

function BehindBadge({ behind }: { behind: number }) {
  const active = behind > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums transition-colors',
        active
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'border-border bg-muted/30 text-muted-foreground',
      )}
    >
      <IconArrowDown size={12} />
      {behind} behind
    </span>
  );
}
