'use client';

import { useEffect, useState, useCallback } from 'react';
import { useOrg } from '@/hooks/use-org';
import {
  IconHome,
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconExternalLink,
} from '@tabler/icons-react';

interface PropertyUnit {
  name: string;
  status: 'occupied' | 'vacant';
  rent: number | null;
  tenant: string | null;
  notes?: string;
}

interface PropertyNeed {
  item: string;
  vendor?: string;
  cost: number | null;
  status: string;
  priority: string;
  notes?: string;
}

interface BalanceOwed {
  to: string;
  amount: number | null;
  reason: string;
  status: string;
  notes?: string;
}

interface PastOrder {
  date: string;
  item: string;
  vendor: string;
  cost: number | null;
}

interface Property {
  id: string;
  name: string;
  city: string;
  state: string;
  owner: string;
  entity: string;
  manager?: string;
  type: string;
  units: PropertyUnit[];
  needs: PropertyNeed[];
  balances_owed: BalanceOwed[];
  past_orders: PastOrder[];
  quotes: Array<{ date: string; item: string; vendor: string; amount?: number; amount_range?: string }>;
  spreadsheet_url?: string;
  status_note?: string;
  last_report?: string;
  last_report_by?: string;
  updated_at: string;
}

const priorityColors: Record<string, string> = {
  urgent: 'bg-red-500/15 text-red-400 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  low: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

const statusColors: Record<string, string> = {
  needed: 'bg-red-500/15 text-red-400',
  in_progress: 'bg-blue-500/15 text-blue-400',
  on_hold: 'bg-yellow-500/15 text-yellow-400',
  quote_pending: 'bg-purple-500/15 text-purple-400',
  pending: 'bg-yellow-500/15 text-yellow-400',
  done: 'bg-green-500/15 text-green-400',
};

function formatCurrency(amount: number | null): string {
  if (amount === null) return 'TBD';
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function PropertyCard({ property }: { property: Property }) {
  const occupiedCount = property.units.filter((u) => u.status === 'occupied').length;
  const vacantCount = property.units.filter((u) => u.status === 'vacant').length;
  const urgentNeeds = property.needs.filter((n) => n.priority === 'urgent' || n.priority === 'high').length;
  const totalOwed = property.balances_owed.reduce((sum, b) => sum + (b.amount ?? 0), 0);
  const hasCollectionsRisk = property.balances_owed.some((b) => b.status === 'collections_risk');

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2">
            <IconHome size={18} className="text-primary" />
            {property.name}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {property.city}, {property.state} &middot; {property.entity} &middot; {property.type}
          </p>
          {property.manager && (
            <p className="text-xs text-muted-foreground">PM: {property.manager}</p>
          )}
        </div>
        {property.spreadsheet_url && (
          <a
            href={property.spreadsheet_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <IconExternalLink size={12} />
            Sheet
          </a>
        )}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="rounded-md bg-muted/50 p-2.5 text-center">
          <div className="text-lg font-semibold">{property.units.length}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Units</div>
        </div>
        <div className="rounded-md bg-green-500/10 p-2.5 text-center">
          <div className="text-lg font-semibold text-green-400">{occupiedCount}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Occupied</div>
        </div>
        <div className="rounded-md bg-red-500/10 p-2.5 text-center">
          <div className="text-lg font-semibold text-red-400">{vacantCount}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Vacant</div>
        </div>
        <div className={`rounded-md p-2.5 text-center ${hasCollectionsRisk ? 'bg-red-500/10' : 'bg-orange-500/10'}`}>
          <div className={`text-lg font-semibold ${hasCollectionsRisk ? 'text-red-400' : 'text-orange-400'}`}>
            {totalOwed > 0 ? formatCurrency(totalOwed) : 'TBD'}
          </div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Owed</div>
        </div>
      </div>

      {/* Units */}
      {property.units.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Units</h4>
          <div className="space-y-1">
            {property.units.map((unit, i) => (
              <div key={i} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${unit.status === 'occupied' ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="font-medium">{unit.name}</span>
                  {unit.tenant && <span className="text-muted-foreground">({unit.tenant})</span>}
                </div>
                <div className="flex items-center gap-2">
                  {unit.rent && <span className="text-muted-foreground">${unit.rent}/mo</span>}
                  {unit.notes && <span className="text-muted-foreground max-w-[200px] truncate">{unit.notes}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Needs */}
      {property.needs.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Needs & Repairs
            {urgentNeeds > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-500/15 text-red-400 px-2 py-0.5 text-[10px]">
                <IconAlertTriangle size={10} />
                {urgentNeeds} urgent
              </span>
            )}
          </h4>
          <div className="space-y-1">
            {property.needs.map((need, i) => (
              <div key={i} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${priorityColors[need.priority] ?? ''}`}>
                    {need.priority}
                  </span>
                  <span className="font-medium">{need.item}</span>
                </div>
                <div className="flex items-center gap-2">
                  {need.vendor && <span className="text-muted-foreground">{need.vendor}</span>}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusColors[need.status] ?? ''}`}>
                    {need.status.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Balances Owed */}
      {property.balances_owed.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Outstanding Balances</h4>
          <div className="space-y-1">
            {property.balances_owed.map((bal, i) => (
              <div key={i} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  {bal.status === 'collections_risk' && <IconAlertTriangle size={12} className="text-red-400" />}
                  <span className="font-medium">{bal.to}</span>
                  <span className="text-muted-foreground">{bal.reason}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-semibold ${bal.status === 'collections_risk' ? 'text-red-400' : ''}`}>
                    {formatCurrency(bal.amount)}
                  </span>
                  {bal.status === 'collections_risk' && (
                    <span className="rounded-full bg-red-500/15 text-red-400 px-1.5 py-0.5 text-[10px] font-medium">collections risk</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Past Orders */}
      {property.past_orders.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Past Orders</h4>
          <div className="space-y-1">
            {property.past_orders.map((order, i) => (
              <div key={i} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <IconCheck size={12} className="text-green-500" />
                  <span className="text-muted-foreground">{order.date}</span>
                  <span className="font-medium">{order.item}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{order.vendor}</span>
                  <span className="font-medium">{formatCurrency(order.cost)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 pt-3 border-t flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Owner: {property.owner}</span>
        {property.last_report && (
          <span className="flex items-center gap-1">
            <IconClock size={11} />
            Last report: {property.last_report} by {property.last_report_by}
          </span>
        )}
      </div>
    </div>
  );
}

export default function PropertiesPage() {
  const { currentOrg } = useOrg();
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProperties = useCallback(async () => {
    const params = new URLSearchParams();
    if (currentOrg && currentOrg !== 'all') params.set('org', currentOrg);
    try {
      const res = await fetch(`/api/properties?${params.toString()}`);
      const data = await res.json();
      setProperties(Array.isArray(data) ? data : []);
    } catch {
      setProperties([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => { fetchProperties(); }, [fetchProperties]);

  const totalUnits = properties.reduce((s, p) => s + p.units.length, 0);
  const occupied = properties.reduce((s, p) => s + p.units.filter((u) => u.status === 'occupied').length, 0);
  const vacant = properties.reduce((s, p) => s + p.units.filter((u) => u.status === 'vacant').length, 0);
  const totalNeeds = properties.reduce((s, p) => s + p.needs.length, 0);
  const urgentNeeds = properties.reduce((s, p) => s + p.needs.filter((n) => n.priority === 'urgent' || n.priority === 'high').length, 0);

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Properties</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Jordan Reyes property portfolio &mdash; units, needs, and balances
          </p>
        </div>
        <button
          onClick={fetchProperties}
          className="rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Portfolio Summary */}
      {!loading && properties.length > 0 && (
        <div className="grid grid-cols-5 gap-3">
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className="text-2xl font-bold">{properties.length}</div>
            <div className="text-xs text-muted-foreground mt-1">Properties</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className="text-2xl font-bold">{totalUnits}</div>
            <div className="text-xs text-muted-foreground mt-1">Total Units</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className="text-2xl font-bold text-green-400">{occupied}</div>
            <div className="text-xs text-muted-foreground mt-1">Occupied</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className="text-2xl font-bold text-red-400">{vacant}</div>
            <div className="text-xs text-muted-foreground mt-1">Vacant</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className={`text-2xl font-bold ${urgentNeeds > 0 ? 'text-orange-400' : 'text-muted-foreground'}`}>{totalNeeds}</div>
            <div className="text-xs text-muted-foreground mt-1">Open Needs</div>
          </div>
        </div>
      )}

      {/* Property Cards */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          Loading properties...
        </div>
      ) : properties.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          No properties found.
        </div>
      ) : (
        <div className="space-y-4">
          {properties.map((property) => (
            <PropertyCard key={property.id} property={property} />
          ))}
        </div>
      )}
    </div>
  );
}
