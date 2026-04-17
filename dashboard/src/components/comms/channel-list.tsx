'use client';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TimeAgo } from '@/components/shared';

interface Channel {
  pair: string;
  agents: [string, string];
  last_message: { text: string; timestamp: string; from: string };
  message_count: number;
  last_activity: string;
  archived: boolean;
}

interface ChannelListProps {
  channels: Channel[];
  selectedPair: string | null;
  onChannelClick: (pair: string) => void;
}

export function ChannelList({ channels, selectedPair, onChannelClick }: ChannelListProps) {
  if (channels.length === 0) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        No channels yet
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {channels.map((ch) => (
        <Card
          key={ch.pair}
          className={`interactive-card p-3 ${
            selectedPair === ch.pair ? 'bg-primary/5 border-primary/30' : ''
          } ${ch.archived ? 'opacity-60' : ''}`}
          onClick={() => onChannelClick(ch.pair)}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {ch.agents[0]} ↔ {ch.agents[1]}
              </p>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {ch.last_message.from}: {ch.last_message.text}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <TimeAgo date={ch.last_activity} className="text-[10px]" />
              <Badge variant="outline" className="text-[9px]">
                {ch.message_count}
              </Badge>
              {ch.archived && (
                <Badge variant="secondary" className="text-[9px]">
                  archived
                </Badge>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
