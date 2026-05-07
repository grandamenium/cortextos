'use client';

import { useEffect, useState } from 'react';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

type Server = { name: string; command: string; args: string[]; disabled: boolean; status: 'running' | 'disabled' };

export function Mcp({ agentName }: { agentName: string }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [config, setConfig] = useState('');
  const [status, setStatus] = useState('Loading...');

  async function load() {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/mcp`);
    const payload = await response.json() as { servers: Server[]; config: string };
    setServers(payload.servers || []);
    setConfig(payload.config || '');
    setStatus('Loaded');
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [agentName]);

  async function toggle(server: Server) {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/mcp`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: server.name, disabled: !server.disabled }),
    });
    const payload = await response.json() as { servers?: Server[] };
    if (payload.servers) setServers(payload.servers);
    setStatus(response.ok ? 'Saved. Restart Hermes for changes to take effect.' : 'Update failed');
  }

  async function saveConfig() {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/inspector/mcp`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    setStatus(response.ok ? 'Saved. Restart Hermes for changes to take effect.' : 'Save failed');
    if (response.ok) void load();
  }

  return (
    <div className="grid min-h-[620px] grid-cols-[1fr_420px] overflow-hidden rounded-lg border bg-card">
      <section className="overflow-y-auto p-4">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">MCP Servers</h2>
          <p className="text-sm text-muted-foreground">{status}</p>
        </div>
        <div className="space-y-2">
          {servers.map((server) => (
            <div key={server.name} className="flex items-center justify-between rounded-lg border p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{server.name}</p>
                  <Badge variant={server.disabled ? 'secondary' : 'default'}>{server.status}</Badge>
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground">{[server.command, ...server.args].join(' ')}</p>
              </div>
              <Switch checked={!server.disabled} onCheckedChange={() => void toggle(server)} />
            </div>
          ))}
          {servers.length === 0 && <p className="text-sm text-muted-foreground">No MCP servers configured.</p>}
        </div>
      </section>
      <aside className="grid grid-rows-[auto_1fr] border-l">
        <div className="flex items-center justify-between border-b p-3">
          <p className="text-sm font-medium">config.yaml</p>
          <Button size="sm" onClick={saveConfig}>
            <IconDeviceFloppy size={15} />
            Save
          </Button>
        </div>
        <textarea value={config} onChange={(event) => setConfig(event.target.value)} className="h-full resize-none bg-background p-3 font-mono text-xs outline-none" spellCheck={false} />
      </aside>
    </div>
  );
}
