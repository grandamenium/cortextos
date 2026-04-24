'use client';

import { useEffect } from 'react';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function CommsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Comms error:', error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <div className="rounded-full bg-destructive/10 p-4">
            <IconAlertTriangle size={32} className="text-destructive" />
          </div>
          <h2 className="text-xl font-semibold">Failed to load comms</h2>
          <p className="text-muted-foreground text-sm">
            {error.message || 'Could not load the communications hub.'}
          </p>
          <Button onClick={reset} variant="outline" className="gap-2">
            <IconRefresh size={16} />
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
