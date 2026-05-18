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

function formatAge(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

const POLL_MS = 60_000; // refresh every 60 seconds — balances freshness vs API rate limits

function bandFor(pct: number): {
  label: string;
  dotClass: string;
  textClass: string;
} {
  // Color is a hint — we ALSO surface the % number so the meaning is not
  // color-only (UX rule §1 color-not-only).
  if (pct >= 50)
    return {
      label: 'healthy',
      dotClass: 'bg-emerald-500',
      textClass: 'text-emerald-300',
    };
  if (pct >= 20)
    return {
      label: 'watch',
      dotClass: 'bg-amber-500',
      textClass: 'text-amber-300',
    };
  return {
    label: 'low',
    dotClass: 'bg-rose-500',
    textClass: 'text-rose-300',
  };
}

export function QuotaIndicator() {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
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
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };

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
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground"
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
        <span className="w-2 h-2 rounded-full bg-muted animate-pulse" aria-hidden="true" />
        <span>quota…</span>
      </div>
    );
  }

  const fiveH = snapshot.five_hour_remaining_pct;
  const sevenD = snapshot.seven_day_remaining_pct;
  const band = bandFor(fiveH);
  const isStale = !!snapshot.stale;
  const ageLabel = isStale && snapshot.cache_age_ms != null ? formatAge(snapshot.cache_age_ms) : null;

  const tooltipText =
    `5h window: ${fiveH}% remaining\n` +
    `7d window: ${sevenD}% remaining\n` +
    `source: ${snapshot.source}${isStale ? ' (cached)' : ''}\n` +
    `updated: ${new Date(snapshot.fetched_at).toLocaleTimeString()}` +
    (isStale ? `\n⚠ API call failed; showing last-good from ${ageLabel}` : '');

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs ${isStale ? 'opacity-60' : ''}`}
      title={tooltipText}
      aria-label={`Quota ${band.label}: ${fiveH} percent remaining in the 5 hour window, ${sevenD} percent remaining in the 7 day window${isStale ? `, cached from ${ageLabel}` : ''}`}
    >
      <span
        className={`w-2 h-2 rounded-full ${band.dotClass}`}
        aria-hidden="true"
      />
      <span className={`font-mono ${band.textClass}`}>{fiveH}%</span>
      {isStale && ageLabel ? (
        <span className="text-muted-foreground hidden sm:inline">{ageLabel}</span>
      ) : (
        <span className="text-muted-foreground hidden sm:inline">left</span>
      )}
    </div>
  );
}
