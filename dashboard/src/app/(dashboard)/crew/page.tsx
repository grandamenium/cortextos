'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CrewRoster } from '@/components/crew/crew-roster';
import { CrewChat } from '@/components/crew/crew-chat';
import { useCrew } from '@/components/crew/use-crew';
import '@/components/crew/crew.css';

function CrewPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get('with');
  const { user, agents, roster, loading, moodFor, onAvatarChanged } = useCrew();

  const selectedAgent = agents.find((a) => a.name === selected) ?? null;
  const workingCount = roster.filter((r) => r.mood !== 'resting').length;

  function select(name: string) {
    router.replace(`/crew?with=${encodeURIComponent(name)}`, { scroll: false });
  }

  function back() {
    router.replace('/crew', { scroll: false });
  }

  if (loading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Waking the crew…</div>;
  }

  return (
    <div className="flex h-[calc(100dvh-168px)] flex-col gap-3 md:h-[calc(100dvh-118px)]">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Crew</h1>
        <p className="text-xs text-muted-foreground">
          {workingCount > 0
            ? `${workingCount} of ${roster.length} up and about`
            : `all ${roster.length} resting`}
        </p>
      </div>

      {/* Desktop: rail + chat side by side. */}
      <div className="hidden min-h-0 flex-1 gap-3 md:grid md:grid-cols-[290px_1fr]">
        <div className="min-h-0 overflow-hidden rounded-xl border bg-muted/10">
          <CrewRoster agents={roster} selected={selected} onSelect={select} variant="rail" />
        </div>
        {selectedAgent ? (
          <CrewChat
            agent={selectedAgent}
            user={user}
            mood={moodFor(selectedAgent.name)}
            onAvatarChanged={(v) => onAvatarChanged(selectedAgent.name, v)}
          />
        ) : (
          <div className="flex items-center justify-center rounded-xl border bg-muted/10 text-sm text-muted-foreground">
            Pick a crew member to start chatting
          </div>
        )}
      </div>

      {/* Mobile: roster screen, or full-screen chat with a back button. */}
      <div className="min-h-0 flex-1 md:hidden">
        {selectedAgent ? (
          <CrewChat
            agent={selectedAgent}
            user={user}
            mood={moodFor(selectedAgent.name)}
            onBack={back}
            onAvatarChanged={(v) => onAvatarChanged(selectedAgent.name, v)}
          />
        ) : (
          <CrewRoster agents={roster} selected={null} onSelect={select} variant="grid" />
        )}
      </div>
    </div>
  );
}

export default function CrewPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-sm text-muted-foreground">Waking the crew…</div>}>
      <CrewPageInner />
    </Suspense>
  );
}
