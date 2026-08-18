'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  IconArrowLeft,
  IconMicrophone,
  IconPhoto,
  IconPaint,
  IconSend,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '@tabler/icons-react';
import { CrewAvatar } from './crew-avatar';
import { CrewCritter, type CrewMood } from './crew-critter';
import { AvatarUpload } from './avatar-upload';
import { useVoiceRecorder, formatElapsed } from './voice-recorder';

// Same cadence discipline as the comms channel view: poll only while the
// tab is visible, at a gentle interval — the fleet writes messages on a
// 1s inbox check so 5s freshness feels live without hammering the API.
const POLL_MS = 5000;

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
  media_type?: string;
}

export interface CrewChatAgent {
  name: string;
  tagline: string;
  avatarVersion: number | null;
}

interface CrewChatProps {
  agent: CrewChatAgent;
  /** Canonical user identity — the non-agent side of the pair key. */
  user: string;
  mood: CrewMood;
  onBack?: () => void;
  onAvatarChanged: (version: number | null) => void;
  /** Standalone-app mode: edge-to-edge, no card chrome. */
  frameless?: boolean;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function relativeSince(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'moments ago';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Inline rendering for /api/media image links (paste-image flow) — same
// pattern the comms channel view uses.
const IMAGE_URL_PATTERN = /\/api\/media\/[^\s]+\.(?:png|jpg|jpeg|gif|webp)/gi;

function MessageContent({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(IMAGE_URL_PATTERN)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      const before = text.slice(lastIndex, idx).trim();
      if (before) {
        parts.push(
          <p key={`t-${lastIndex}`} className="whitespace-pre-wrap break-words">{before}</p>,
        );
      }
    }
    parts.push(
      <a key={`i-${idx}`} href={match[0]} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={match[0]} alt="Shared image" className="mt-1 mb-1 max-h-64 max-w-full rounded-xl" loading="lazy" />
      </a>,
    );
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    const after = text.slice(lastIndex).trim();
    if (after) {
      parts.push(<p key={`t-${lastIndex}`} className="whitespace-pre-wrap break-words">{after}</p>);
    }
  }
  if (parts.length === 0) return <p className="whitespace-pre-wrap break-words">{text}</p>;
  return <>{parts}</>;
}

export function CrewChat({ agent, user, mood, onBack, onAvatarChanged, frameless = false }: CrewChatProps) {
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachPreview, setAttachPreview] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [ttsOn, setTtsOn] = useState(false);
  const spokenIdsRef = useRef<Set<string>>(new Set());
  // Ids of messages WE delivered to the server this session, so the merge
  // can keep them until the server copy shows up — then drop the local one.
  const localIdsRef = useRef<Set<string>>(new Set());
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const recorder = useVoiceRecorder();
  const sendingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const forceScrollRef = useRef(true);
  const pinnedRef = useRef(true);

  const pair = [user, agent.name].sort().join('--');
  const typing = mood === 'typing';

  const statusText = typing
    ? 'typing…'
    : mood === 'active'
      ? 'active now'
      : 'resting';

