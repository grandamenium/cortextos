'use client';

import { useEffect, useState } from 'react';
import { IconDeviceFloppy, IconFile, IconFolder } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { MonacoEditor } from '@/components/inspector/MonacoEditor';

type FileEntry = { name: string; path: string; type: 'file' | 'folder'; children?: FileEntry[] };

function languageFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'js' || ext === 'jsx') return 'javascript';
  if (ext === 'md' || ext === 'mdx') return 'markdown';
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'css') return 'css';
  if (ext === 'html') return 'html';
  if (ext === 'py') return 'python';
  return 'plaintext';
}

function Tree({ entries, onOpen, level = 0 }: { entries: FileEntry[]; onOpen: (path: string, type: FileEntry['type']) => void; level?: number }) {
  return (
    <div>
      {entries.map((entry) => (
        <div key={entry.path}>
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted" style={{ paddingLeft: 8 + level * 12 }} onClick={() => onOpen(entry.path, entry.type)}>
            {entry.type === 'folder' ? <IconFolder size={15} /> : <IconFile size={15} />}
            <span className="truncate">{entry.name}</span>
          </button>
          {entry.children ? <Tree entries={entry.children} onOpen={onOpen} level={level + 1} /> : null}
        </div>
      ))}
    </div>
  );
}

export function Files({ agentName }: { agentName: string }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [root, setRoot] = useState('');
  const [filePath, setFilePath] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('Loading...');

  async function loadTree(path?: string) {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/files${query}`);
    const payload = await response.json() as { root: string; entries?: FileEntry[]; path?: string; content?: string };
    setRoot(payload.root || root);
    if (payload.entries) setEntries(payload.entries);
    if (payload.content !== undefined) {
      setContent(payload.content);
      setFilePath(payload.path || path || '');
    }
    setStatus('Loaded');
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadTree(), 0);
    return () => window.clearTimeout(timeout);
  }, [agentName]);

  async function open(path: string, type: FileEntry['type']) {
    if (type === 'folder') return loadTree(path);
    return loadTree(path);
  }

  async function save() {
    setStatus('Saving...');
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/files`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });
    setStatus(response.ok ? 'Saved' : 'Save failed');
  }

  return (
    <div className="grid min-h-[620px] grid-cols-[300px_1fr] overflow-hidden rounded-lg border bg-card">
      <aside className="overflow-y-auto border-r p-2">
        <p className="break-all px-2 py-2 font-mono text-[11px] text-muted-foreground">{root}</p>
        <Tree entries={entries} onOpen={open} />
      </aside>
      <section className="grid grid-rows-[auto_1fr]">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{filePath || 'Select a file'}</p>
            <p className="text-xs text-muted-foreground">{status}</p>
          </div>
          <Button size="sm" onClick={save} disabled={!filePath}>
            <IconDeviceFloppy size={15} />
            Save
          </Button>
        </div>
        <MonacoEditor value={content} language={languageFor(filePath)} onChange={setContent} />
      </section>
    </div>
  );
}
