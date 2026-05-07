'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type Health = 'ok' | 'reconnecting' | 'down';

export function ConnectionStatusBanner() {
  const [health, setHealth] = useState<Health>('reconnecting');

  useEffect(() => {
    let cancelled = false;
    let failures = 0;
    async function check() {
      try {
        const response = await fetch('/api/hermes/health', { cache: 'no-store' });
        failures = response.ok ? 0 : failures + 1;
        if (!cancelled) setHealth(response.ok ? 'ok' : failures > 1 ? 'down' : 'reconnecting');
      } catch {
        failures += 1;
        if (!cancelled) setHealth(failures > 1 ? 'down' : 'reconnecting');
      }
    }
    check();
    const id = window.setInterval(check, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (health === 'ok') return null;

  return (
    <div className={cn(
      'flex h-9 shrink-0 items-center justify-center border-b px-4 text-xs font-medium',
      health === 'reconnecting' ? 'bg-warning/15 text-warning-foreground' : 'bg-destructive/15 text-destructive',
    )}>
      <span className={cn('mr-2 h-2 w-2 rounded-full', health === 'reconnecting' ? 'bg-warning' : 'bg-destructive')} />
      Hermes gateway {health === 'reconnecting' ? 'reconnecting' : 'down'}
    </div>
  );
}
