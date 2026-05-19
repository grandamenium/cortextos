'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentPresencePayload } from '@/lib/agent-presence';
import { isAgentPresencePayload, presenceTaskId } from '@/lib/agent-presence';

const STREAM_URL = '/api/tasks/presence/stream';
const PRESENCE_TTL_MS = 90_000;
const RECONNECT_DELAY_MS = 3_000;

export function useAgentPresence() {
  const [presence, setPresence] = useState<Record<string, AgentPresencePayload>>({});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let stopped = false;

    function connect() {
      if (stopped) return;
      eventSourceRef.current?.close();

      const source = new EventSource(STREAM_URL);
      eventSourceRef.current = source;

      source.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (!isAgentPresencePayload(parsed)) return;
          setPresence((prev) => ({ ...prev, [parsed.actor_id]: parsed }));
        } catch {
          // Ignore malformed realtime frames.
        }
      };

      source.onerror = () => {
        source.close();
        if (stopped) return;
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    }

    connect();

    const prune = setInterval(() => {
      const cutoff = Date.now() - PRESENCE_TTL_MS;
      setPresence((prev) => {
        const next = Object.fromEntries(
          Object.entries(prev).filter(([, value]) => Date.parse(value.updated_at) >= cutoff),
        );
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 15_000);

    return () => {
      stopped = true;
      clearInterval(prune);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      eventSourceRef.current?.close();
    };
  }, []);

  return useMemo(() => {
    const byTask: Record<string, AgentPresencePayload[]> = {};
    const parked: AgentPresencePayload[] = [];
    for (const item of Object.values(presence)) {
      const taskId = presenceTaskId(item);
      if (!taskId) {
        parked.push(item);
        continue;
      }
      byTask[taskId] = [...(byTask[taskId] ?? []), item];
    }
    for (const items of Object.values(byTask)) {
      items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    parked.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { presence: Object.values(presence), presenceByTask: byTask, parkedPresence: parked };
  }, [presence]);
}
