'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import {
  IconGitBranch,
  IconRefresh,
  IconCheck,
  IconArrowDown,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';

interface CommitEntry {
  sha: string;
  message: string;
  type: 'fix' | 'feat' | 'chore' | 'docs' | 'other';
}

interface ChangelogData {
  pending: CommitEntry[];
  pendingCount: number;
  applied: CommitEntry[];
  lastChecked: string;
  currentSha: string;
  error?: string;
}

const typeBadgeStyles: Record<CommitEntry['type'], string> = {
  fix: 'bg-green-500/15 text-green-600 dark:text-green-400',
  feat: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  chore: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400',
  docs: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400',
  other: 'bg-zinc-500/10 text-zinc-400',
};

function CommitRow({ commit }: { commit: CommitEntry }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors">
      <span
        className={cn(
          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none',
          typeBadgeStyles[commit.type],
        )}
      >
        {commit.type}
      </span>
      <code className="shrink-0 text-xs font-mono text-muted-foreground">
        {commit.sha}
      </code>
      <span className="truncate text-sm">{commit.message}</span>
    </div>
  );
}

export function ChangelogView() {
  const [data, setData] = useState<ChangelogData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAllApplied, setShowAllApplied] = useState(false);

  async function fetchData() {
    setLoading(true);
    try {
      const res = await fetch('/api/changelog');
      const json = await res.json();
      setData(json);
    } catch {
      setData({
        pending: [],
        pendingCount: 0,
        applied: [],
        lastChecked: new Date().toISOString(),
        currentSha: '',
        error: 'Failed to fetch changelog',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
  }, []);

  const appliedVisible = showAllApplied
    ? (data?.applied ?? [])
    : (data?.applied ?? []).slice(0, 15);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <IconGitBranch size={22} className="text-muted-foreground" />
            Framework Updates
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data?.currentSha && (
              <span>
                HEAD{' '}
                <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
                  {data.currentSha}
                </code>
              </span>
            )}
            {data?.lastChecked && (
              <span className="ml-3">
                Last checked{' '}
                {new Date(data.lastChecked).toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
        >
          <IconRefresh size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {data?.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {data.error}
        </div>
      )}

      {/* Pending Updates */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <IconArrowDown size={16} />
            Pending Updates
            {(data?.pendingCount ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-600 dark:text-orange-400">
                {data?.pendingCount}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : data?.pending.length ? (
            <div className="space-y-0.5">
              {data.pending.map((c) => (
                <CommitRow key={c.sha} commit={c} />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconCheck size={16} className="text-green-500" />
              Up to date with upstream
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recently Applied */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <IconCheck size={16} />
            Recently Applied
            <span className="text-xs font-normal text-muted-foreground">
              last 30 days
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : appliedVisible.length ? (
            <div className="space-y-0.5">
              {appliedVisible.map((c) => (
                <CommitRow key={c.sha} commit={c} />
              ))}
              {(data?.applied.length ?? 0) > 15 && !showAllApplied && (
                <button
                  onClick={() => setShowAllApplied(true)}
                  className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Show all {data?.applied.length} commits
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No upstream commits in the last 30 days
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
