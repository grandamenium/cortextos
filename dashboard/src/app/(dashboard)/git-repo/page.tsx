'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BranchPicker } from '@/components/git-repo/branch-picker';
import { StatusCard } from '@/components/git-repo/status-card';
import { CommitList } from '@/components/git-repo/commit-list';
import { DiffViewer } from '@/components/git-repo/diff-viewer';
import type {
  GitBranches,
  GitStatus,
  CommitSummary,
} from '@/components/git-repo/types';

export default function GitRepoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const branchParam = searchParams.get('branch');
  const shaParam = searchParams.get('sha');

  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(true);

  const branch = branchParam ?? branches?.current ?? '';

  function setSearch(next: { branch?: string | null; sha?: string | null }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.branch === null) params.delete('branch');
    else if (next.branch !== undefined) params.set('branch', next.branch);
    if (next.sha === null) params.delete('sha');
    else if (next.sha !== undefined) params.set('sha', next.sha);
    const qs = params.toString();
    router.replace(qs ? `/git-repo?${qs}` : '/git-repo', { scroll: false });
  }

  useEffect(() => {
    fetch('/api/git/branches')
      .then((res) => res.json())
      .then((data: GitBranches) => setBranches(data))
      .catch(() => setBranches({ branches: [], current: '' }));
  }, []);

  const loadStatusAndCommits = useCallback(async (b: string) => {
    if (!b) return;
    setLoadingCommits(true);
    try {
      const [statusRes, commitsRes] = await Promise.all([
        fetch(`/api/git/status?branch=${encodeURIComponent(b)}`),
        fetch(`/api/git/commits?branch=${encodeURIComponent(b)}`),
      ]);
      const statusData: GitStatus = statusRes.ok
        ? await statusRes.json()
        : { branch: b, upstream: 'upstream/main', upstreamRemoteUrl: null, ahead: 0, behind: 0, lastFetchedAt: null };
      const commitsData: CommitSummary[] = commitsRes.ok ? await commitsRes.json() : [];
      setStatus(statusData);
      setCommits(commitsData);
    } finally {
      setLoadingCommits(false);
    }
  }, []);

  useEffect(() => {
    if (branch) loadStatusAndCommits(branch);
  }, [branch, loadStatusAndCommits]);

  function handleSelectBranch(next: string) {
    setSearch({ branch: next, sha: null });
  }

  function handleSelectSha(sha: string) {
    setSearch({ sha });
  }

  function handleClearSha() {
    setSearch({ sha: null });
  }

  function handleFetched() {
    if (branch) loadStatusAndCommits(branch);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Git Repo</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Compare the current branch against{' '}
          <code className="text-xs font-mono">upstream/main</code> and inspect each commit before
          opening a PR.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {branches ? (
          <BranchPicker
            branches={branches.branches}
            current={branches.current}
            selected={branch}
            onSelect={handleSelectBranch}
          />
        ) : (
          <div className="h-8 w-[220px] rounded-md bg-muted/40 animate-pulse" />
        )}
      </div>

      <StatusCard status={status} commits={commits} onFetched={handleFetched} />

      <div className="grid grid-cols-1 lg:grid-cols-[400px_minmax(0,1fr)] gap-4">
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70 px-1">
            Commits ahead ({commits.length})
          </h2>
          <CommitList
            commits={commits}
            loading={loadingCommits}
            selectedSha={shaParam}
            onSelect={handleSelectSha}
          />
        </div>

        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70 px-1">
            Diff
          </h2>
          <DiffViewer branch={branch} sha={shaParam} onClear={handleClearSha} />
        </div>
      </div>
    </div>
  );
}
