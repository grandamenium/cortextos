'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconSend, IconPhoto, IconX, IconMicrophone } from '@tabler/icons-react';

// Polling cadence for the visible-tab live feed. Paused when the tab is
// backgrounded so inactive dashboards do not accumulate network traffic.
const POLL_MS = 2000;

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
  /** Optional: set by the channel API when the message origin is a voice note. */
  media_type?: string;
}

interface ChannelViewProps {
  pair: string;
  /** Set of known agent names in the fleet — used to determine whether the
   *  channel is a user-to-agent channel (which gets the chat bar) or an
   *  agent-to-agent channel (which does not). */
  knownAgents?: Set<string>;
  /** Sort order for messages. 'asc' = oldest first, newest at bottom
   *  (default). 'desc' = newest first, oldest at bottom. */
  sortOrder?: 'asc' | 'desc';
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}

// Inline image rendering: if the message text contains a /api/media/ URL
// matching an image extension, render it as an inline <img> instead of
// leaving it as a raw link. Enables the paste-image flow where the sender
// attached a pasted screenshot and the URL was appended to the message body.
const IMAGE_URL_PATTERN = /\/api\/media\/[^\s]+\.(?:png|jpg|jpeg|gif|webp)/gi;

function MessageContent({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(IMAGE_URL_PATTERN)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      const before = text.slice(lastIndex, idx).trim();
      if (before) parts.push(<p key={`t-${lastIndex}`} className="whitespace-pre-wrap break-words">{before}</p>);
    }
    parts.push(
      <a key={`i-${idx}`} href={match[0]} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={match[0]}
          alt="Shared image"
          className="mt-1 mb-1 max-h-64 max-w-full rounded-md"
          loading="lazy"
        />
      </a>
    );
    lastIndex = idx + match[0].length;
  }

  if (lastIndex < text.length) {
    const after = text.slice(lastIndex).trim();
    if (after) parts.push(<p key={`t-${lastIndex}`} className="whitespace-pre-wrap break-words">{after}</p>);
  }

  if (parts.length === 0) {
    return <p className="whitespace-pre-wrap break-words">{text}</p>;
  }

  return <>{parts}</>;
}

