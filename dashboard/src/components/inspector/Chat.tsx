'use client';

import { ChangeEvent, DragEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  IconBrain,
  IconChevronDown,
  IconFiles,
  IconMicrophone,
  IconPaperclip,
  IconPinned,
  IconPinnedOff,
  IconPlus,
  IconSend,
  IconTrash,
  IconTool,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useDashboardSettings } from '@/lib/dashboard-settings';

type ChatRole = 'user' | 'assistant' | 'system';

type ToolCall = {
  id?: string;
  name: string;
  input: unknown;
  output?: unknown;
};

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown };

type ChatMessage = {
  role: ChatRole;
  content: string | ContentBlock[];
  tools?: ToolCall[];
  thinking?: string;
};

type SessionSummary = {
  key: string;
  id?: string;
  title?: string;
  name?: string;
  agent?: string;
  updatedAt?: string;
  updated_at?: string;
  pinned?: boolean;
};

type Attachment = {
  name: string;
  mediaType: string;
  data: string;
  kind: 'image' | 'file';
};

const SLASH_COMMANDS = [
  ['/new', 'Start a new session'],
  ['/clear', 'Clear the current screen'],
  ['/model', 'Show model command'],
  ['/save', 'Persist this session'],
  ['/skills', 'Open skills tab'],
  ['/skin', 'Open theme settings'],
  ['/help', 'Show commands'],
] as const;

function asText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((block) => block.type === 'text' ? block.text : '').join('');
}

function extractStructured(content: ChatMessage['content']) {
  const tools: ToolCall[] = [];
  const thinking: string[] = [];
  if (!Array.isArray(content)) return { tools, thinking: '' };
  for (const block of content) {
    if (block.type === 'thinking') thinking.push(block.thinking ?? block.text ?? '');
    if (block.type === 'tool_use') tools.push({ id: block.id, name: block.name ?? 'tool', input: block.input ?? {} });
    if (block.type === 'tool_result') {
      const tool = tools.find((item) => item.id && item.id === block.tool_use_id) ?? tools[tools.length - 1];
      if (tool) tool.output = block.content;
    }
  }
  return { tools, thinking: thinking.filter(Boolean).join('\n') };
}

function extractDelta(payload: Record<string, unknown>): { content: string; thinking: string; tools: ToolCall[] } {
  const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
  const delta = choices[0]?.delta as Record<string, unknown> | undefined;
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  const source = delta ?? message ?? payload;
  const rawContent = source.content;
  const structured = extractStructured(rawContent as ChatMessage['content']);
  const content = typeof rawContent === 'string' ? rawContent : asText(rawContent as ChatMessage['content']);
  const thinking = typeof source.thinking === 'string' ? source.thinking : structured.thinking;
  const toolCalls = [
    ...(Array.isArray(source.tool_calls) ? source.tool_calls : []),
    ...(Array.isArray(source.tool_use) ? source.tool_use : []),
    ...structured.tools,
  ];
  const tools = toolCalls.map((item) => {
    const record = item as Record<string, unknown>;
    const fn = record.function as Record<string, unknown> | undefined;
    return {
      id: typeof record.id === 'string' ? record.id : undefined,
      name: String(record.name ?? fn?.name ?? record.type ?? 'tool'),
      input: record.input ?? fn?.arguments ?? record,
      output: record.output ?? record.result,
    };
  });
  return { content, thinking, tools };
}

async function fileToAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const [, data = ''] = dataUrl.split(',');
  return {
    name: file.name,
    mediaType: file.type || 'application/octet-stream',
    data,
    kind: file.type.startsWith('image/') ? 'image' : 'file',
  };
}

function buildAnthropicContent(text: string, attachments: Attachment[]) {
  const blocks: unknown[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data } });
    } else {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data }, name: attachment.name });
    }
  }
  return blocks;
}