  const fetchMessages = useCallback(async () => {
    try {
      const r = await fetch(`/api/comms/channel/${pair}?limit=200`);
      const data: BusMessage[] = r.ok ? await r.json() : [];
      // Merge by id so an optimistic just-sent bubble is replaced, not
      // duplicated, when the server catches up.
      setMessages((prev) => {
        const ids = new Set(data.map((m) => m.id));
        const pending = prev.filter((m) => localIdsRef.current.has(m.id) && !ids.has(m.id));
        for (const m of data) localIdsRef.current.delete(m.id);
        return [...data, ...pending];
      });
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [pair]);

  // Agent switch — reset and refetch.
  useEffect(() => {
    setLoading(true);
    setMessages([]);
    forceScrollRef.current = true;
    fetchMessages();
  }, [pair, fetchMessages]);

  // Voice-replies preference, per agent. Switching agents also silences
  // any in-flight speech and resets the spoken-message ledger.
  useEffect(() => {
    try {
      setTtsOn(localStorage.getItem(`crew-tts-${agent.name}`) === '1');
    } catch {
      /* ignore */
    }
    spokenIdsRef.current = new Set();
    return () => {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [agent.name]);

  // Read new agent replies aloud when voice replies are on. Messages that
  // were already on screen (or arrive while the toggle is off) are marked
  // spoken silently so enabling TTS never replays history.
  useEffect(() => {
    const spoken = spokenIdsRef.current;
    if (!ttsOn || loading) {
      for (const m of messages) spoken.add(m.id);
      return;
    }
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    for (const m of messages) {
      if (spoken.has(m.id)) continue;
      spoken.add(m.id);
      if (m.from !== agent.name || !synth) continue;
      const clean = m.text
        .replace(IMAGE_URL_PATTERN, '')
        .replace(/https?:\/\/\S+/g, 'link')
        .trim();
      if (!clean) continue;
      const u = new SpeechSynthesisUtterance(clean);
      if (voiceRef.current) u.voice = voiceRef.current;
      synth.speak(u);
    }
  }, [messages, ttsOn, loading, agent.name]);

  // Pick the best system voice for spoken replies. iOS only exposes its
  // Siri-quality voices to the web AFTER the user downloads one (Settings →
  // Accessibility → Spoken Content → Voices), so re-score on voiceschanged.
  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) return;
    function score(v: SpeechSynthesisVoice): number {
      let sc = 0;
      if (/premium/i.test(v.name)) sc += 8;
      if (/enhanced/i.test(v.name)) sc += 6;
      if (/siri/i.test(v.name)) sc += 5;
      const lang = (v.lang || '').toLowerCase();
      if (lang === 'en-au') sc += 3;
      else if (lang === 'en-gb') sc += 2;
      else if (lang.startsWith('en')) sc += 1;
      if (v.localService) sc += 1;
      return sc;
    }
    function pick() {
      const en = synth!.getVoices().filter((v) => (v.lang || '').toLowerCase().startsWith('en'));
      voiceRef.current = en.sort((a, b) => score(b) - score(a))[0] ?? null;
    }
    pick();
    synth.addEventListener('voiceschanged', pick);
    return () => synth.removeEventListener('voiceschanged', pick);
  }, []);

  function speak(text: string) {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      const u = new SpeechSynthesisUtterance(text);
      if (voiceRef.current) u.voice = voiceRef.current;
      synth.speak(u);
    } catch {
      /* ignore */
    }
  }

  function toggleTts() {
    const next = !ttsOn;
    setTtsOn(next);
    try {
      localStorage.setItem(`crew-tts-${agent.name}`, next ? '1' : '0');
    } catch {
      /* ignore */
    }
    // Speaking inside the tap gesture both confirms the toggle and
    // unlocks speech synthesis on iOS.
    if (next) speak('Voice replies on');
    else {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  // Visible-tab polling.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    function start() {
      if (interval === null) interval = setInterval(fetchMessages, POLL_MS);
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
        fetchMessages();
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
  }, [fetchMessages]);

