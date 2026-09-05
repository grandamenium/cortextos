'use client';

// Shared data layer for the Crew surfaces — the dashboard page (/crew)
// and the standalone phone app (/crew-app) render the same roster,
// presence, and moods from this hook so the two can never disagree.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CrewMood } from './crew-critter';
import type { RosterEntry } from './crew-roster';

// Same window as the Active-now strip on /agents.
const ACTIVE_WINDOW_MS = 90_000;
const PRESENCE_POLL_MS = 7000;

export interface CrewMember {
  name: string;
  org: string;
  tagline: string;
  avatarVersion: number | null;
}

interface PresenceEntry {
  name: string;
  typing: boolean;
  lastOutputAt: number | null;
}

function moodOf(p: PresenceEntry | undefined): CrewMood {
  if (!p) return 'resting';
  if (p.typing) return 'typing';
  if (p.lastOutputAt !== null && Date.now() - p.lastOutputAt < ACTIVE_WINDOW_MS) return 'active';
  return 'resting';
}

export interface CrewState {
  user: string;
  agents: CrewMember[];
  roster: RosterEntry[];
  loading: boolean;
  moodFor: (name: string) => CrewMood;
  onAvatarChanged: (name: string, version: number | null) => void;
}

export function useCrew(): CrewState {
  const [user, setUser] = useState('');
  const [agents, setAgents] = useState<CrewMember[]>([]);
  const [presence, setPresence] = useState<Map<string, PresenceEntry>>(new Map());
  const [loading, setLoading] = useState(true);

  // Roster — loaded once; avatar versions update in place after uploads.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/crew');
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        setUser(data.user ?? 'user');
        setAgents(Array.isArray(data.agents) ? data.agents : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Presence — polled while the tab is visible.
  const fetchPresence = useCallback(async () => {
    try {
      const r = await fetch('/api/agents/presence');
      if (!r.ok) return;
      const data = await r.json();
      const map = new Map<string, PresenceEntry>();
      for (const p of data.agents ?? []) map.set(p.name, p);
      setPresence(map);
    } catch {
      /* keep last snapshot */
    }
  }, []);

  useEffect(() => {
    fetchPresence();
    let interval: ReturnType<typeof setInterval> | null = null;
    function start() {
      if (interval === null) interval = setInterval(fetchPresence, PRESENCE_POLL_MS);
    }
    function stop() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') start();
    function onVis() {
      if (document.visibilityState === 'visible') {
        fetchPresence();
        start();
      } else {
        stop();
      }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchPresence]);

  const roster: RosterEntry[] = useMemo(
    () =>
      agents.map((a) => ({
        name: a.name,
        tagline: a.tagline,
        avatarVersion: a.avatarVersion,
        mood: moodOf(presence.get(a.name)),
      })),
    [agents, presence],
  );

  const moodFor = useCallback(
    (name: string) => moodOf(presence.get(name)),
    [presence],
  );

  const onAvatarChanged = useCallback((name: string, version: number | null) => {
    setAgents((prev) => prev.map((a) => (a.name === name ? { ...a, avatarVersion: version } : a)));
  }, []);

  return { user, agents, roster, loading, moodFor, onAvatarChanged };
}
