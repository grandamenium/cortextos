'use client';

import { Fragment, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { IconChevronRight, IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react';

interface AggregateRow {
  cron: string;
  runs: number;
  total_tokens: number;
  cost_usd: number;
  last_fire: string;
  last_status: 'fired' | 'retried' | 'failed';
  approximate: boolean;
}

interface RunRow {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  duration_ms: number;
  error?: string | null;
  total_tokens: number;
  cost_usd: number;
  approximate: boolean;
}

interface CronAttributionTableProps {
  aggregates: AggregateRow[];
  runs: RunRow[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function statusIcon(status: 'fired' | 'retried' | 'failed') {
  if (status === 'fired') return <IconCheck size={12} className="text-green-600" />;
  if (status === 'retried') return <IconAlertTriangle size={12} className="text-amber-500" />;
  return <IconX size={12} className="text-red-500" />;
}

export function CronAttributionTable({ aggregates, runs }: CronAttributionTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (aggregates.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          <p>No cron runs in this range</p>
          <p className="mt-1 text-xs text-muted-foreground/70">Try a longer range, or check the Workflows page if you expected crons here.</p>
        </CardContent>
      </Card>
    );
  }

  const anyApprox = aggregates.some((a) => a.approximate);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Crons
          {anyApprox && (
            <Badge
              variant="outline"
              className="font-normal normal-case tracking-normal"
              aria-label="Some attribution is approximate"
            >
              ≈ inject-mode is approximate
            </Badge>
          )}
        </CardTitle>
        {anyApprox && (
          <p className="text-xs text-muted-foreground/80">
            Tokens for <code className="font-mono text-[10px]">cron_mode=inject</code> crons are
            estimated by matching cost entries to each fire's time-window. Mode{' '}
            <code className="font-mono text-[10px]">print</code> attribution is exact.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Cron</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Last fire</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {aggregates.map((a) => {
              const isOpen = expanded === a.cron;
              const cronRuns = runs.filter((r) => r.cron === a.cron).slice(0, 20);
              return (
                <Fragment key={a.cron}>
                  <TableRow
                    onClick={() => setExpanded(isOpen ? null : a.cron)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(isOpen ? null : a.cron);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    className="cursor-pointer focus-visible:outline-none focus-visible:bg-muted/50"
                  >
                    <TableCell>
                      <IconChevronRight
                        size={14}
                        className={cn(
                          'text-muted-foreground transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {a.cron}
                        {a.approximate && (
                          <span
                            className="text-[10px] text-muted-foreground"
                            title="approximate: inject-mode time-window heuristic"
                            aria-label="approximate"
                          >
                            ≈
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{a.runs}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatTokens(a.total_tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      ${a.cost_usd.toFixed(4)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelative(a.last_fire)}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1">
                        {statusIcon(a.last_status)}
                        <span className="text-xs capitalize text-muted-foreground">
                          {a.last_status}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                  {isOpen && cronRuns.length > 0 && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell colSpan={7} className="p-0">
                        <div className="border-t px-3 py-2">
                          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                            Recent runs
                          </p>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>When</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="text-right">Duration</TableHead>
                                <TableHead className="text-right">Tokens</TableHead>
                                <TableHead className="text-right">Cost</TableHead>
                                <TableHead>Error</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {cronRuns.map((r, i) => (
                                <TableRow key={`${r.ts}-${i}`}>
                                  <TableCell className="text-muted-foreground">
                                    {formatRelative(r.ts)}
                                  </TableCell>
                                  <TableCell>
                                    <span className="inline-flex items-center gap-1">
                                      {statusIcon(r.status)}
                                      <span className="text-xs capitalize text-muted-foreground">
                                        {r.status}
                                      </span>
                                    </span>
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums text-muted-foreground">
                                    {(r.duration_ms / 1000).toFixed(1)}s
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    {formatTokens(r.total_tokens)}
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    ${r.cost_usd.toFixed(4)}
                                  </TableCell>
                                  <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground">
                                    {r.error ?? ''}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
