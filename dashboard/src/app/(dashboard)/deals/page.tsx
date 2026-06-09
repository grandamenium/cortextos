'use client';

import { useEffect, useState, useCallback } from 'react';
import { useOrg } from '@/hooks/use-org';
import { DealPipeline } from '@/components/deals/deal-pipeline';
import { DealStatusBadge } from '@/components/deals/deal-status-badge';
import type { Deal, DealStatus } from '@/lib/types';

const STATUS_FILTERS: { value: DealStatus | 'all'; label: string }[] = [
  { value: 'all',          label: 'All' },
  { value: 'screening',    label: 'Screening' },
  { value: 'underwriting', label: 'Underwriting' },
  { value: 'approved',     label: 'Approved' },
  { value: 'funded',       label: 'Funded' },
  { value: 'closed',       label: 'Closed' },
  { value: 'passed',       label: 'Passed' },
  { value: 'monitoring',   label: 'Monitoring' },
];

export default function DealsPage() {
  const { currentOrg } = useOrg();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<DealStatus | 'all'>('all');

  const fetchDeals = useCallback(async () => {
    const params = new URLSearchParams();
    if (currentOrg && currentOrg !== 'all') params.set('org', currentOrg);
    try {
      const res = await fetch(`/api/deals?${params.toString()}`);
      const data = await res.json();
      setDeals(Array.isArray(data) ? data : []);
    } catch {
      setDeals([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => { fetchDeals(); }, [fetchDeals]);

  const filtered = statusFilter === 'all'
    ? deals
    : deals.filter((d) => d.status === statusFilter);

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Deal Pipeline</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Active deals tracked by Scout and the AtlasOS team
          </p>
        </div>
        <button
          onClick={fetchDeals}
          className="rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 flex-wrap">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === f.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {f.label}
            {f.value !== 'all' && (
              <span className="ml-1 opacity-60">
                {deals.filter((d) => d.status === f.value).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          Loading deals...
        </div>
      ) : deals.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          No deals found.
        </div>
      ) : (
        <DealPipeline deals={filtered} />
      )}
    </div>
  );
}
