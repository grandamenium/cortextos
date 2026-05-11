'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { SparkLine } from '@/components/charts/spark-line';
import { CHART_GOLD } from '@/components/charts/chart-theme';
import { IconChevronRight } from '@tabler/icons-react';

interface FleetRow {
  agent: string;
  org: string;
  runtime: 'claude-code' | 'codex-app-server' | 'hermes';
  cron_mode: 'inject' | 'print' | null;
  cost_usd: number;
  total_tokens: number;
  cron_runs: number;
  last_active: string | null;
  sparkline: number[];
}

interface FleetTableProps {
  rows: FleetRow[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function runtimeLabel(r: FleetRow['runtime']): string {
  if (r === 'claude-code') return 'claude';
  if (r === 'codex-app-server') return 'codex';
  return 'hermes';
}

export function FleetTable({ rows }: FleetTableProps) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          <p>No agents have usage in this range yet</p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Token usage syncs from <code className="font-mono text-[10px]">~/.claude/projects</code> and{' '}
            <code className="font-mono text-[10px]">logs/&lt;agent&gt;/codex-tokens.jsonl</code>. Try a longer range.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Agents
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Runtime</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Cron runs</TableHead>
              <TableHead>Trend (14d)</TableHead>
              <TableHead className="w-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.org}/${r.agent}`}>
                <TableCell className="font-medium">
                  <Link
                    href={`/usage/${encodeURIComponent(r.agent)}`}
                    className="hover:text-primary"
                  >
                    {r.agent}
                  </Link>
                  {r.org && (
                    <span className="ml-2 text-[10px] text-muted-foreground">{r.org}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {runtimeLabel(r.runtime)}
                  </Badge>
                  {r.cron_mode === 'print' && (
                    <Badge variant="ghost" className="ml-1 font-mono text-[10px]">
                      print
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatTokens(r.total_tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">${r.cost_usd.toFixed(2)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.cron_runs}</TableCell>
                <TableCell>
                  {r.sparkline.length > 0 && r.sparkline.some((v) => v > 0) ? (
                    <SparkLine data={r.sparkline} color={CHART_GOLD} width={100} height={24} />
                  ) : (
                    <span className="text-xs text-muted-foreground/50">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/usage/${encodeURIComponent(r.agent)}`}
                    aria-label={`Open ${r.agent} usage`}
                    className="inline-flex items-center text-muted-foreground hover:text-primary"
                  >
                    <IconChevronRight size={14} />
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
