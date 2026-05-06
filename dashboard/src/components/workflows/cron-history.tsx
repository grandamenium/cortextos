'use client';

/**
 * CronHistory — Full execution history viewer for a single cron.
 *
 * Features:
 *  - Shows up to 100 recent executions per page (configurable via HISTORY_LIMIT)
 *  - Columns: Timestamp (relative + absolute UTC tooltip), Status badge, Duration, Error
 *  - Filter pills: All / Success / Failure (refetches on change)
 *  - Pagination: "Older" / "Newer" buttons with "Showing X–Y of Z" label
 *  - Export: Download CSV / Download JSON (links to API route with format param)
 *  - Loading / empty / error states
 *
 * Props: { agent: string, cronName: string }
 */

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFilter,
  IconRefresh,
} from '@tabler/icons-react';
import { formatRelative } from '@/lib/cron-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | 'success' | 'failure';

interface CronExecutionEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

interface ExecutionPage {
  entries: CronExecutionEntry[];
  total: number;
  hasMore: boolean;
}

export interface CronHistoryProps {
  agent: string;
  cronName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeVariant(
  status: 'fired' | 'retried' | 'failed',
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'fired') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'retried') return 'secondary';
  return 'outline';
}

function statusLabel(status: 'fired' | 'retried' | 'failed'): string {
  if (status === 'fired') return 'success';
  if (status === 'failed') return 'failed';
  return 'retried';
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatAbsoluteUtc(isoTs: string): string {
  try {
    return new Date(isoTs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return isoTs;
  }
}

// ---------------------------------------------------------------------------
// useExecutionLog hook
// ---------------------------------------------------------------------------

/**
 * Custom hook that fetches paginated execution history for a cron.
 *
 * Exported so 4.4 (health dashboard) can reuse it for gap detection rendering.
 */
export function useExecutionLog(
  agent: string,
  cronName: string,
  limit: number,
  offset: number,
  statusFilter: StatusFilter,
) {
  const [page, setPage] = useState<ExecutionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/workflows/crons/${encodeURIComponent(agent)}/${encodeURIComponent(cronName)}/executions`
        + `?limit=${limit}&offset=${offset}&status=${statusFilter}`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data: ExecutionPage = await res.json();
      setPage(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history.');
    } finally {
      setLoading(false);
    }
  }, [agent, cronName, limit, offset, statusFilter]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  return { page, loading, error, refetch: fetchPage };
}

// ---------------------------------------------------------------------------
// CronHistory component
// ---------------------------------------------------------------------------

export default function CronHistory({ agent, cronName }: CronHistoryProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [offset, setOffset] = useState(0);
  const [expandedError, setExpandedError] = useState<number | null>(null);

  // Reset offset when filter changes
  const handleFilterChange = useCallback((f: StatusFilter) => {
    setStatusFilter(f);
    setOffset(0);
  }, []);

  const { page, loading, error, refetch } = useExecutionLog(
    agent,
    cronName,
    HISTORY_LIMIT,
    offset,
    statusFilter,
  );

  // Pagination helpers
  const entries = page?.entries ?? [];
  const total = page?.total ?? 0;
  const hasMore = page?.hasMore ?? false;

  // "Showing X–Y of Z"
  // entries are oldest-first within the page; offset is from the recent end
  // End index (1-based from oldest) = total - offset
  // Start index = total - offset - entries.length + 1
  const displayEnd = total - offset;
  const displayStart = Math.max(1, displayEnd - entries.length + 1);

  const canGoOlder = hasMore;
  const canGoNewer = offset > 0;

  const goOlder = () => setOffset(prev => prev + HISTORY_LIMIT);
  const goNewer = () => setOffset(prev => Math.max(0, prev - HISTORY_LIMIT));

  // Export URLs
  const baseExportUrl = `/api/workflows/crons/${encodeURIComponent(agent)}/${encodeURIComponent(cronName)}/executions`;
  const exportCsvUrl = `${baseExportUrl}?limit=0&offset=0&status=${statusFilter}&format=csv`;
  const exportJsonUrl = `${baseExportUrl}?limit=0&offset=0&status=${statusFilter}&format=json-download`;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Filter pills */}
        <div className="flex items-center gap-1.5">
          <IconFilter size={14} className="text-muted-foreground shrink-0" />
          {(['all', 'success', 'failure'] as StatusFilter[]).map(f => (
            <button
              key={f}
              onClick={() => handleFilterChange(f)}
              className={[
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                statusFilter === f
                  ? 'bg-foreground text-background'
                  : 'bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted',
              ].join(' ')}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {/* Export + Refresh */}
        <div className="flex items-center gap-2">
          <a
            href={exportCsvUrl}
            download
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <IconDownload size={12} />
            CSV
          </a>
          <a
            href={exportJsonUrl}
            download
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <IconDownload size={12} />
            JSON
          </a>
          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground"
            title="Refresh"
            disabled={loading}
          >
            <IconRefresh size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-md bg-muted/30" />
          ))}
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-3 text-sm text-destructive">
          Failed to load execution history: {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && entries.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {statusFilter === 'all'
            ? 'No executions recorded yet.'
            : `No ${statusFilter} executions found.`}
        </p>
      )}

      {/* Table */}
      {!loading && !error && entries.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="border-b">
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  When
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Status
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Duration
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Error
                </th>
              </tr>
            </thead>
            <tbody>
              {/* Display most-recent first by reversing */}
              {[...entries].reverse().map((entry, i) => {
                const globalIdx = offset * 0 + i; // stable key within page
                const isExpanded = expandedError === i;
                return (
                  <tr
                    key={`${entry.ts}-${entry.attempt}-${i}`}
                    className="border-b last:border-0 hover:bg-muted/20 transition-colors"
                  >
                    {/* Timestamp */}
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      <span title={formatAbsoluteUtc(entry.ts)}>
                        {formatRelative(entry.ts)}
                      </span>
                    </td>

                    {/* Status badge */}
                    <td className="px-3 py-2">
                      <Badge
                        variant={statusBadgeVariant(entry.status)}
                        className="text-[10px] capitalize"
                      >
                        {statusLabel(entry.status)}
                      </Badge>
                    </td>

                    {/* Duration */}
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDurationMs(entry.duration_ms)}
                    </td>

                    {/* Error (truncated, expandable) */}
                    <td className="px-3 py-2 text-xs max-w-[300px]">
                      {entry.error ? (
                        <button
                          onClick={() => setExpandedError(isExpanded ? null : i)}
                          className="text-left text-destructive hover:text-destructive/80 transition-colors"
                          title={isExpanded ? 'Click to collapse' : 'Click to expand'}
                        >
                          {isExpanded ? (
                            <span className="whitespace-pre-wrap break-words">{entry.error}</span>
                          ) : (
                            <span className="truncate block max-w-[280px]">{entry.error}</span>
                          )}
                        </button>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination footer */}
      {!loading && !error && total > 0 && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-foreground">
            Showing {displayStart}–{displayEnd} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={goNewer}
              disabled={!canGoNewer}
              className="h-7 px-2 text-xs gap-1"
            >
              <IconChevronLeft size={12} />
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={goOlder}
              disabled={!canGoOlder}
              className="h-7 px-2 text-xs gap-1"
            >
              Older
              <IconChevronRight size={12} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
