import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';

export interface DecisionQueueRow {
  id: string;
  title: string;
  detail: string;
  ctaLabel: string;
  href: string;
}

interface DecisionsQueueProps {
  rows: DecisionQueueRow[];
}

export function DecisionsQueue({ rows }: DecisionsQueueProps) {
  return (
    <Card className="border-none bg-white py-0 shadow-sm ring-1 ring-slate-200">
      <CardContent className="space-y-4 px-5 py-5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Decisions queue</h2>
          <p className="mt-1 text-sm text-slate-600">Approvals, blocked work, and open PRs that want a human move.</p>
        </div>

        <div className="space-y-3">
          {rows.map((row, index) => (
            <div
              key={row.id}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
              data-testid={`decision-row-${index}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{row.title}</p>
                  <p className="mt-1 text-sm text-slate-600">{row.detail}</p>
                </div>
                <Link
                  href={row.href}
                  className="inline-flex h-7 items-center rounded-lg border border-slate-300 bg-white px-3 text-[0.8rem] font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-100"
                  data-testid="decision-cta"
                >
                  {row.ctaLabel}
                </Link>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
