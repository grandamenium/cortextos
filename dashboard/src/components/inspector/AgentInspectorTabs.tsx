'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = ['chat', 'memory', 'skills', 'mcp', 'files', 'terminal'] as const;

export function AgentInspectorTabs({ agentName }: { agentName: string }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-1 border-b">
      {TABS.map((tab) => {
        const href = `/agents/${encodeURIComponent(agentName)}/${tab}`;
        const active = pathname === href;
        return (
          <Link
            key={tab}
            href={href}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {tab === 'mcp' ? 'MCP' : tab}
          </Link>
        );
      })}
    </nav>
  );
}
