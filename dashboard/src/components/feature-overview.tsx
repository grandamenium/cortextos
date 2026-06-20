import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Overview } from '@/lib/feature-rollup';

function Bar({ percent, className = 'h-2' }: { percent: number; className?: string }) {
  return (
    <div className={`w-full overflow-hidden rounded-full bg-muted ${className}`}>
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="flex flex-col">
      <span className={`text-2xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function FeatureOverview({ overview }: { overview: Overview }) {
  const p = overview.pulse;

  return (
    <div className="space-y-5">
      {/* Projekt-Puls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">PhytoMedic — Projekt-Fortschritt</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-4">
            <span className="text-4xl font-bold tabular-nums">{p.percentDone}%</span>
            <span className="mb-1 text-sm text-muted-foreground">{p.done} von {p.total} Tasks fertig</span>
          </div>
          <Bar percent={p.percentDone} />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="in Arbeit" value={p.inProgress} tone="text-amber-500" />
            <Stat label="offen" value={p.pending} />
            <Stat label="blockiert" value={p.blocked} tone={p.blocked ? 'text-red-500' : ''} />
            <Stat label="urgent offen" value={p.urgentOpen} tone={p.urgentOpen ? 'text-red-500' : ''} />
          </div>
        </CardContent>
      </Card>

      {/* Feature-Karten */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {overview.features.map((f) => {
          const open = f.totals.total - f.totals.done;
          return (
            <Card key={f.feature}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm font-medium">
                  <span>{f.feature}</span>
                  <span className="tabular-nums text-muted-foreground">{f.percentDone}%</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Bar percent={f.percentDone} className="h-1.5" />
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="tabular-nums text-muted-foreground">{f.totals.done}/{f.totals.total} · {open} offen</span>
                  {f.totals.inProgress > 0 && <Badge variant="secondary">{f.totals.inProgress}🟡</Badge>}
                  {f.totals.blocked > 0 && <Badge variant="secondary">{f.totals.blocked}🔴</Badge>}
                  {f.urgentOpen > 0 && <Badge variant="secondary">{f.urgentOpen}⚡</Badge>}
                </div>
                {f.owners.length > 0 && <div className="truncate text-xs text-muted-foreground">{f.owners.join(', ')}</div>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Was läuft JETZT */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Was läuft gerade ({overview.inProgressNow.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.inProgressNow.length === 0 ? (
            <p className="text-sm text-muted-foreground">Gerade nichts in Arbeit — Agenten idle oder zwischen Tasks.</p>
          ) : (
            <ul className="space-y-1.5">
              {overview.inProgressNow.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm">
                  <span className="text-amber-500">🟡</span>
                  <span className="w-40 shrink-0 truncate font-medium">{t.agent}</span>
                  <span className="truncate text-muted-foreground">{t.title}</span>
                  <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">{t.feature}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Blockiert */}
      {overview.blocked.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-red-600">🔴 Blockiert ({overview.blocked.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5">
              {overview.blocked.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm">
                  <span className="w-40 shrink-0 truncate font-medium">{t.agent}</span>
                  <span className="truncate text-muted-foreground">{t.title}</span>
                  <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">{t.feature}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
