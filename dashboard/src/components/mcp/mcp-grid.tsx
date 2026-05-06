'use client';

import { useCallback, useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { McpCard, type McpInfo } from './mcp-card';

export function McpGrid() {
  const [mcps, setMcps] = useState<McpInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp');
      if (!res.ok) {
        setMcps([]);
      } else {
        const data = (await res.json()) as McpInfo[];
        setMcps(data);
      }
    } catch {
      setMcps([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-44 rounded-xl bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }

  if (mcps.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
        <p>No MCP servers found across any agents.</p>
        <p className="text-xs mt-1">
          MCPs are read from <code className="font-mono">orgs/&lt;org&gt;/agents/&lt;agent&gt;/.mcp.json</code>
        </p>
      </div>
    );
  }

  const mounted = mcps.filter((m) => m.mountedBy.length > 0);
  const orphans = mcps.filter((m) => m.mountedBy.length === 0);

  return (
    <Tabs defaultValue="all">
      <TabsList>
        <TabsTrigger value="all">All ({mcps.length})</TabsTrigger>
        <TabsTrigger value="mounted">Mounted ({mounted.length})</TabsTrigger>
        {orphans.length > 0 && (
          <TabsTrigger value="orphans">Unmounted ({orphans.length})</TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="all">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
          {mcps.map((m) => (
            <McpCard key={m.name} mcp={m} />
          ))}
        </div>
      </TabsContent>

      <TabsContent value="mounted">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
          {mounted.map((m) => (
            <McpCard key={m.name} mcp={m} />
          ))}
        </div>
      </TabsContent>

      {orphans.length > 0 && (
        <TabsContent value="orphans">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
            {orphans.map((m) => (
              <McpCard key={m.name} mcp={m} />
            ))}
          </div>
        </TabsContent>
      )}
    </Tabs>
  );
}
