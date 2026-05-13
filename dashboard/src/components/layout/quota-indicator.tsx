'use client';

import { useEffect, useState } from 'react';
import { IconCircleDot } from '@tabler/icons-react';

type QuotaSnapshot = {
  five_hour_remaining_pct: number;
  seven_day_remaining_pct: number;
  fetched_at: string;
  source: string;
  stale?: boolean;
  cache_age_ms?: number;
};

const POLL_MS = 60_000;

function formatAge(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function bandFor(pct: number) {
  if (pct >= 50) {
    return { label: 'healthy', dotClass: 'bg-emerald-500', textClass: 'text-emerald-400' };
  }
  if (pct >= 20) {
    return { label: 'watch', dotClass: 'bg-amber-500', textClass: 'text-amber-400' };
  }
  return { label: 'low', dotClass: 'bg-rose-500', textClass: 'text-rose-400' };
}

export function QuotaIndicator() {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/quota', { cache: 'no-store' });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) {
            setError(err.error ?? `Quota fetch failed (${res.status})`);
            setSnapshot(null);
          }
          return;
        }

        const data = (await res.json()) as QuotaSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    }

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground"
        title={error}
        aria-label={`Quota status unavailable: ${error}`}
      >
        <IconCircleDot size={12} className="text-muted-foreground/50" />
        <span>quota n/a</span>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
        <span className="h-2 w-2 animate-pulse rounded-full bg-muted" aria-hidden="true" />
        <span>quota...</span>
      </div>
    );
  }

  const fiveHour = snapshot.five_hour_remaining_pct;
  const sevenDay = snapshot.seven_day_remaining_pct;
  const band = bandFor(fiveHour);
  const ageLabel = snapshot.stale && snapshot.cache_age_ms != null
    ? formatAge(snapshot.cache_age_ms)
    : null;
  const tooltipText = [
    `5h window: ${fiveHour}% remaining`,
    `7d window: ${sevenDay}% remaining`,
    `source: ${snapshot.source}${snapshot.stale ? ' (cached)' : ''}`,
    `updated: ${new Date(snapshot.fetched_at).toLocaleTimeString()}`,
    ageLabel ? `API failed; showing last-good from ${ageLabel}` : '',
  ].filter(Boolean).join('\n');

  return (
    <div
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${snapshot.stale ? 'opacity-60' : ''}`}
      title={tooltipText}
      aria-label={`Quota ${band.label}: ${fiveHour} percent remaining in the 5 hour window, ${sevenDay} percent remaining in the 7 day window${ageLabel ? `, cached from ${ageLabel}` : ''}`}
    >
      <span className={`h-2 w-2 rounded-full ${band.dotClass}`} aria-hidden="true" />
      <span className={`font-mono ${band.textClass}`}>{fiveHour}%</span>
      <span className="hidden text-muted-foreground sm:inline">{ageLabel ?? 'left'}</span>
    </div>
  );
}
