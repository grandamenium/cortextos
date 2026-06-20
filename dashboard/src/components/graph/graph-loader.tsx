'use client';

import dynamic from 'next/dynamic';

const CodeGraph = dynamic(
  () => import('@/components/graph/code-graph').then((m) => m.CodeGraph),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[600px] items-center justify-center rounded-lg border bg-card">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading graph renderer...</p>
        </div>
      </div>
    ),
  }
);

export function GraphLoader() {
  return <CodeGraph />;
}
