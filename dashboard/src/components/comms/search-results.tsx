'use client';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TimeAgo } from '@/components/shared';
import { IconArrowRight } from '@tabler/icons-react';

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
}

interface SearchResultsProps {
  messages: BusMessage[];
  query: string;
  onResultClick?: (pair: string, messageId: string) => void;
}

/** Highlight occurrences of `query` in `text` using word-boundary matching. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) {
    return <span>{text}</span>;
  }

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let regex: RegExp;
  try {
    regex = new RegExp(`(\\b${escaped})`, 'gi');
  } catch {
    return <span>{text}</span>;
  }

  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="rounded-sm bg-primary/20 px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

/** Score a message for relevance to the query.
 *  2 = exact whole-word match, 1 = word-start match, 0 = substring only. */
function relevanceScore(text: string, query: string): number {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) return 2;
    if (new RegExp(`\\b${escaped}`, 'i').test(lower)) return 1;
  } catch { /* fall through */ }
  return 0;
}

export function SearchResults({ messages, query, onResultClick }: SearchResultsProps) {
  if (messages.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No messages matching &quot;{query}&quot;
        </p>
      </div>
    );
  }

  // Sort by relevance: exact whole-word matches first, then word-start
  // matches, then everything else. Within each tier, preserve the
  // chronological order from the API (newest first).
  const sorted = [...messages].sort((a, b) => {
    const scoreA = relevanceScore(a.text, query);
    const scoreB = relevanceScore(b.text, query);
    return scoreB - scoreA;
  });

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground px-1">
        {sorted.length} result{sorted.length !== 1 ? 's' : ''}
      </p>
      {sorted.map((msg) => {
        const pair = [msg.from.toLowerCase(), msg.to.toLowerCase()].sort().join('--');
        return (
          <Card
            key={msg.id}
            className="cursor-pointer px-3 py-2.5 transition-colors hover:bg-muted/50"
            onClick={() => onResultClick?.(pair, msg.id)}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold text-foreground">{msg.from}</span>
              <IconArrowRight size={10} className="text-muted-foreground/40" />
              <span className="text-xs font-semibold text-foreground">{msg.to}</span>
              {msg.priority === 'urgent' && (
                <Badge variant="destructive" className="h-3 px-1 text-[8px]">!</Badge>
              )}
              <span className="ml-auto text-[10px] text-muted-foreground tabular-nums shrink-0">
                <TimeAgo date={msg.timestamp} />
              </span>
            </div>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
              <HighlightedText text={msg.text} query={query} />
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground/60">
              {pair.replace('--', ' \u2194 ')}
            </p>
          </Card>
        );
      })}
    </div>
  );
}
