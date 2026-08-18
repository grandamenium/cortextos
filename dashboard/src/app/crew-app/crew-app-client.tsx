'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CrewRoster } from '@/components/crew/crew-roster';
import { CrewChat } from '@/components/crew/crew-chat';
import { useCrew } from '@/components/crew/use-crew';
import '@/components/crew/crew.css';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Late one?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good arvo';
  return 'Good evening';
}

function CrewAppInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get('with');
  const { user, agents, roster, loading, moodFor, onAvatarChanged } = useCrew();

  // iOS keyboard fix: 100dvh does NOT shrink when the on-screen keyboard
  // opens, which buries the chat bar behind it. visualViewport tracks the
  // true visible area, so pin the app's height to it when available.
  const [viewportH, setViewportH] = useState<number | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setViewportH(Math.round(vv.height));
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  const selectedAgent = agents.find((a) => a.name === selected) ?? null;
  const workingCount = roster.filter((r) => r.mood !== 'resting').length;

  function select(name: string) {
    router.replace(`/crew-app?with=${encodeURIComponent(name)}`, { scroll: false });
  }

  function back() {
    router.replace('/crew-app', { scroll: false });
  }

  return (
    <div
      className="relative flex h-dvh flex-col overflow-hidden bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
      style={viewportH !== null ? { height: `${viewportH}px` } : undefined}
    >
      {/* Ambient glow behind the roster — decorative only. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72"
        style={{
          background:
            'radial-gradient(70% 100% at 50% 0%, rgba(52, 211, 153, 0.10) 0%, transparent 70%)',
        }}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Waking the crew…
        </div>
      ) : selectedAgent ? (
        <div className="relative min-h-0 flex-1">
          <CrewChat
            agent={selectedAgent}
            user={user}
            mood={moodFor(selectedAgent.name)}
            onBack={back}
            onAvatarChanged={(v) => onAvatarChanged(selectedAgent.name, v)}
            frameless
          />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col px-4 pt-6">
          <div className="mb-4">
            <h1 className="text-2xl font-bold tracking-tight">{greeting()}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {workingCount > 0
                ? `${workingCount} of your crew ${workingCount === 1 ? 'is' : 'are'} up and about`
                : 'the whole crew is resting'}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            <CrewRoster agents={roster} selected={null} onSelect={select} variant="grid" />
          </div>
        </div>
      )}
    </div>
  );
}

export function CrewAppClient() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
          Waking the crew…
        </div>
      }
    >
      <CrewAppInner />
    </Suspense>
  );
}
