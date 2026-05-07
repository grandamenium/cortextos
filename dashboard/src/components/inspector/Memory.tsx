'use client';

import { useEffect, useState } from 'react';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { MonacoEditor } from '@/components/inspector/MonacoEditor';

type DailyFile = { name: string; path: string; size?: number; modifiedAt?: string };

export function Memory({ agentName }: { agentName: string }) {
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');
  const [daily, setDaily] = useState<DailyFile[]>([]);
  const [status, setStatus] = useState('Loading...');

  async function load(selected?: string) {
    setStatus('Loading...');
    const query = selected ? `?path=${encodeURIComponent(selected)}` : '';
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/memory${query}`);
    const payload = await response.json() as { content: string; path?: string; daily?: DailyFile[] };
    setContent(payload.content || '');
    setPath(payload.path || selected || '');
    if (payload.daily) setDaily(payload.daily);
    setStatus('Loaded');
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [agentName]);

  async function save() {
    setStatus('Saving...');
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/memory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, path: /^\d{4}-\d{2}-\d{2}\.md$/.test(path) ? path : undefined }),
    });
    setStatus(response.ok ? 'Saved' : 'Save failed');
  }

  return (
    <div className="grid min-h-[620px] grid-cols-[240px_1fr] overflow-hidden rounded-lg border bg-card">
      <aside className="border-r p-3">
        <p className="text-xs font-medium uppercase text-muted-foreground">Daily Memory</p>
        <div className="mt-3 space-y-1">
          <button className="w-full rounded-md bg-muted px-2 py-1.5 text-left text-sm" onClick={() => void load()}>
            MEMORY.md
          </button>
          {daily.map((file) => (
            <button key={file.path} className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => void load(file.name)}>
              {file.name.replace(/\.md$/, '')}
            </button>
          ))}
        </div>
      </aside>
      <section className="grid grid-rows-[auto_1fr]">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{path || 'Memory'}</p>
            <p className="text-xs text-muted-foreground">{status}</p>
          </div>
          <Button size="sm" onClick={save}>
            <IconDeviceFloppy size={15} />
            Save
          </Button>
        </div>
        <MonacoEditor value={content} language="markdown" onChange={setContent} />
      </section>
    </div>
  );
}
