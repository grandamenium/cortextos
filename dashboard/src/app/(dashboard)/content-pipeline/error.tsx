'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Content Pipeline</h1>
        <p className="text-sm text-muted-foreground mt-1">Error loading dashboard</p>
      </div>

      <div className="rounded-lg border border-red-200 bg-red-50 p-6 space-y-4">
        <h2 className="font-semibold text-red-900">Something went wrong</h2>
        <p className="text-sm text-red-800">{error.message}</p>
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
      </div>
    </div>
  );
}
