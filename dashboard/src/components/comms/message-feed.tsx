'use client';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
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

interface MessageFeedProps {
  messages: BusMessage[];
  onAgentClick?: (agent: string) => void;
  onMessageClick?: (pair: string) => void;
}

export function MessageFeed({ messages, onAgentClick, onMessageClick }: MessageFeedProps) {
  if (messages.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No messages yet. Agent communication will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {messages.map((msg) => (
        <Card
          key={msg.id}
          className="cursor-pointer p-4 transition-colors hover:bg-muted/50"
          onClick={() => {
            const pair = [msg.from.toLowerCase(), msg.to.toLowerCase()].sort().join('--');
            onMessageClick?.(pair);
          }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-sm font-semibold text-foreground">{msg.from}</span>
            <IconArrowRight size={12} className="text-muted-foreground/40" />
            <span className="text-sm font-semibold text-foreground">{msg.to}</span>
            {msg.priority === 'urgent' && (
              <Badge className="text-[9px] h-4 px-1.5 font-semibold border-0" style={{ backgroundColor: 'rgba(142,20,41,0.12)', color: '#8E1429' }}>
                urgent
              </Badge>
            )}
            <TimeAgo date={msg.timestamp} className="ml-auto text-[11px] text-muted-foreground tabular-nums shrink-0" />
          </div>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words line-clamp-3">{msg.text}</p>
        </Card>
      ))}
    </div>
  );
}
