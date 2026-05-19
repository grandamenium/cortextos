'use client';

import { AnimatePresence, motion } from 'framer-motion';
import type { CSSProperties } from 'react';
import type { AgentPresencePayload } from '@/lib/agent-presence';
import { cn } from '@/lib/utils';

const PRESENCE_STALE_MS = 60_000;
const MOTION_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const AGENT_PALETTES = [
  { accent: '#0284c7', soft: 'rgba(2,132,199,0.16)', ring: 'rgba(2,132,199,0.34)', staleRing: 'rgba(2,132,199,0.16)', gradient: 'linear-gradient(135deg, rgba(2,132,199,0.92), rgba(14,165,233,0.7))' },
  { accent: '#059669', soft: 'rgba(5,150,105,0.16)', ring: 'rgba(5,150,105,0.34)', staleRing: 'rgba(5,150,105,0.16)', gradient: 'linear-gradient(135deg, rgba(5,150,105,0.92), rgba(16,185,129,0.68))' },
  { accent: '#7c3aed', soft: 'rgba(124,58,237,0.15)', ring: 'rgba(124,58,237,0.32)', staleRing: 'rgba(124,58,237,0.14)', gradient: 'linear-gradient(135deg, rgba(124,58,237,0.9), rgba(168,85,247,0.68))' },
  { accent: '#e11d48', soft: 'rgba(225,29,72,0.14)', ring: 'rgba(225,29,72,0.3)', staleRing: 'rgba(225,29,72,0.13)', gradient: 'linear-gradient(135deg, rgba(225,29,72,0.9), rgba(244,63,94,0.66))' },
  { accent: '#d97706', soft: 'rgba(217,119,6,0.15)', ring: 'rgba(217,119,6,0.32)', staleRing: 'rgba(217,119,6,0.14)', gradient: 'linear-gradient(135deg, rgba(217,119,6,0.9), rgba(245,158,11,0.68))' },
  { accent: '#0891b2', soft: 'rgba(8,145,178,0.15)', ring: 'rgba(8,145,178,0.32)', staleRing: 'rgba(8,145,178,0.14)', gradient: 'linear-gradient(135deg, rgba(8,145,178,0.9), rgba(34,211,238,0.64))' },
  { accent: '#4f46e5', soft: 'rgba(79,70,229,0.15)', ring: 'rgba(79,70,229,0.32)', staleRing: 'rgba(79,70,229,0.14)', gradient: 'linear-gradient(135deg, rgba(79,70,229,0.9), rgba(99,102,241,0.66))' },
  { accent: '#16a34a', soft: 'rgba(22,163,74,0.15)', ring: 'rgba(22,163,74,0.32)', staleRing: 'rgba(22,163,74,0.14)', gradient: 'linear-gradient(135deg, rgba(22,163,74,0.9), rgba(132,204,22,0.62))' },
];

export function paletteForAgent(agentId: string) {
  const hash = Array.from(agentId).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AGENT_PALETTES[hash % AGENT_PALETTES.length];
}

export function presenceRingStyle(presence?: AgentPresencePayload[]): CSSProperties | undefined {
  if (!presence?.length) return undefined;
  const primary = paletteForAgent(presence[0].actor_id);
  const shadows = presence.slice(0, 4).map((item, index) => {
    const palette = paletteForAgent(item.actor_id);
    return `0 0 0 ${3 + index * 3}px ${isStale(item) ? palette.staleRing : palette.ring}`;
  });
  return {
    borderColor: primary.accent,
    boxShadow: [...shadows, `inset 4px 0 0 ${primary.accent}`].join(', '),
  };
}

function isStale(presence: AgentPresencePayload) {
  const updatedAt = Date.parse(presence.updated_at);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > PRESENCE_STALE_MS;
}

function initials(name: string) {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';
}