  // Pin tracking from wheel/touch input only — React re-renders shift
  // scroll positions and would otherwise look like user scrolling.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    function measure() {
      setTimeout(() => {
        if (!container) return;
        const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
        pinnedRef.current = dist < 60;
      }, 150);
    }
    container.addEventListener('wheel', measure, { passive: true });
    container.addEventListener('touchmove', measure, { passive: true });
    return () => {
      container.removeEventListener('wheel', measure);
      container.removeEventListener('touchmove', measure);
    };
  }, [loading]);

  // Auto-scroll: keep the viewport pinned to the newest message.
  useEffect(() => {
    const iv = setInterval(() => {
      const container = scrollRef.current;
      if (!container) return;
      if (forceScrollRef.current || pinnedRef.current) {
        container.scrollTop = container.scrollHeight;
        if (forceScrollRef.current) {
          forceScrollRef.current = false;
          pinnedRef.current = true;
        }
      }
    }, 400);
    return () => clearInterval(iv);
  }, []);

  function applyAttachment(file: File) {
    setAttachment(file);
    setAttachPreview(URL.createObjectURL(file));
    setSendError('');
  }

  function clearAttachment() {
    setAttachment(null);
    if (attachPreview) URL.revokeObjectURL(attachPreview);
    setAttachPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

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
        body: JSON.stringify({ agent: agent.name, text: messageText }),
      });
      if (res.ok) {
        const sent = await res.json().catch(() => ({}));
        const realId = sent.messageId ?? `local-${Date.now()}`;
        localIdsRef.current.add(realId);
        // Local bubble under the server's own id — the merge drops it the
        // moment the server copy appears, so it can never show twice.
        setMessages((prev) => [
          ...prev,
          {
            id: realId,
            from: user,
            to: agent.name,
            priority: 'normal',
            timestamp: new Date().toISOString(),
            text: messageText,
            reply_to: null,
          },
        ]);
        setDraft('');
        clearAttachment();
        forceScrollRef.current = true;
        setTimeout(fetchMessages, 500);
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

  async function sendVoice() {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError('');
    const blob = await recorder.stop();
    if (!blob || blob.size === 0) {
      sendingRef.current = false;
      setSending(false);
      return;
    }
    try {
      const form = new FormData();
      form.append('agent', agent.name);
      form.append('file', blob, 'voice');
      const res = await fetch('/api/crew/voice', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSendError(data.error || 'Failed to send voice message');
        return;
      }
      const realId = data.messageId ?? `local-${Date.now()}`;
      localIdsRef.current.add(realId);
      setMessages((prev) => [
        ...prev,
        {
          id: realId,
          from: user,
          to: agent.name,
          priority: 'normal',
          timestamp: new Date().toISOString(),
          text: data.transcript || '[voice message]',
          reply_to: null,
          media_type: 'voice',
        },
      ]);
      forceScrollRef.current = true;
      setTimeout(fetchMessages, 500);
    } catch {
      setSendError('Network error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-hidden bg-background ${
        frameless ? '' : 'rounded-xl border'
      }`}
    >
      {/* Companion header */}
      <div
        className={`flex items-center gap-3 border-b px-3 py-2.5 ${
          frameless ? 'bg-background/85 backdrop-blur' : 'bg-muted/20'
        }`}
      >
        {onBack && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onBack} aria-label="Back to crew">
            <IconArrowLeft size={18} />
          </Button>
        )}
        <CrewAvatar name={agent.name} version={agent.avatarVersion} mood={mood} size={44} ring />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{agent.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {typing ? (
              <span className="text-emerald-500">{statusText}</span>
            ) : mood === 'active' ? (
              <span className="text-emerald-600 dark:text-emerald-400">{statusText}</span>
            ) : (
              statusText
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className={`shrink-0 ${ttsOn ? 'text-emerald-500' : 'text-muted-foreground'}`}
          onClick={toggleTts}
          title={ttsOn ? 'Voice replies on — tap to mute' : 'Read replies aloud'}
          aria-label={ttsOn ? 'Turn off voice replies' : 'Turn on voice replies'}
        >
          {ttsOn ? <IconVolume size={17} /> : <IconVolumeOff size={17} />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground"
          onClick={() => setUploadOpen(true)}
          title="Change character art"
          aria-label="Change character art"
        >
          <IconPaint size={17} />
        </Button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 space-y-2.5 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : messages.length === 0 && !typing ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="h-28 w-28">
              {agent.avatarVersion !== null ? (
                <CrewAvatar name={agent.name} version={agent.avatarVersion} mood={mood} size={112} />
              ) : (
                <CrewCritter name={agent.name} mood={mood} className="h-full w-full" />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Say hi to <span className="font-medium text-foreground">{agent.name}</span> — they check
              their inbox every second.
            </p>
          </div>
        ) : (
          <>
            {messages.map((msg) => {
              const fromAgent = msg.from === agent.name;
              return (
                <div key={msg.id} className={`flex items-end gap-2 ${fromAgent ? 'justify-start' : 'justify-end'}`}>
                  {fromAgent && (
                    <CrewAvatar name={agent.name} version={agent.avatarVersion} mood="active" size={26} className="mb-4" />
                  )}
                  <div
                    className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                      fromAgent
                        ? 'rounded-bl-md border border-border/60 bg-muted/50'
                        : 'rounded-br-md bg-primary text-primary-foreground'
                    }`}
                  >
                    {msg.media_type === 'voice' && (
                      <span
                        className={`mb-0.5 flex items-center gap-1 text-[10px] ${
                          fromAgent ? 'text-muted-foreground' : 'text-primary-foreground/70'
                        }`}
                      >
                        <IconMicrophone size={11} aria-hidden /> voice
                      </span>
                    )}
                    <MessageContent text={msg.text} />
                    <p
                      className={`mt-0.5 text-right text-[10px] ${
                        fromAgent ? 'text-muted-foreground' : 'text-primary-foreground/70'
                      }`}
                    >
                      {formatTime(msg.timestamp)}
                    </p>
                  </div>
                </div>
              );
            })}
            {typing && (
              <div className="flex items-end gap-2 justify-start">
                <CrewAvatar name={agent.name} version={agent.avatarVersion} mood="typing" size={26} className="mb-1" />
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-border/60 bg-muted/50 px-3.5 py-3">
                  <span className="crew-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                  <span className="crew-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                  <span className="crew-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Chat bar */}
      <div className="border-t bg-background p-2">
        {(sendError || recorder.error) && (
          <p className="mb-1 px-1 text-xs text-destructive">{sendError || recorder.error}</p>
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
        {recorder.recording ? (
          <div className="flex items-center gap-3 px-1">
            <span className="crew-antenna-pulse h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" aria-hidden />
            <span className="text-sm font-medium tabular-nums text-foreground">
              {formatElapsed(recorder.elapsed)}
            </span>
            <span className="flex-1 truncate text-xs text-muted-foreground">
              Recording for {agent.name}…
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => recorder.cancel()}
              aria-label="Discard recording"
              title="Discard recording"
            >
              <IconX size={16} />
            </Button>
            <Button
              size="sm"
              className="rounded-full"
              onClick={sendVoice}
              disabled={sending}
              aria-label="Send voice message"
              title="Send voice message"
            >
              <IconSend size={16} />
            </Button>
          </div>
        ) : (
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) applyAttachment(f);
            }}
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
            onChange={(e) => {
              setDraft(e.target.value);
              setSendError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            onPaste={handlePaste}
            placeholder={`Message ${agent.name}…`}
            rows={1}
            className="max-h-32 min-h-9 flex-1 resize-none rounded-2xl border bg-muted/30 px-3.5 py-2 text-base outline-none focus:border-primary/50 md:text-sm"
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 self-end"
            onClick={() => recorder.start()}
            disabled={sending}
            title="Record a voice message"
            aria-label="Record a voice message"
          >
            <IconMicrophone size={16} />
          </Button>
          <Button
            size="sm"
            className="shrink-0 self-end rounded-full"
            onClick={handleSend}
            disabled={sending || (!draft.trim() && !attachment)}
            aria-label="Send"
          >
            <IconSend size={16} />
          </Button>
        </div>
        )}
      </div>

      <AvatarUpload
        agent={agent.name}
        hasAvatar={agent.avatarVersion !== null}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSaved={onAvatarChanged}
      />
    </div>
  );
}
