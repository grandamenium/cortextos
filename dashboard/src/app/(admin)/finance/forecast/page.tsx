'use client';

import { useMemo } from 'react';
import { MOCK_PNL } from '@/lib/finance/mock-pnl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function linearRegression(ys: number[]) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const sumX  = xs.reduce((a, b) => a + b, 0);
  const sumY  = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

const FORECAST_LABELS = ['Jun 2026', 'Jul 2026', 'Aug 2026'];

export default function ForecastPage() {
  const chartData = useMemo(() => {
    // Regression on retainer revenue only — not ad spend
    const revenues = MOCK_PNL.map((m) => m.revenue);
    const { slope, intercept } = linearRegression(revenues);

    const historical = MOCK_PNL.map((m) => ({
      label: m.label,
      retainer: m.revenue,
      costs: m.costs,
      margin: m.margin,
      forecast: null as number | null,
      isForecast: false,
    }));

    const costRatio = MOCK_PNL[MOCK_PNL.length - 1].costs / MOCK_PNL[MOCK_PNL.length - 1].revenue;

    const forecasted = FORECAST_LABELS.map((label, i) => {
      const x = revenues.length + i;
      const rev = Math.round(intercept + slope * x);
      return {
        label,
        retainer: null as number | null,
        costs: null as number | null,
        margin: null as number | null,
        forecast: rev,
        forecastMargin: Math.round(rev * (1 - costRatio)),
        isForecast: true,
      };
    });

    return [...historical, ...forecasted];
  }, []);

  const nextQtrRevenue = chartData
    .filter((d) => d.isForecast && d.forecast != null)
    .reduce((sum, d) => sum + (d.forecast ?? 0), 0);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Revenue Forecast</h1>
        <p className="text-sm text-muted-foreground mt-1">
          3-month rolling forecast · Linear regression on 5-month retainer actuals · Mock data
        </p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">
          Forecasting retainer revenue only — client ad spend pass-through is excluded.
        </p>
      </div>

      <Card>
        <CardHeader className="px-4 pt-4 pb-1">
          <CardTitle className="text-sm font-medium">
            Projected next-quarter retainer revenue:{' '}
            <span className="text-primary">{fmt(nextQtrRevenue)}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 pb-4 pr-6">
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} width={52} />
              <Tooltip formatter={(v) => fmt(v as number)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine
                x={MOCK_PNL[MOCK_PNL.length - 1].label}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 4"
                label={{ value: 'Today', fontSize: 10 }}
              />
              <Line type="monotone" dataKey="retainer"  stroke="hsl(var(--primary))"     strokeWidth={2} dot={false} name="Retainer (actual)"   connectNulls />
              <Line type="monotone" dataKey="costs"     stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} name="Agency Costs"         connectNulls />
              <Line type="monotone" dataKey="margin"    stroke="hsl(142,71%,45%)"        strokeWidth={2} dot={false} name="Margin (actual)"      connectNulls />
              <Line type="monotone" dataKey="forecast"  stroke="hsl(var(--primary))"     strokeWidth={2} strokeDasharray="5 4" dot={false} name="Retainer (forecast)" connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
