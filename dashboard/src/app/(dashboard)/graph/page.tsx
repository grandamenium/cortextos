import { GraphLoader } from '@/components/graph/graph-loader';

export default function GraphPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Code Graph</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Interactive dependency graph of the codebase. Hover to explore connections, scroll to zoom, drag to pan.
        </p>
      </div>

      <GraphLoader />
    </div>
  );
}