export function Chat({ agentName }: { agentName: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const slashRef = useRef<HTMLDivElement | null>(null);
  const settings = useDashboardSettings();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<string>('');
  const [sessionSearch, setSessionSearch] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [listening, setListening] = useState(false);
  const [contextUsage, setContextUsage] = useState<{ used?: number; limit?: number; percent?: number }>({});

  const apiPath = useMemo(
    () => `/api/agents/${encodeURIComponent(agentName)}/inspector/chat`,
    [agentName],
  );
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1).toLowerCase() : null;
  const filteredCommands = slashQuery === null ? [] : SLASH_COMMANDS.filter(([command, description]) => `${command} ${description}`.toLowerCase().includes(slashQuery));

  async function refreshSessions(q = sessionSearch) {
    const params = new URLSearchParams({ agent: agentName });
    if (q) params.set('q', q);
    const response = await fetch(`/api/hermes/sessions?${params.toString()}`);
    const data = await response.json();
    const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
    setSessions(nextSessions);
    if (!activeSession && nextSessions[0]?.key) setActiveSession(nextSessions[0].key);
  }

  useEffect(() => {
    refreshSessions().catch(() => undefined);
    function onNewChat() {
      void createSession();
    }
    window.addEventListener('cortextos:new-chat', onNewChat);
    return () => window.removeEventListener('cortextos:new-chat', onNewChat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName]);

  useEffect(() => {
    if (!activeSession) return;
    fetch(`/api/hermes/sessions/${encodeURIComponent(activeSession)}/history`)
      .then((res) => res.json())
      .then((data) => {
        const history = Array.isArray(data.messages) ? data.messages : [];
        setMessages(history.map((message: Record<string, unknown>) => ({
          role: message.role === 'user' || message.role === 'system' ? message.role : 'assistant',
          content: typeof message.content === 'string' || Array.isArray(message.content) ? message.content : String(message.text ?? ''),
        })));
      })
      .catch(() => setMessages([]));
  }, [activeSession]);

  useEffect(() => {
    if (!activeSession) return;
    fetch(`/api/hermes/context-usage?sessionKey=${encodeURIComponent(activeSession)}`)
      .then((res) => res.json())
      .then((data) => setContextUsage({
        used: Number(data.used_tokens ?? data.used ?? 0),
        limit: Number(data.max_tokens ?? data.limit ?? 0),
        percent: Number(data.percent ?? data.usage_percent ?? 0),
      }))
      .catch(() => setContextUsage({}));
  }, [activeSession, messages.length]);

  async function createSession() {
    const response = await fetch('/api/hermes/sessions', {
      method: 'POST',
      body: JSON.stringify({ agent: agentName, title: `New ${agentName} chat` }),
    });
    const data = await response.json().catch(() => ({}));
    const key = data.key ?? data.id ?? `local-${Date.now()}`;
    setActiveSession(String(key));
    setMessages([]);
    await refreshSessions();
  }

  async function mutateSession(action: string, sessionKey: string, patch: Record<string, unknown> = {}) {
    await fetch('/api/hermes/sessions', {
      method: action === 'delete' ? 'DELETE' : 'PATCH',
      body: JSON.stringify({ action, sessionKey, key: sessionKey, agent: agentName, ...patch }),
    }).catch(() => undefined);
    await refreshSessions();
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;
    if (await runSlashCommand(text)) return;

    const displayText = text || attachments.map((item) => `[${item.name}]`).join('\n');
    const outgoingContent = attachments.length > 0 ? buildAnthropicContent(text, attachments) : text;
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: displayText }, { role: 'assistant', content: '', tools: [] }];
    setMessages(nextMessages);
    setInput('');
    setAttachments([]);
    setStreaming(true);
    setError('');

    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          sessionKey: activeSession,
          messages: [...messages, { role: 'user', content: outgoingContent }].map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      if (!response.ok || !response.body) throw new Error(`Chat failed (${response.status})`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((entry) => entry.startsWith('data: '));
          if (!line) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          const delta = extractDelta(JSON.parse(raw) as Record<string, unknown>);
          setMessages((current) => {
            const copy = [...current];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = {
              ...last,
              content: asText(last.content) + delta.content,
              thinking: [last.thinking, delta.thinking].filter(Boolean).join('\n'),
              tools: [...(last.tools ?? []), ...delta.tools],
            };
            return copy;
          });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
      void refreshSessions();
    }
  }

  async function runSlashCommand(text: string) {
    const command = text.split(/\s+/, 1)[0];
    if (!SLASH_COMMANDS.some(([item]) => item === command)) return false;
    setInput('');
    if (command === '/new') await createSession();
    if (command === '/clear') setMessages([]);
    if (command === '/skills') router.push(`/agents/${encodeURIComponent(agentName)}/skills`);
    if (command === '/skin') window.dispatchEvent(new CustomEvent('cortextos:open-settings'));
    if (command === '/model') setMessages((current) => [...current, { role: 'system', content: 'Model selection is handled by the active Hermes provider.' }]);
    if (command === '/save') await mutateSession('save', activeSession);
    if (command === '/help') setMessages((current) => [...current, { role: 'system', content: SLASH_COMMANDS.map(([cmd, desc]) => `${cmd} - ${desc}`).join('\n') }]);
    return true;
  }

  async function onFiles(files: FileList | File[]) {
    const next = await Promise.all(Array.from(files).map(fileToAttachment));
    setAttachments((current) => [...current, ...next]);
  }

  function startVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('SpeechRecognition is not available in this browser.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? '').join(' ');
      setInput((current) => `${current}${current ? ' ' : ''}${transcript}`.trim());
    };
    recognition.start();
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    if (event.dataTransfer.files.length) void onFiles(event.dataTransfer.files);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
    if (event.key === 'Escape' && slashQuery !== null) setInput('');
  }

  const contextPercent = contextUsage.percent || (contextUsage.used && contextUsage.limit ? Math.round((contextUsage.used / contextUsage.limit) * 100) : 0);
  const warning = contextPercent >= settings.usageThreshold;

  return (
    <div className="grid min-h-[calc(100vh-8rem)] overflow-hidden rounded-lg border bg-card md:grid-cols-[18rem_1fr]">
      <aside className="hidden border-r bg-muted/20 md:flex md:flex-col">
        <div className="border-b p-3">
          <div className="mb-2 flex items-center gap-2">
            <Button size="sm" onClick={createSession}><IconPlus size={14} /> New</Button>
            <Button size="sm" variant="outline" onClick={() => void refreshSessions()}><IconChevronDown size={14} /> Refresh</Button>
          </div>
          <Input value={sessionSearch} onChange={(event) => { setSessionSearch(event.target.value); void refreshSessions(event.target.value); }} placeholder="Search sessions" className="h-8" />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.map((session) => {
            const key = session.key ?? session.id ?? '';
            const title = session.title ?? session.name ?? key;
            return (
              <button key={key} onClick={() => setActiveSession(key)} className={cn('mb-1 w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted', activeSession === key && 'bg-primary/10 text-primary')}>
                <span className="block truncate font-medium">{title}</span>
                <span className="block truncate text-xs text-muted-foreground">{session.updatedAt ?? session.updated_at ?? 'No timestamp'}</span>
              </button>
            );
          })}
        </div>
        {activeSession && (
          <div className="flex items-center gap-1 border-t p-2">
            <Button size="icon" variant="ghost" title="Rename" onClick={() => {
              const title = window.prompt('Session name');
              if (title) void mutateSession('rename', activeSession, { title });
            }}>Aa</Button>
            <Button size="icon" variant="ghost" title="Pin" onClick={() => void mutateSession('pin', activeSession)}>
              {sessions.find((session) => session.key === activeSession)?.pinned ? <IconPinnedOff size={15} /> : <IconPinned size={15} />}
            </Button>
            <Button size="icon" variant="ghost" title="Fork" onClick={() => void mutateSession('fork', activeSession)}><IconFiles size={15} /></Button>
            <Button size="icon" variant="ghost" title="Delete" onClick={() => void mutateSession('delete', activeSession)}><IconTrash size={15} /></Button>
          </div>
        )}
      </aside>

      <section className="grid min-h-[620px] grid-rows-[auto_1fr_auto] overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-2">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{agentName} chat</h1>
            <p className="truncate text-xs text-muted-foreground">{activeSession || 'No session selected'}</p>
          </div>
          <Badge variant={warning ? 'destructive' : 'secondary'}>
            Context {contextPercent || 0}%
          </Badge>
        </header>

        <div className="space-y-3 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Start a runtime-scoped chat with {agentName}.
            </div>
          ) : messages.map((message, index) => (
            <MessageBubble key={index} message={message} streaming={streaming && index === messages.length - 1} />
          ))}
        </div>

        <form onSubmit={submit} onDrop={onDrop} onDragOver={(event) => event.preventDefault()} className="border-t p-3">
          {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((attachment, index) => (
                <Badge key={`${attachment.name}-${index}`} variant="secondary" className="gap-1">
                  {attachment.name}
                  <button type="button" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                </Badge>
              ))}
            </div>
          )}
          <div className="relative flex gap-2">
            {slashQuery !== null && filteredCommands.length > 0 && (
              <div ref={slashRef} className="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 w-72 overflow-hidden rounded-md border bg-popover shadow-md">
                {filteredCommands.map(([command, description]) => (
                  <button key={command} type="button" onClick={() => { setInput(command); void runSlashCommand(command); }} className="block w-full px-3 py-2 text-left hover:bg-muted">
                    <span className="block text-sm font-semibold">{command}</span>
                    <span className="text-xs text-muted-foreground">{description}</span>
                  </button>
                ))}
              </div>
            )}
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => event.target.files && void onFiles(event.target.files)} />
            <Button type="button" size="icon" variant="outline" onClick={() => fileInputRef.current?.click()} aria-label="Attach file"><IconPaperclip size={16} /></Button>
            <Button type="button" size="icon" variant={listening ? 'default' : 'outline'} onMouseDown={startVoice} aria-label="Voice input"><IconMicrophone size={16} /></Button>
            <Textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Message this agent or type /" className="min-h-14 resize-none text-base md:text-sm" onKeyDown={onComposerKeyDown} />
            <Button type="submit" size="icon" disabled={streaming || (!input.trim() && attachments.length === 0)} aria-label="Send"><IconSend size={16} /></Button>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Drop images or files to attach.</span>
            <Link href={`/agents/${encodeURIComponent(agentName)}/skills`} className="hover:text-foreground">Skills</Link>
          </div>
        </form>
      </section>
    </div>
  );
}

function MessageBubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const structured = extractStructured(message.content);
  const text = asText(message.content);
  const thinking = message.thinking || structured.thinking;
  const tools = [...(message.tools ?? []), ...structured.tools];
  return (
    <div className={message.role === 'user' ? 'ml-auto max-w-[86%] md:max-w-[78%]' : 'mr-auto max-w-[92%] md:max-w-[84%]'}>
      <div className={cn('rounded-lg px-3 py-2 text-sm', message.role === 'user' ? 'bg-primary text-primary-foreground' : message.role === 'system' ? 'bg-accent text-accent-foreground' : 'bg-muted')}>
        {thinking && (
          <Collapsible className="mb-2 rounded-md border bg-background/50">
            <CollapsibleTrigger className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground">
              <IconBrain size={13} /> Thinking...
            </CollapsibleTrigger>
            <CollapsibleContent className="whitespace-pre-wrap px-2 pb-2 text-xs text-muted-foreground">{thinking}</CollapsibleContent>
          </Collapsible>
        )}
        <div className="whitespace-pre-wrap">{text || (streaming ? '...' : '')}</div>
        {tools.map((tool, toolIndex) => <ToolChip key={`${tool.name}-${toolIndex}`} tool={tool} />)}
      </div>
    </div>
  );
}

