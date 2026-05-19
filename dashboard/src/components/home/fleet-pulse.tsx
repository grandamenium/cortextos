import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { TimeAgo } from '@/components/shared/time-ago';
import { SparkLine } from '@/components/charts/spark-line';
import type { FleetPulseItem } from '@/lib/agents';

interface FleetPulseProps {
  agents: FleetPulseItem[];
}

const healthClasses: Record<FleetPulseItem['health'], string> = {
  green: 'bg-emerald-500 text-emerald-50',
  amber: 'bg-amber-400 text-amber-950',
  red: 'bg-rose-500 text-rose-50',
};

export function FleetPulse({ agents }: FleetPulseProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Fleet pulse</h2>
          <p className="mt-1 text-sm text-slate-600">Who is moving, waiting, or running hot right now.</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {agents.map((agent) => (
          <Link href={agent.href} key={agent.name}>
            <Card
              className="h-full border-none bg-white py-0 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md"
              data-testid="fleet-card"
            >
              <CardContent className="space-y-4 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <AgentAvatar name={agent.name} size="sm" />
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{agent.name}</p>
                      <p className="text-xs text-slate-500">{agent.lastVerb}</p>
                    </div>
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase ${healthClasses[agent.health]}`}>
                    {agent.health}
                  </span>
                </div>

                <div className="rounded-xl bg-slate-50 px-3 py-2">
                  <SparkLine data={agent.sparkline} width={220} height={44} className="w-full" />
                </div>

                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>Last activity</span>
                  {agent.lastActiveAt ? (
                    <TimeAgo date={agent.lastActiveAt} />
                  ) : (
                    <span>unknown</span>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
