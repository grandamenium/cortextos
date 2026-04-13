'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { IconMessages, IconUsers, IconSearch, IconRefresh, IconArrowsSort } from '@tabler/icons-react';
import { MessageFeed } from '@/components/comms/message-feed';
import { ChannelList } from '@/components/comms/channel-list';
import { ChannelView } from '@/components/comms/channel-view';
import { SearchResults } from '@/components/comms/search-results';

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
}

interface Channel {
  pair: string;
  agents: [string, string];
  last_message: { text: string; timestamp: string; from: string };
  message_count: number;
  last_activity: string;
  archived: boolean;
}

export default function CommsPage() {
  const [feedMessages, setFeedMessages] = useState<BusMessage[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  // Separate search state per tab so they do not bleed into each other.
  const [meetingSearch, setMeetingSearch] = useState('');
  const [channelSearch, setChannelSearch] = useState('');
  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [activeTab, setActiveTab] = useState('meeting-room');
  const [debouncedMeetingSearch, setDebouncedMeetingSearch] = useState('');
  const [knownAgents, setKnownAgents] = useState<Set<string>>(new Set());
  // Sort order — persisted in localStorage. 'asc' = oldest first, newest
  // at bottom (Telegram-like). 'desc' = newest first, oldest at bottom.
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('comms-sort-order');
      if (saved === 'asc' || saved === 'desc') setSortOrder(saved);
    } catch { /* ignore */ }
  }, []);
  function toggleSortOrder() {
    const next = sortOrder === 'asc' ? 'desc' : 'asc';
    setSortOrder(next);
    try { localStorage.setItem('comms-sort-order', next); } catch { /* ignore */ }
  }

  useEffect(() => {
    fetch('/api/agents')
      .then(r => (r.ok ? r.json() : []))
      .then((data: Array<{ name: string }>) => setKnownAgents(new Set(data.map(a => a.name))))
      .catch(() => { /* best-effort */ });
  }, []);

  useEffect(() => {
    if (activeTab === 'channels' && !selectedPair && channels.length > 0) {
      setSelectedPair(channels[0].pair);
    }
  }, [activeTab, selectedPair, channels]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedMeetingSearch(meetingSearch), 400);
    return () => clearTimeout(timer);
  }, [meetingSearch]);

  const fetchData = useCallback(async () => {
    try {
      const searchParam = debouncedMeetingSearch ? `&search=${encodeURIComponent(debouncedMeetingSearch)}` : '';
      const [feedRes, channelsRes] = await Promise.all([
        fetch(`/api/comms/feed?limit=200${searchParam}`),
        fetch(`/api/comms/channels?include_archived=${showArchived}`),
      ]);

      if (feedRes.ok) setFeedMessages(await feedRes.json());
      if (channelsRes.ok) setChannels(await channelsRes.json());
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [debouncedMeetingSearch, showArchived]);

  // Initial fetch + refetch on search/filter changes. Only show the loading
  // skeleton on the very first mount — subsequent fetches (search, archived
  // toggle, 30s poll) replace data in-place without flashing the skeleton.
  const initialFetchDone = useRef(false);
  useEffect(() => {
    if (!initialFetchDone.current) {
      setLoading(true);
      initialFetchDone.current = true;
    }
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  function handleAgentClick(agent: string) {
    const channel = channels.find(ch => ch.agents.includes(agent));
    if (channel) {
      setSelectedPair(channel.pair);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Comms</h1>
        <div className="space-y-4">
          <div className="h-10 w-48 rounded-lg bg-muted/30 animate-pulse" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 rounded-lg bg-muted/30 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Comms</h1>
        <Button variant="ghost" size="sm" onClick={fetchData}>
          <IconRefresh size={14} className="mr-1" />
          Refresh
        </Button>
      </div>

      <Tabs defaultValue="meeting-room" value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="meeting-room">
            <IconMessages size={14} className="mr-1" />
            Meeting Room
          </TabsTrigger>
          <TabsTrigger value="channels">
            <IconUsers size={14} className="mr-1" />
            Active Channels
            {channels.length > 0 && (
              <span className="ml-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">
                {channels.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Meeting Room — org-wide chronological feed */}
        <TabsContent value="meeting-room">
          <div className="space-y-3">
            <div className="flex items-center pt-1">
              <span className="text-xs text-muted-foreground">
                {debouncedMeetingSearch
                  ? `${feedMessages.length} result${feedMessages.length !== 1 ? 's' : ''}`
                  : `${feedMessages.length} message${feedMessages.length !== 1 ? 's' : ''}`}
              </span>
            </div>
            {/* Search bar — matches Knowledge Base pattern */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <IconSearch size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search messages..."
                  value={meetingSearch}
                  onChange={(e) => setMeetingSearch(e.target.value)}
                  className="w-full rounded-md border bg-background pl-9 pr-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30"
                />
              </div>
              <button
                type="button"
                onClick={() => setMeetingSearch('')}
                className={`rounded-md px-4 py-2 text-sm font-medium transition-opacity whitespace-nowrap ${
                  meetingSearch
                    ? 'bg-muted text-foreground hover:bg-muted/80'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}
              >
                {meetingSearch ? 'Clear' : 'Search'}
              </button>
            </div>

            {/* Show search results panel when query is active, feed when not */}
            {debouncedMeetingSearch ? (
              <SearchResults
                messages={feedMessages}
                query={debouncedMeetingSearch}
                onResultClick={(pair) => {
                  setMeetingSearch('');
                  setSelectedPair(pair);
                  setActiveTab('channels');
                }}
              />
            ) : (
              <MessageFeed
                messages={feedMessages}
                onAgentClick={handleAgentClick}
                onMessageClick={(pair) => {
                  setSelectedPair(pair);
                  setActiveTab('channels');
                }}
              />
            )}
          </div>
        </TabsContent>

        {/* Active Channels — per-pair conversation view */}
        <TabsContent value="channels">
          <div className="space-y-2">
            {/* Controls row: archived toggle + channel count + search */}
            <div className="flex items-center gap-3 pt-1">
              <div className="flex items-center gap-2">
                <Switch
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                  id="show-archived"
                />
                <Label htmlFor="show-archived" className="text-xs">
                  Show archived
                </Label>
              </div>
              <span className="text-xs text-muted-foreground">
                {channels.length} channel{channels.length !== 1 ? 's' : ''}
              </span>
            </div>
            {/* Channel search/filter bar — matches KB pattern */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <IconSearch size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter channels..."
                  value={channelSearch}
                  onChange={(e) => setChannelSearch(e.target.value)}
                  className="w-full rounded-md border bg-background pl-9 pr-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30"
                />
              </div>
              <button
                type="button"
                onClick={() => setChannelSearch('')}
                className={`rounded-md px-4 py-2 text-sm font-medium transition-opacity whitespace-nowrap ${
                  channelSearch
                    ? 'bg-muted text-foreground hover:bg-muted/80'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}
              >
                {channelSearch ? 'Clear' : 'Search'}
              </button>
            </div>

            {/* Channel grid: sidebar list + conversation view */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr] h-[calc(100vh-280px)]">
              {/* Channel list with top padding so first card hover does not clip */}
              <div className="overflow-y-auto px-2 pt-3 pb-2">
                <ChannelList
                  channels={channels.filter(ch => {
                    if (!channelSearch.trim()) return true;
                    const q = channelSearch.toLowerCase();
                    return ch.agents.some(a => a.toLowerCase().includes(q));
                  })}
                  selectedPair={selectedPair}
                  onChannelClick={setSelectedPair}
                />
              </div>
              {/* Conversation panel — constrained to viewport height */}
              <div className="flex flex-col min-h-0 rounded-lg border bg-muted/10 overflow-hidden">
                {selectedPair ? (
                  <>
                    {/* Channel header with sort toggle */}
                    <div className="flex items-center justify-between gap-2 px-4 py-3 border-b flex-shrink-0">
                      <span className="text-sm font-medium">
                        {selectedPair.replace('--', ' \u2194 ')}
                      </span>
                      <button
                        type="button"
                        onClick={toggleSortOrder}
                        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        title={sortOrder === 'asc' ? 'Newest at bottom — click to flip' : 'Newest at top — click to flip'}
                      >
                        <IconArrowsSort size={13} />
                        {sortOrder === 'asc' ? 'Newest \u2193' : 'Newest \u2191'}
                      </button>
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <ChannelView pair={selectedPair} knownAgents={knownAgents} sortOrder={sortOrder} />
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                    Select a channel to view conversation
                  </div>
                )}
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