function ToolChip({ tool }: { tool: ToolCall }) {
  return (
    <Collapsible className="mt-2 rounded-md border bg-background/70">
      <CollapsibleTrigger className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium">
        <IconTool size={13} />
        {tool.name}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <JsonBlock label="Input" value={tool.input} />
        {tool.output !== undefined && <JsonBlock label="Output" value={tool.output} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const [html, setHtml] = useState('');
  const json = useMemo(() => typeof value === 'string' ? value : JSON.stringify(value, null, 2), [value]);
  useEffect(() => {
    let cancelled = false;
    const loadShiki = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ codeToHtml: (code: string, options: { lang: string; theme: string }) => Promise<string> }>;
    loadShiki('shiki')
      .then(({ codeToHtml }) => codeToHtml(json, { lang: 'json', theme: 'github-dark' }))
      .then((nextHtml) => { if (!cancelled) setHtml(nextHtml); })
      .catch(() => { if (!cancelled) setHtml(''); });
    return () => { cancelled = true; };
  }, [json]);
  return (
    <div className="border-t">
      <div className="px-2 pt-2 text-[10px] uppercase text-muted-foreground">{label}</div>
      {html ? <div className="max-h-56 overflow-auto p-2 text-[11px]" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="max-h-56 overflow-auto p-2 text-[11px]">{json}</pre>}
    </div>
  );
}

declare global {
  type SpeechRecognitionEventLike = {
    results: ArrayLike<ArrayLike<{ transcript: string }>>;
  };
  type SpeechRecognitionLike = {
    continuous: boolean;
    interimResults: boolean;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onerror: (() => void) | null;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    start: () => void;
  };
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}
