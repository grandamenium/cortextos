import { Card } from '@/components/ui/card';

export default function ContentPipelineLoading() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Content Pipeline</h1>
        <p className="text-sm text-muted-foreground mt-1">Loading...</p>
      </div>

      <div className="grid grid-cols-4 gap-6">
        <div className="col-span-3">
          <Card className="p-6 space-y-4">
            <div className="h-8 bg-muted rounded animate-pulse"></div>
            {[1, 2, 3].map(i => (
              <div key={i} className="h-32 bg-muted rounded animate-pulse"></div>
            ))}
          </Card>
        </div>
        <div>
          <Card className="p-6 space-y-4">
            <div className="h-8 bg-muted rounded animate-pulse"></div>
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-20 bg-muted rounded animate-pulse"></div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