export function AgentCursor({
  presence,
  index = 0,
  compact = false,
}: {
  presence: AgentPresencePayload;
  index?: number;
  compact?: boolean;
}) {
  const label =
    presence.action_label ||
    presence.cursor_position_hint ||
    presence.current_action ||
    presence.task_title ||
    presence.status.replaceAll('_', ' ');
  const palette = paletteForAgent(presence.actor_id);
  const stale = isStale(presence);
  const x = compact ? -(index * 16) : 0;
  const y = compact ? index * 8 : index * 28;
  const style = {
    '--agent-accent': palette.accent,
    '--agent-soft': palette.soft,
    '--agent-gradient': palette.gradient,
  } as CSSProperties;

  return (
    <motion.div
      layout
      layoutId={`agent-cursor-${presence.actor_id}`}
      initial={{ opacity: 0, scale: 0.96, x: x + 10, y }}
      animate={{ opacity: stale ? 0.54 : 1, scale: 1, x, y }}
      exit={{ opacity: 0, scale: 0.96, x: x + 10, y }}
      transition={{ duration: 0.2, ease: MOTION_EASE, delay: index * 0.025 }}
      className={cn(
        'pointer-events-none absolute z-20 flex items-start drop-shadow-sm',
        compact ? 'right-3 top-2' : 'right-2 top-2',
      )}
      style={style}
      data-agent-cursor={presence.actor_id}
      data-agent-cursor-stale={stale ? 'true' : 'false'}
      aria-label={`${presence.name} is active on this task`}
      title={`${presence.name}: ${label}`}
    >
      {!compact && (
        <motion.span
          aria-hidden="true"
          className="absolute left-0 top-2 h-4 w-8 rounded-full bg-[var(--agent-accent)]/15 blur-md"
          initial={{ opacity: 0, scaleX: 0.45 }}
          animate={{ opacity: stale ? 0.12 : 0.42, scaleX: 1 }}
          exit={{ opacity: 0, scaleX: 0.35 }}
          transition={{ duration: 0.2, ease: MOTION_EASE }}
        />
      )}
      <svg
        aria-hidden="true"
        viewBox="0 0 18 22"
        className="relative mt-0.5 h-5 w-4 shrink-0 fill-[var(--agent-accent)] stroke-background stroke-[1.5]"
      >
        <path d="M2.2 1.4 16.4 15c.7.7.1 1.9-.8 1.7l-5-.8-2.1 4.5c-.4.8-1.6.7-1.8-.2L.6 2.5c-.3-.9.9-1.7 1.6-1.1Z" />
      </svg>
      <span
        className={cn(
          'relative ml-0.5 inline-flex h-6 max-w-[9rem] items-center gap-1 overflow-hidden rounded-md border border-white/25 px-1.5 text-[11px] font-medium leading-none text-white shadow-sm backdrop-blur',
          compact && 'max-w-[7rem]',
        )}
        style={{ background: palette.gradient }}
      >
        {!stale && (
          <>
            <span className="absolute -left-1 top-1/2 size-5 -translate-y-1/2 rounded-full bg-white/30 animate-ping" />
            <motion.span
              key={presence.updated_at}
              aria-hidden="true"
              className="absolute inset-0 rounded-md border border-white/45"
              initial={{ opacity: 0.7, scale: 0.96 }}
              animate={{ opacity: 0, scale: 1.16 }}
              transition={{ duration: 0.42, ease: MOTION_EASE }}
            />
          </>
        )}
        {presence.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={presence.avatar_url} alt="" className="relative size-3.5 rounded-full object-cover" />
        ) : (
          <span className="relative grid size-3.5 place-items-center rounded-full bg-white/20 text-[8px] text-white">
            {initials(presence.name)}
          </span>
        )}
        <span className="relative truncate">{presence.name}</span>
      </span>
    </motion.div>
  );
}

export function AgentCursorStack({
  presence,
  compact,
}: {
  presence?: AgentPresencePayload[];
  compact?: boolean;
}) {
  if (!presence?.length) return null;

  return (
    <>
      <AnimatePresence initial={false}>
        {presence.slice(0, 3).map((item, index) => (
          <AgentCursor key={item.actor_id} presence={item} index={index} compact={compact} />
        ))}
      </AnimatePresence>
      {presence.length > 3 && (
        <span
          className={cn(
            'pointer-events-none absolute right-2 z-20 inline-flex h-6 items-center rounded-md border bg-background/95 px-1.5 text-[11px] font-semibold text-foreground shadow-sm',
            compact ? 'top-10' : 'top-[5.6rem]',
          )}
          data-agent-cursor-overflow={presence.length - 3}
          title={`${presence.length - 3} more active agents on this task`}
        >
          +{presence.length - 3}
        </span>
      )}
    </>
  );
}

export function ParkedAgentDock({ presence }: { presence?: AgentPresencePayload[] }) {
  if (!presence?.length) return null;

  return (
    <div
      className="relative min-h-12 rounded-lg border border-dashed bg-muted/25 px-3 py-2"
      data-agent-cursor-park="true"
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Parked
      </div>
      <div className="relative mt-1 min-h-8">
        <AgentCursorStack presence={presence} compact />
      </div>
    </div>
  );
}
