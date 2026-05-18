'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EventFeed, type EventFeedFilters } from '@/components/activity/event-feed';
import { ActivityFilters } from '@/components/activity/activity-filters';
import type { Event } from '@/lib/types';

interface ActivityPageClientProps {
  initialEvents: Event[];
  agents: string[];
  orgs: string[];
}

export function ActivityPageClient({
  initialEvents,
  agents,
  orgs,
}: ActivityPageClientProps) {
  const [filters, setFilters] = useState<EventFeedFilters>({
    types: [],
    agent: '',
    org: '',
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Real-time event stream from all agents.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ActivityFilters
            filters={filters}
            onFiltersChange={setFilters}
            agents={agents}
            orgs={orgs}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
          <EventFeed initialEvents={initialEvents} filters={filters} />
        </CardContent>
      </Card>
    </div>
  );
}
