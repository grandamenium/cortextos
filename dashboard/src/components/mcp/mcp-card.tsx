'use client';

import { Badge } from '@/components/ui/badge';
import { IconExternalLink, IconBrandPython, IconBrandNodejs } from '@tabler/icons-react';

export interface McpInfo {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  sourcePath: string | null;
  sourceUrl: string | null;
  version: string | null;
  language: 'node' | 'python' | 'unknown';
  mountedBy: Array<{ org: string; agent: string }>;
}

function LangIcon({ language }: { language: McpInfo['language'] }) {
  if (language === 'python')
    return <IconBrandPython size={14} className="text-amber-400" aria-hidden="true" />;
  if (language === 'node')
    return <IconBrandNodejs size={14} className="text-emerald-400" aria-hidden="true" />;
  return null;
}

export function McpCard({ mcp }: { mcp: McpInfo }) {
  const isMounted = mcp.mountedBy.length > 0;

  return (
    <div className="rounded-xl border bg-card p-4 flex flex-col gap-3 min-h-[170px]">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <LangIcon language={mcp.language} />
            <h3 className="font-mono text-sm font-semibold truncate">{mcp.name}</h3>
            {mcp.version && (
              <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                v{mcp.version}
              </span>
            )}
          </div>
          {mcp.sourceUrl ? (
            <a
              href={mcp.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mt-0.5 truncate"
            >
              <IconExternalLink size={10} aria-hidden="true" />
              <span className="truncate">{mcp.sourceUrl.replace(/^https?:\/\//, '')}</span>
            </a>
          ) : mcp.sourcePath ? (
            <p className="text-[11px] font-mono text-muted-foreground truncate mt-0.5">
              {mcp.sourcePath}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground mt-0.5">no local source</p>
          )}
        </div>
        <Badge
          variant={isMounted ? 'default' : 'secondary'}
          className="shrink-0 text-[10px]"
        >
          {isMounted ? `mounted on ${mcp.mountedBy.length}` : 'unmounted'}
        </Badge>
      </div>

      {mcp.mountedBy.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {mcp.mountedBy.map((m) => (
            <span
              key={`${m.org}/${m.agent}`}
              className="text-[10px] font-mono bg-muted/50 px-1.5 py-0.5 rounded border"
              title={`${m.org}/${m.agent}`}
            >
              {m.agent}
            </span>
          ))}
        </div>
      )}

      {mcp.envKeys.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap pt-1 border-t border-border/40">
          <span className="text-[10px] text-muted-foreground">env:</span>
          {mcp.envKeys.slice(0, 6).map((k) => (
            <span
              key={k}
              className="text-[10px] font-mono text-muted-foreground bg-muted/30 px-1.5 py-0 rounded"
            >
              {k}
            </span>
          ))}
          {mcp.envKeys.length > 6 && (
            <span className="text-[10px] text-muted-foreground">
              +{mcp.envKeys.length - 6}
            </span>
          )}
        </div>
      )}

      <div className="mt-auto pt-1 border-t border-border/40">
        <code className="text-[10px] font-mono text-muted-foreground line-clamp-2">
          {mcp.command} {mcp.args.join(' ')}
        </code>
      </div>
    </div>
  );
}
