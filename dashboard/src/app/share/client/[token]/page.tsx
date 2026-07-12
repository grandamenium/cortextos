import { getPropertiesByClientToken } from '@/lib/data/properties';
import type { RoomRosterEntry } from '@/lib/data/properties';
import { notFound } from 'next/navigation';
import { PropertyAccordion } from './accordion';

function occupancySummaryServer(p: { room_roster?: RoomRosterEntry[]; units?: { status: string }[] }) {
  const roster = p.room_roster ?? [];
  if (roster.length === 0) {
    return { occupied: p.units?.filter(u => u.status === 'occupied').length ?? 0, total: p.units?.length ?? 0 };
  }
  return { occupied: roster.filter(r => r.payment_status !== 'vacant').length, total: roster.length };
}

function paymentSummaryServer(roster: RoomRosterEntry[]) {
  return {
    late: roster.filter(r => r.payment_status === 'late' || r.payment_status === 'delinquent').length,
    eviction: roster.filter(r => r.payment_status === 'eviction').length,
  };
}

export default async function ClientPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ k?: string }>;
}) {
  const { token } = await params;
  const { k: editKey } = await searchParams;

  const properties = getPropertiesByClientToken(token);
  if (properties.length === 0) notFound();

  // Validate editKey against property edit_keys — only pass through if it matches at least one
  const validEditKey =
    editKey && properties.some(p => (p as unknown as Record<string, unknown>).edit_key === editKey)
      ? editKey
      : undefined;

  const totalRooms = properties.reduce((s, p) => s + (p.room_roster?.length ?? p.units?.length ?? 0), 0);
  const totalOccupied = properties.reduce((s, p) => s + occupancySummaryServer(p).occupied, 0);
  const totalLate = properties.reduce((s, p) => s + paymentSummaryServer(p.room_roster ?? []).late, 0);
  const totalEviction = properties.reduce((s, p) => s + paymentSummaryServer(p.room_roster ?? []).eviction, 0);
  const totalOpenNeeds = properties.reduce((s, p) => s + (p.needs?.filter(n => n.status !== 'done').length ?? 0), 0);

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const totalPct = totalRooms > 0 ? Math.round((totalOccupied / totalRooms) * 100) : null;

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      <div className="bg-zinc-900 px-5 py-4">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-0.5">Client Portfolio</p>
            <h1 className="text-lg font-semibold text-white tracking-tight leading-tight">
              {properties[0]?.owner ?? 'Portfolio'} Overview
            </h1>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-zinc-400">{today}</div>
            <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Initial Rentals LLC</div>
          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-4 py-4 space-y-3">
        {/* Portfolio summary strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="bg-white rounded-lg border border-zinc-200 p-3.5 shadow-sm">
            <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">Occupancy</div>
            <div className={`text-2xl font-bold tabular-nums ${
              totalPct === 100 ? 'text-green-600' : totalPct != null && totalPct < 75 ? 'text-red-600' : 'text-amber-600'
            }`}>{totalPct != null ? `${totalPct}%` : '—'}</div>
            {totalRooms > 0 && <div className="text-[10px] text-zinc-400 mt-0.5">{totalOccupied}/{totalRooms} rooms</div>}
          </div>
          <div className="bg-white rounded-lg border border-zinc-200 p-3.5 shadow-sm">
            <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">Late / Delinquent</div>
            <div className={`text-2xl font-bold tabular-nums ${totalLate > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {totalLate > 0 ? totalLate : '✓'}
            </div>
            {totalLate > 0 && <div className="text-[10px] text-zinc-400 mt-0.5">rooms past due</div>}
          </div>
          <div className="bg-white rounded-lg border border-zinc-200 p-3.5 shadow-sm">
            <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">Eviction</div>
            <div className={`text-2xl font-bold tabular-nums ${totalEviction > 0 ? 'text-red-700' : 'text-zinc-200'}`}>
              {totalEviction > 0 ? totalEviction : '—'}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-zinc-200 p-3.5 shadow-sm">
            <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">Open Maint</div>
            <div className={`text-2xl font-bold tabular-nums ${totalOpenNeeds > 0 ? 'text-amber-600' : 'text-zinc-200'}`}>
              {totalOpenNeeds > 0 ? totalOpenNeeds : '—'}
            </div>
          </div>
        </div>

        {/* Accordion property list */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400">Properties</h2>
            <span className="text-[10px] text-zinc-400">{properties.length} total · click to expand</span>
          </div>
          <PropertyAccordion properties={properties} token={token} editKey={validEditKey} />
        </div>

        <p className="text-center text-[9px] text-zinc-300 pt-1">
          {validEditKey ? 'Edit mode · Click any Notes cell to update' : 'Read-only · Data refreshed by management system'}
        </p>
      </div>
    </div>
  );
}
