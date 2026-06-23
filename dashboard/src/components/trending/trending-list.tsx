'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
  IconStarFilled,
} from '@tabler/icons-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import type { TrendingPick } from '@/lib/data/trending';

interface TrendingListProps {
  date: string | null;
  availableDates: string[];
  picks: TrendingPick[];
}

function getVerdictVariant(verdict: TrendingPick['verdict']): 'default' | 'secondary' | 'outline' {
  if (verdict === 'steal') return 'default';
  if (verdict === 'skip') return 'secondary';
  return 'outline';
}

function getVerdictLabel(verdict: TrendingPick['verdict']): string {
  if (verdict === 'steal') return 'STEAL';
  if (verdict === 'skip') return 'SKIP';
  return 'UNKNOWN';
}

export function TrendingList({ date, availableDates, picks }: TrendingListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [openReadmes, setOpenReadmes] = useState<Record<string, boolean>>({});

  const selectedDate = date ?? availableDates[0] ?? '';
  const dateLabel = date ?? 'Latest';
  const hasMultipleDates = availableDates.length > 1;
  const hasPicks = picks.length > 0;

  const currentParams = useMemo(() => new URLSearchParams(searchParams.toString()), [searchParams]);

  function handleDateChange(nextDate: string | null) {
    if (!nextDate) return;
    const params = new URLSearchParams(currentParams.toString());
    params.set('date', nextDate);
    router.push(`${pathname}?${params.toString()}`);
  }

  function toggleReadme(repo: string) {
    setOpenReadmes((current) => ({
      ...current,
      [repo]: !current[repo],
    }));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground/70">Snapshot</p>
          {!hasMultipleDates ? (
            <p className="mt-1 text-sm font-medium">{dateLabel}</p>
          ) : null}
        </div>

        {hasMultipleDates ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">History</span>
            <Select value={selectedDate} onValueChange={handleDateChange}>
              <SelectTrigger className="min-w-40">
                <SelectValue placeholder="Select date" />
              </SelectTrigger>
              <SelectContent>
                {availableDates.map((availableDate) => (
                  <SelectItem key={availableDate} value={availableDate}>
                    {availableDate}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {!hasPicks ? (
        <Card>
          <CardContent className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
            <p className="text-base font-medium">No trending picks yet.</p>
            <p className="max-w-md text-sm text-muted-foreground">
              frank2&apos;s daily 7 AM run populates this.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {picks.map((pick) => {
            const readmeOpen = openReadmes[pick.repo] ?? false;
            const hasReadmeExcerpt = pick.readmeExcerpt.trim().length > 0;

            return (
              <Card key={`${date ?? 'latest'}-${pick.repo}`}>
                <CardHeader className="gap-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-lg">
                          <Link
                            href={pick.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 hover:underline"
                          >
                            <span className="truncate">{pick.repo}</span>
                            <IconExternalLink size={14} className="shrink-0" />
                          </Link>
                        </CardTitle>
                        <Badge variant={getVerdictVariant(pick.verdict)}>
                          {getVerdictLabel(pick.verdict)}
                        </Badge>
                        {pick.language ? (
                          <Badge variant="outline">{pick.language}</Badge>
                        ) : null}
                        <Badge variant="outline" className="gap-1">
                          <IconStarFilled size={12} />
                          {pick.stars.toLocaleString()}
                        </Badge>
                      </div>
                      {pick.reason ? (
                        <p className="text-sm font-medium">{pick.reason}</p>
                      ) : null}
                    </div>
                  </div>
                  {pick.description ? (
                    <CardDescription className="text-sm leading-6">
                      {pick.description}
                    </CardDescription>
                  ) : null}
                </CardHeader>

                {hasReadmeExcerpt ? (
                  <CardContent className="pt-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => toggleReadme(pick.repo)}
                    >
                      {readmeOpen ? 'Hide README excerpt' : 'Show README excerpt'}
                      {readmeOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                    </Button>
                    {readmeOpen ? (
                      <div className="pt-3">
                        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-4 text-xs leading-6 whitespace-pre-wrap break-words text-foreground">
                          {pick.readmeExcerpt}
                        </pre>
                      </div>
                    ) : null}
                  </CardContent>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
