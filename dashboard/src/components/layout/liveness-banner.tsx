'use client';

import { useEffect, useState } from 'react';

interface Health {
  status: 'ok' | 'stale' | 'down';
  messages: string[];
}

/**
 * Polls /api/health every 30s and shows a banner whenever the cross-agent
 * coordination layer is stale or down (the cortextos liveness watchdog stopped
 * regenerating the vault board). Renders nothing when healthy.
 */
export function LivenessBanner() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const data = (await res.json()) as Health;
        if (active) setHealth(data);
      } catch {
        /* transient — keep the last known state */
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  if (!health || health.status === 'ok') return null;

  const down = health.status === 'down';
  return (
    <div
      role="alert"
      className={`w-full px-4 py-2 text-sm ${down ? 'bg-red-600 text-white' : 'bg-amber-500 text-black'}`}
    >
      <span className="font-semibold">
        {down ? '⚠ Coordination layer DOWN' : '⚠ Coordination layer STALE'}:
      </span>{' '}
      {health.messages.join(' ')}
    </div>
  );
}
