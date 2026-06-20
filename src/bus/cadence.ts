/**
 * Cadence-Engine — aggregates and debounces escalation messages.
 *
 * Provides SO-6 mechanical enforcement for the user-proxy cadence rules:
 * - 5-minute aggregation window: coalesce same-topic events into 1 message
 * - 30-minute debounce per topic: suppress re-alert within 30 min
 * - 2-consecutive rule: CI-fail alerts only after 2+ fails in a row
 *
 * State lives in: ~/.cortextos/<instance>/state/<agent>/cadence-state.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

export interface CadenceEvent {
  id: string;
  topic: string;
  message: string;
  agent: string;
  severity: 'info' | 'warning' | 'urgent' | 'critical';
  timestamp: string;
  chat_id?: string;
}

export interface TopicDebounce {
  last_sent: string;
  consecutive_count: number;
}

export interface CadenceState {
  queue: CadenceEvent[];
  debounce: Record<string, TopicDebounce>;
  last_flush: string;
}

export interface FlushResult {
  messages: Array<{
    chat_id: string;
    text: string;
    events: CadenceEvent[];
  }>;
  suppressed: Array<{ event: CadenceEvent; reason: string }>;
}

const DEBOUNCE_MS = 30 * 60 * 1000;   // 30 minutes
const CONSECUTIVE_THRESHOLD = 2;       // CI-fail topics need 2+ before alert
const CI_TOPIC_PATTERN = /ci.fail|build.fail|test.fail/i;

function loadState(stateDir: string): CadenceState {
  const path = join(stateDir, 'cadence-state.json');
  if (!existsSync(path)) return { queue: [], debounce: {}, last_flush: '' };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { queue: [], debounce: {}, last_flush: '' };
  }
}

function saveState(stateDir: string, state: CadenceState): void {
  mkdirSync(stateDir, { recursive: true });
  atomicWriteSync(join(stateDir, 'cadence-state.json'), JSON.stringify(state, null, 2));
}

export function enqueueEscalation(
  stateDir: string,
  event: Omit<CadenceEvent, 'id' | 'timestamp'>,
): void {
  const state = loadState(stateDir);
  const ts = new Date().toISOString();
  const id = `ce_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state.queue.push({ ...event, id, timestamp: ts });

  // Track consecutive count per topic
  const db = state.debounce[event.topic] || { last_sent: '', consecutive_count: 0 };
  db.consecutive_count += 1;
  state.debounce[event.topic] = db;

  saveState(stateDir, state);
}

export function flushQueue(stateDir: string, defaultChatId: string): FlushResult {
  const state = loadState(stateDir);
  const now = Date.now();
  const result: FlushResult = { messages: [], suppressed: [] };

  if (state.queue.length === 0) {
    return result;
  }

  // Group queue by (chat_id, topic)
  const grouped = new Map<string, CadenceEvent[]>();
  for (const ev of state.queue) {
    const key = `${ev.chat_id || defaultChatId}::${ev.topic}`;
    const group = grouped.get(key) || [];
    group.push(ev);
    grouped.set(key, group);
  }

  const processed: string[] = [];

  for (const [key, events] of grouped.entries()) {
    const [chatId, topic] = key.split('::');
    const db = state.debounce[topic] || { last_sent: '', consecutive_count: 0 };

    // URGENT/CRITICAL always bypass debounce and aggregation (SO-3: L×I≥12)
    const hasUrgent = events.some(e => e.severity === 'urgent' || e.severity === 'critical');

    if (!hasUrgent) {
      // Debounce: suppress if sent recently
      if (db.last_sent) {
        const msSinceSent = now - new Date(db.last_sent).getTime();
        if (msSinceSent < DEBOUNCE_MS) {
          for (const ev of events) {
            result.suppressed.push({
              event: ev,
              reason: `debounce: last sent ${Math.round(msSinceSent / 60000)}min ago (<30min)`,
            });
          }
          processed.push(...events.map(e => e.id));
          continue;
        }
      }
    }

    // CI-fail consecutive check
    if (CI_TOPIC_PATTERN.test(topic) && db.consecutive_count < CONSECUTIVE_THRESHOLD) {
      for (const ev of events) {
        result.suppressed.push({
          event: ev,
          reason: `ci-consecutive: ${db.consecutive_count}/${CONSECUTIVE_THRESHOLD} failures (need 2+ before alert)`,
        });
      }
      processed.push(...events.map(e => e.id));
      continue;
    }

    // Build batched message
    const maxSeverity = events.reduce((max, ev) => {
      const order: Record<string, number> = { info: 0, warning: 1, urgent: 2, critical: 3 };
      return (order[ev.severity] || 0) > (order[max] || 0) ? ev.severity : max;
    }, 'info' as string);

    let text: string;
    if (events.length === 1) {
      text = `[${maxSeverity.toUpperCase()}] ${events[0].message} (from ${events[0].agent})`;
    } else {
      const lines = events.map(e => `• ${e.message} (${e.agent})`).join('\n');
      text = `[${maxSeverity.toUpperCase()}] ${events.length}x ${topic} in 5min:\n${lines}`;
    }

    result.messages.push({ chat_id: chatId, text, events });
    processed.push(...events.map(e => e.id));

    // Update debounce timestamp + reset consecutive count
    state.debounce[topic] = {
      last_sent: new Date().toISOString(),
      consecutive_count: 0,
    };
  }

  // Remove processed events from queue
  state.queue = state.queue.filter(e => !processed.includes(e.id));
  state.last_flush = new Date().toISOString();
  saveState(stateDir, state);

  return result;
}

export function getCadenceStatus(stateDir: string): {
  queueLength: number;
  topics: string[];
  debounceState: Record<string, TopicDebounce>;
  lastFlush: string;
} {
  const state = loadState(stateDir);
  return {
    queueLength: state.queue.length,
    topics: [...new Set(state.queue.map(e => e.topic))],
    debounceState: state.debounce,
    lastFlush: state.last_flush,
  };
}
