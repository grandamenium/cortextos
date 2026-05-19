import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';

interface HeroStripProps {
  nowLabel: string;
  mood: string;
  oneThing: string;
  nextLabel: string;
  nextHref: string;
}

export function HeroStrip({
  nowLabel,
  mood,
  oneThing,
  nextLabel,
  nextHref,
}: HeroStripProps) {
  return (
    <Card className="border-none bg-gradient-to-br from-slate-100 via-white to-amber-50 py-0 shadow-sm ring-1 ring-slate-200">
      <CardContent className="grid gap-3 px-5 py-5 md:grid-cols-[0.9fr_1.4fr_1fr]">
        <div className="rounded-2xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Right now</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{nowLabel}</p>
          <p className="mt-1 text-sm text-slate-600">{mood}</p>
        </div>

        <div className="rounded-2xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">The one thing</p>
          <p
            className="mt-2 text-lg font-semibold leading-tight text-slate-900"
            data-testid="hero-one-thing"
          >
            {oneThing}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Pulled from the freshest current mission across the fleet.
          </p>
        </div>

        <div className="rounded-2xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Next from you</p>
          <p className="mt-2 text-base font-medium text-slate-900">{nextLabel}</p>
          <Link
            href={nextHref}
            className="mt-4 inline-flex rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            Open queue
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
