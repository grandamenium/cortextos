import type { MomentumData } from '@/lib/data/momentum';

interface MomentumStripProps {
  data: MomentumData | null;
}

export function MomentumStrip({ data }: MomentumStripProps) {
  if (!data) return null;

  const { streak, win_bank } = data;
  const streakNum = streak?.current_streak ?? 0;
  const winsTotal = win_bank?.total_wins ?? 0;
  const top = win_bank?.top_recent?.[0];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="rounded-lg border bg-card p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Engagement Streak
        </p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-3xl font-bold tabular-nums">{streakNum}</span>
          <span className="text-2xl">🔥</span>
          <span className="text-xs text-muted-foreground ml-auto self-center">
            longest {streak?.longest_streak ?? 0}
          </span>
        </div>
        {streak?.last_engagement_date && (
          <p className="mt-1 text-xs text-muted-foreground">
            last engagement {streak.last_engagement_date}
          </p>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Fleet Wins (7d)
        </p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-3xl font-bold tabular-nums">{winsTotal}</span>
          <span className="text-sm text-muted-foreground">shipped</span>
        </div>
        {top && (
          <p className="mt-1 text-xs text-muted-foreground truncate">
            latest: {top.agent} → {top.title}
          </p>
        )}
      </div>
    </div>
  );
}
