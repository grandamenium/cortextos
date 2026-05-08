'use client';

import { useEffect, useRef, useState } from 'react';
import { IconPlayerPlay, IconX } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

type XTerm = {
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  open(element: HTMLElement): void;
  dispose(): void;
};

export function Terminal({ agentName }: { agentName: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [log, setLog] = useState('');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('No session');
  const [xtermReady, setXtermReady] = useState(false);

  async function send(data: string) {
    if (!sessionId) return;
    await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/terminal/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, data }),
    });
  }

  async function start() {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/terminal/session`, { method: 'POST' });
    const payload = await response.json() as { sessionId: string; cwd: string };
    setSessionId(payload.sessionId);
    setStatus(payload.cwd);
  }

  async function close() {
    if (sessionId) {
      await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/terminal/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    }
    termRef.current?.dispose();
    termRef.current = null;
    setSessionId('');
    setStatus('No session');
    setXtermReady(false);
  }

  useEffect(() => {
    if (!sessionId) return;
    const events = new EventSource(`/api/agents/${encodeURIComponent(agentName)}/inspector/terminal/stream?sessionId=${encodeURIComponent(sessionId)}`);
    events.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { chunk: string };
      termRef.current?.write(payload.chunk);
      setLog((current) => current + payload.chunk);
    };
    return () => events.close();
  }, [agentName, sessionId]);

  useEffect(() => {
    if (!sessionId || !hostRef.current || termRef.current) return;
    let disposed = false;
    void (async () => {
      try {
        const importer = Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;
        const mod = await importer('xterm');
        if (disposed || !hostRef.current) return;
        const TerminalCtor = mod.Terminal as new (options: Record<string, unknown>) => XTerm;
        const term = new TerminalCtor({ cursorBlink: true, convertEol: true, fontSize: 13 });
        term.open(hostRef.current);
        term.onData((data) => void send(data));
        termRef.current = term;
        setXtermReady(true);
      } catch {
        setStatus((current) => `${current} - xterm unavailable, using fallback input`);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [sessionId]);

  return (
    <div className="grid min-h-[620px] grid-rows-[auto_1fr_auto] overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <p className="truncate font-mono text-xs text-muted-foreground">{status}</p>
        <div className="flex gap-2">
          <Button size="sm" onClick={start} disabled={Boolean(sessionId)}>
            <IconPlayerPlay size={15} />
            Start
          </Button>
          <Button size="sm" variant="outline" onClick={close} disabled={!sessionId}>
            <IconX size={15} />
            Close
          </Button>
        </div>
      </div>
      <div ref={hostRef} className="overflow-auto bg-black p-3 font-mono text-sm text-green-100">
        {!xtermReady && <pre className="whitespace-pre-wrap">{log}</pre>}
      </div>
      <form className="flex gap-2 border-t p-3" onSubmit={(event) => {
        event.preventDefault();
        void send(`${input}\n`);
        setInput('');
      }}>
        <input value={input} onChange={(event) => setInput(event.target.value)} className="h-9 flex-1 rounded-md border bg-background px-3 font-mono text-sm" placeholder="Fallback terminal input" disabled={!sessionId} />
        <Button type="submit" disabled={!sessionId}>Send</Button>
      </form>
    </div>
  );
}
