'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface SessionRow {
  source_file: string;
  session_label: string;
  started_at: string;
  ended_at: string;
  message_count: number;
  total_tokens: number;
  cost_usd: number;
  model: string;
}

interface SessionListProps {
  sessions: SessionRow[];
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

export function SessionList({ sessions }: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          <p>No sessions in this range</p>
          <p className="mt-1 text-xs text-muted-foreground/70">Sessions appear here as the agent's transcript is parsed.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Sessions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead className="text-right">Messages</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={s.source_file}>
                <TableCell className="max-w-[280px] truncate font-mono text-xs">
                  {s.session_label}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{s.model || '—'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelative(s.ended_at)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{s.message_count}</TableCell>
                <TableCell className="text-right tabular-nums">{formatTokens(s.total_tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">${s.cost_usd.toFixed(4)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
