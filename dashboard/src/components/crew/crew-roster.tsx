'use client';

import { CrewAvatar } from './crew-avatar';
import type { CrewMood } from './crew-critter';

export interface RosterEntry {
  name: string;
  tagline: string;
  avatarVersion: number | null;
  mood: CrewMood;
}

interface CrewRosterProps {
  agents: RosterEntry[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** 'rail' = compact vertical list (desktop sidebar). 'grid' = big
   *  character cards (mobile home screen). */
  variant: 'rail' | 'grid';
}

function StatusDot({ mood }: { mood: CrewMood }) {
  const color =
    mood === 'typing'
      ? 'bg-emerald-400 crew-antenna-pulse'
      : mood === 'active'
        ? 'bg-emerald-400'
        : 'bg-muted-foreground/40';
  return (
    <span
      className={`absolute bottom-0.5 right-0.5 block h-3 w-3 rounded-full border-2 border-background ${color}`}
      aria-hidden
    />
  );
}

function statusLabel(mood: CrewMood): string {
  return mood === 'typing' ? 'working…' : mood === 'active' ? 'around' : 'resting';
}

/**
 * The crew — every enabled agent as a character. Order is the registry
 * order and never changes with presence; only the status styling moves.
 */
export function CrewRoster({ agents, selected, onSelect, variant }: CrewRosterProps) {
  if (agents.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">No agents enabled.</div>
    );
  }

  if (variant === 'rail') {
    return (
      <div className="flex flex-col gap-1 overflow-y-auto p-2">
        {agents.map((a) => (
          <button
            key={a.name}
            onClick={() => onSelect(a.name)}
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
              selected === a.name ? 'bg-muted' : 'hover:bg-muted/50'
            }`}
          >
            <div className="relative">
              <CrewAvatar name={a.name} version={a.avatarVersion} mood={a.mood} size={44} />
              <StatusDot mood={a.mood} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium leading-tight">{a.name}</p>
              <p className="truncate text-xs text-muted-foreground">{a.tagline}</p>
            </div>
            {a.mood === 'typing' && (
              <span className="shrink-0 text-[10px] font-medium text-emerald-500">working…</span>
            )}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3">
      {agents.map((a) => (
        <button
          key={a.name}
          onClick={() => onSelect(a.name)}
          className="flex flex-col items-center gap-2 rounded-2xl border bg-muted/20 px-3 py-4 transition-colors hover:border-primary/40 hover:bg-muted/40"
        >
          <div className="relative">
            <CrewAvatar name={a.name} version={a.avatarVersion} mood={a.mood} size={76} ring />
            <StatusDot mood={a.mood} />
          </div>
          <div className="min-w-0 text-center">
            <p className="truncate text-sm font-semibold">{a.name}</p>
            <p className="truncate text-xs text-muted-foreground">{a.tagline}</p>
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              a.mood === 'typing'
                ? 'bg-emerald-400/15 text-emerald-500'
                : a.mood === 'active'
                  ? 'bg-emerald-400/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            {statusLabel(a.mood)}
          </span>
        </button>
      ))}
    </div>
  );
}