export function ChannelView({ pair, knownAgents, sortOrder = 'asc' }: ChannelViewProps) {
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachPreview, setAttachPreview] = useState<string | null>(null);
  const agents = pair.split('--');
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);


  // Track whether the next scroll should force-anchor to the bottom. Set
  // true on channel switch or after the user sends a message, so those
  // actions always land the viewport at the newest content.
  const forceScrollRef = useRef(true);
  // Track whether the user is "pinned" to the bottom of the scroll
  // container. Updated on every scroll event so the value reflects the
  // state BEFORE new messages are rendered. The poll-update scroll path
  // reads this instead of measuring post-render distance, which would
  // be wrong because new messages increase scrollHeight before the
  // check runs.
  const pinnedRef = useRef(true);

  // Detect if this is a user-to-agent channel. Only user-to-agent channels
  // get the chat bar — agent-to-agent channels are observational only.
  const isUserChannel = knownAgents
    ? knownAgents.size > 0 && agents.some(a => !knownAgents.has(a))
    : false;
  const targetAgent = knownAgents
    ? agents.find(a => knownAgents.has(a)) || agents[1]
    : agents[1];

  const fetchMessages = useCallback(async () => {
    try {
      const r = await fetch(`/api/comms/channel/${pair}?limit=200`);
      const data: BusMessage[] = r.ok ? await r.json() : [];
      setMessages(data);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [pair]);

  // Channel switch — reset state and fetch fresh.
  useEffect(() => {
    setLoading(true);
    setMessages([]);
    forceScrollRef.current = true;
    fetchMessages();
  }, [pair, fetchMessages]);

  // Sort order change — re-anchor without refetching.
  useEffect(() => {
    forceScrollRef.current = true;
  }, [sortOrder]);

  // Live 2s polling — paused when the tab is backgrounded so inactive
  // dashboards do not accumulate network traffic.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (interval !== null) return;
      interval = setInterval(fetchMessages, POLL_MS);
    }
    function stop() {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    }

    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      start();
    }

    function onVisChange() {
      if (document.visibilityState === 'visible') {
        fetchMessages();
        start();
      } else {
        stop();
      }
    }

    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [pair, fetchMessages]);

  // Track pin state from WHEEL events only — not scroll events. When
  // React re-renders the message list, the DOM nodes get replaced and
  // the scroll position can shift by hundreds of pixels. This triggers
  // scroll events that look like "user scrolled up" but are actually
  // just React layout shifts. Wheel events only fire on real mouse
  // wheel input, so they reliably distinguish user scrolling from
  // programmatic/layout-induced position changes.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function onWheel() {
      // Check pin state shortly after the wheel event settles.
      setTimeout(() => {
        if (!container) return;
        if (sortOrder === 'asc') {
          const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
          pinnedRef.current = dist < 50;
        } else {
          pinnedRef.current = container.scrollTop < 50;
        }
      }, 150);
    }

    container.addEventListener('wheel', onWheel, { passive: true });
    return () => container.removeEventListener('wheel', onWheel);
  }, [sortOrder, loading]);

  // Auto-scroll: simple interval that pins the viewport to the bottom.
  // Every 400ms, if the user is pinned (or force-scroll is requested),
  // scroll to the bottom. Reads scrollRef.current inside the callback
  // (not at effect creation time) so it picks up the real container
  // after the loading state resolves and the DOM mounts.
  useEffect(() => {
    const iv = setInterval(() => {
      const container = scrollRef.current;
      if (!container) return;

      if (forceScrollRef.current || pinnedRef.current) {
        if (sortOrder === 'asc') {
          container.scrollTop = container.scrollHeight;
        } else {
          container.scrollTop = 0;
        }
        if (forceScrollRef.current) {
          forceScrollRef.current = false;
          pinnedRef.current = true;
        }
      }
    }, 400);

    return () => clearInterval(iv);
  }, [sortOrder]);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    applyAttachment(file);
  }

  function applyAttachment(file: File) {
    setAttachment(file);
    const url = URL.createObjectURL(file);
    setAttachPreview(url);
    setSendError('');
  }

  function clearAttachment() {
    setAttachment(null);
    if (attachPreview) URL.revokeObjectURL(attachPreview);
    setAttachPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // Clipboard paste: scan for image types and attach the first one found.
  // Text paste still works normally (the paste event is not prevented unless
  // an image is found).
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          applyAttachment(file);
          return;
        }
      }
    }
  }

  async function handleSend() {
    // Ref-based in-flight lock — see comment on sendingRef above.
    if (sendingRef.current) return;
    if (!draft.trim() && !attachment) return;
    sendingRef.current = true;
    setSending(true);
    setSendError('');
    try {
      let messageText = draft.trim();

      if (attachment) {
        const formData = new FormData();
        formData.append('file', attachment);
        const uploadRes = await fetch('/api/comms/upload', { method: 'POST', body: formData });
        if (!uploadRes.ok) {
          const data = await uploadRes.json().catch(() => ({}));
          setSendError(data.error || 'Upload failed');
          return;
        }
        const { url } = await uploadRes.json();
        messageText = messageText ? `${messageText}\n${url}` : url;
      }

      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: targetAgent, text: messageText }),
      });
      if (res.ok) {
        setDraft('');
        clearAttachment();
        // Force-scroll after sending so the user's own message is
        // immediately visible at the bottom.
        forceScrollRef.current = true;
        setTimeout(fetchMessages, 300);
      } else {
        const data = await res.json().catch(() => ({}));
        setSendError(data.error || 'Failed to send');
      }
    } catch {
      setSendError('Network error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  // Sort messages for rendering. The `messages` array is always stored
  // in ascending order (oldest first). Reverse for desc display.
  const sortedMessages = sortOrder === 'desc' ? [...messages].reverse() : messages;

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    // Full-height chat. The parent (comms page grid) constrains the
    // available height. This component fills it with a flex column:
    // messages scroll, chat bar sticks to the bottom.
    <div className="flex h-full min-h-0 flex-col">
      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 min-h-0 space-y-3 overflow-y-auto px-3 py-3">
        {sortedMessages.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No messages in this channel.</div>
        ) : (
          sortedMessages.map((msg) => {
            const isFirst = msg.from === agents[0];
            const isVoice = msg.media_type === 'voice';
            return (
              <div
                key={msg.id}
                className={`flex ${isFirst ? 'justify-start' : 'justify-end'}`}
              >
                <div
                  className={`max-w-[75%] rounded-xl border px-3 py-2 text-sm shadow-sm ${
                    isFirst
                      ? 'rounded-bl-sm bg-muted/60 border-border/50'
                      : 'rounded-br-sm bg-primary/10 border-primary/20'
                  }`}
                >
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{msg.from}</span>
                    {isVoice && (
                      <IconMicrophone size={11} className="text-muted-foreground" aria-label="voice message" />
                    )}
                    {msg.priority === 'urgent' && (
                      <Badge variant="destructive" className="h-3 px-1 text-[8px]">!</Badge>
                    )}
                  </div>
                  <MessageContent text={msg.text} />
                  <p className="mt-1 text-right text-[10px] text-muted-foreground">
                    {formatTime(msg.timestamp)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Chat input — rendered only for user-to-agent channels. Agent-to-agent
          channels are read-only so no chat bar, matching the conversation
          semantics (users can message agents, agents message via the bus). */}
      {isUserChannel && (
        <div className="border-t bg-background p-2">
          {sendError && (
            <p className="mb-1 px-1 text-xs text-destructive">{sendError}</p>
          )}
          {attachPreview && (
            <div className="relative mb-2 inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachPreview} alt="Attachment preview" className="max-h-24 rounded-md border" />
              <button
                onClick={clearAttachment}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground shadow-sm hover:bg-destructive/90"
                aria-label="Remove attachment"
              >
                <IconX size={12} />
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={handleFileSelect}
            />
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 self-end"
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
              aria-label="Attach image"
            >
              <IconPhoto size={16} />
            </Button>
            <textarea
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setSendError(''); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              onPaste={handlePaste}
              placeholder={`Message ${targetAgent}...`}
              rows={1}
              className="min-h-[36px] max-h-[120px] flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30"
              onInput={(e) => {
                // Auto-grow the textarea as the user types, capped at 120px.
                const el = e.target as HTMLTextAreaElement;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px';
              }}
            />
            <Button
              size="sm"
              onClick={handleSend}
              disabled={(!draft.trim() && !attachment) || sending}
              className="shrink-0 self-end"
              aria-label="Send message"
            >
              <IconSend size={14} className={sending ? 'animate-pulse' : ''} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
