import { Card, CardContent } from '@/components/ui/card';
import { SparkLine } from '@/components/charts/spark-line';

export interface TodayMetricCard {
  id: 'velocity' | 'quality' | 'posture';
  title: string;
  value: string;
  detail: string;
  delta: string;
  sparkline: number[];
}

interface TodayMetricsProps {
  cards: TodayMetricCard[];
}

export function TodayMetrics({ cards }: TodayMetricsProps) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Today</h2>
        <p className="mt-1 text-sm text-slate-600">Velocity, quality, and posture against the recent baseline.</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {cards.map((card) => (
          <Card
            key={card.id}
            className="border-none bg-white py-0 shadow-sm ring-1 ring-slate-200"
            data-testid={`today-card-${card.id}`}
          >
            <CardContent className="space-y-4 px-5 py-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{card.title}</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-900">{card.value}</p>
                  <p className="mt-1 text-sm text-slate-600">{card.detail}</p>
                </div>
                <p
                  className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                  data-testid={`today-card-${card.id}-delta`}
                >
                  {card.delta}
                </p>
              </div>

              <div data-testid={`today-card-${card.id}-sparkline`}>
                <SparkLine data={card.sparkline} width={220} height={48} className="w-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
