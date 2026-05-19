import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { TimeAgo } from '@/components/shared/time-ago';
import type { MissionFeedRow } from '@/lib/agents';

interface MissionFeedProps {
  rows: MissionFeedRow[];
}

export function MissionFeed({ rows }: MissionFeedProps) {
  return (
    <Card className="border-none bg-white py-0 shadow-sm ring-1 ring-slate-200">
      <CardContent className="space-y-4 px-5 py-5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Mission feed</h2>
          <p className="mt-1 text-sm text-slate-600">A compact narrative of what the fleet has actually been doing.</p>
        </div>

        <div className="space-y-3">
          {rows.map((row) => (
            <Link
              href={row.href}
              key={row.id}
              className="block rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 transition hover:border-slate-300 hover:bg-slate-100"
              data-testid="mission-row"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{row.title}</p>
                  <p className="mt-1 text-sm text-slate-600">{row.narrative}</p>
                </div>
                {row.updatedAt ? (
                  <TimeAgo date={row.updatedAt} className="shrink-0 text-xs text-slate-500" />
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
