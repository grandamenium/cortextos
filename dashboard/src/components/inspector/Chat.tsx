'use client';

import { FormEvent, useMemo, useState } from 'react';
import { IconSend, IconTool } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

type ChatRole = 'user' | 'assistant' | 'system';

type ToolCall = {
  name: string;
  input: unknown;
};

type ChatMessage = {
  role: ChatRole;
  content: string;
  tools?: ToolCall[];
};

function extractDelta(payload: Record<string, unknown>): { content: string; tools: ToolCall[] } {
  const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
  const delta = choices[0]?.delta as Record<string, unknown> | undefined;
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  const source = delta ?? message ?? payload;
  const content = typeof source.content === 'string' ? source.content : '';
  const toolCalls = Array.isArray(source.tool_calls) ? source.tool_calls : Array.isArray(source.tool_use) ? source.tool_use : [];
  const tools = toolCalls.map((item) => {
    const record = item as Record<string, unknown>;
    const fn = record.function as Record<string, unknown> | undefined;
    return {
      name: String(record.name ?? fn?.name ?? record.type ?? 'tool'),
      input: record.input ?? fn?.arguments ?? record,
    };
  });
  return { content, tools };
}

export function Chat({ agentName }: { agentName: string }) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');

  const apiPath = useMemo(
    () => `/api/agents/${encodeURIComponent(agentName)}/inspector/chat`,
    [agentName],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: text }, { role: 'assistant', content: '', tools: [] }];
    setMessages(nextMessages);
    setInput('');
    setStreaming(true);
    setError('');

    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          messages: nextMessages.slice(0, -1).map((message) => ({ role: message.role, content: message.content })),
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
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const delta = extractDelta(parsed);
          setMessages((current) => {
            const copy = [...current];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = {
              ...last,
              content: last.content + delta.content,
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
    }
  }

  return (
    <div className="grid min-h-[620px] grid-rows-[1fr_auto] overflow-hidden rounded-lg border bg-card">
      <div className="space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Start a runtime-scoped chat with {agentName}.
          </div>
        ) : messages.map((message, index) => (
          <div key={index} className={message.role === 'user' ? 'ml-auto max-w-[78%]' : 'mr-auto max-w-[84%]'}>
            <div className={`rounded-lg px-3 py-2 text-sm ${message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
              <div className="whitespace-pre-wrap">{message.content || (streaming && index === messages.length - 1 ? '...' : '')}</div>
              {message.tools?.map((tool, toolIndex) => (
                <Collapsible key={`${tool.name}-${toolIndex}`} className="mt-2 rounded-md border bg-background/70">
                  <CollapsibleTrigger className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium">
                    <IconTool size={13} />
                    {tool.name}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="max-h-44 overflow-auto p-2 text-[11px]">{JSON.stringify(tool.input, null, 2)}</pre>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="border-t p-3">
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Message this agent"
            className="min-h-14 resize-none"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button type="submit" size="icon" disabled={streaming || !input.trim()} aria-label="Send">
            <IconSend size={16} />
          </Button>
        </div>
      </form>
    </div>
  );
}
