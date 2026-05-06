export const dynamic = 'force-dynamic';

import { McpGrid } from '@/components/mcp/mcp-grid';

export default function McpPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">MCP Servers</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Model Context Protocol servers configured across this org&apos;s agents.
          Read-only view of <code className="text-xs font-mono">.mcp.json</code> at each agent&apos;s project root.
        </p>
      </div>

      <McpGrid />
    </div>
  );
}
