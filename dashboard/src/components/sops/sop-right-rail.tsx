'use client';

import { Card, CardContent } from '@/components/ui/card';
import { IconHistory } from '@tabler/icons-react';
import type { SopDocument, SopVersionEntry } from '@/lib/data/sop-model';

function formatEt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function SopRightRail({
  sop,
  version,
  versions,
}: {
  sop: SopDocument;
  version: SopVersionEntry;
  versions: SopVersionEntry[];
  source?: 'fixtures';
}) {
  return (
    <div className="flex w-80 shrink-0 flex-col gap-3">
      <Card>
        <CardContent className="space-y-2.5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Metadata</p>
          <dl className="space-y-1.5 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Subject type</dt>
              <dd className="font-medium">{sop.subject_type}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono">{version.id}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Last edited by</dt>
              <dd className="font-medium">{version.updated_by}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Last edited</dt>
              <dd className="text-right">{formatEt(version.updated_at)} ET</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <IconHistory size={13} />
            History
          </div>
          {versions.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No version history recorded yet for this SOP.
            </p>
          ) : (
            versions.map((v) => (
              <div key={v.id} className="rounded-lg border bg-secondary/20 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-medium">{v.id}</span>
                  <span className="text-[11px] text-muted-foreground">{formatEt(v.updated_at)} ET</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {v.updated_by} &middot; {v.change_note}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
