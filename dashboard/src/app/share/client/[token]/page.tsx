import { getPropertiesByClientToken } from '@/lib/data/properties';
import type { Property, RoomRosterEntry } from '@/lib/data/properties';
import { notFound } from 'next/navigation';
import Link from 'next/link';

function occupancySummary(p: Property): { occupied: number; total: number } {
  const roster = p.room_roster ?? [];
  if (roster.length === 0) {
    const occ = p.units?.filter(u => u.status === 'occupied').length ?? 0;
    const tot = p.units?.length ?? 0;
    return { occupied: occ, total: tot };
  }
  const occupied = roster.filter(r => r.payment_status !== 'vacant').length;
  return { occupied, total: roster.length };
}

function paymentSummary(roster: RoomRosterEntry[]): { late: number; eviction: number } {
  const late = roster.filter(r => r.payment_status === 'late' || r.payment_status === 'delinquent').length;
  const eviction = roster.filter(r => r.payment_status === 'eviction').length;
  return { late, eviction };
}

function InsuranceTag({ p }: { p: Property }) {
  if (!p.insurance) return null;
  const due = new Date(p.insurance.renewal_date);
  const daysOut = Math.ceil((due.getTime() - Date.now()) / 86400000);
  const urgent = daysOut < 30;
  return (
    <span className={`text-[11px] ${urgent ? 'text-amber-600' : 'text-zinc-400'}`}>
      Ins {daysOut < 0 ? 'expired' : `renews ${p.insurance.renewal_date}`}
    </span>
  );
}

function TaxTag({ p }: { p: Property }) {
  if (!p.taxes) return null;
  return (
    <span className="text-[11px] text-zinc-400">
      Tax due {p.taxes.due_date}
    </span>
  );
}

function PropertyCard({ p, token }: { p: Property; token: string }) {
  const occ = occupancySummary(p);
  const roster = p.room_roster ?? [];
  const { late, eviction } = paymentSummary(roster);
  const openNeeds = p.needs?.filter(n => n.status !== 'done') ?? [];
  const urgentNeeds = openNeeds.filter(n => n.priority === 'urgent' || n.priority === 'high');
  const vacantRooms = occ.total - occ.occupied;
  const occupancyPct = occ.total > 0 ? Math.round((occ.occupied / occ.total) * 100) : null;

  const pipeline = p.prospect_pipeline ?? [];
  const vacantRoomNames = roster.filter(r => r.payment_status === 'vacant').map(r => r.room);
  const prospectsOnVacant = pipeline.filter(
    pr => pr.stage !== 'moved_in' && pr.room && vacantRoomNames.includes(pr.room)
  );

  const occupancyBarColor =
    occupancyPct === 100 ? 'bg-green-500' :
    vacantRooms >= 2 ? 'bg-red-400' : 'bg-amber-400';

  const occupancyTextColor =
    occupancyPct === 100 ? 'text-green-600' :
    vacantRooms >= 2 ? 'text-red-600' : 'text-amber-600';

  const hasMeta = !!p.insurance || !!p.taxes;

  return (
    <Link href={`/share/client/${token}/${p.id}`} className="block group">
      <div className="bg-white rounded-xl border border-zinc-200 shadow-sm hover:shadow-md hover:border-zinc-300 transition-all duration-150 flex flex-col">
        {/* Card header */}
        <div className="p-6 pb-5 flex-1">
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-zinc-900 group-hover:text-blue-600 transition-colors leading-snug">
                {p.name}
              </h2>
              <p className="text-[12px] text-zinc-400 mt-0.5">{p.city}, {p.state} · {p.entity}</p>
            </div>
            <span className="text-[11px] text-zinc-300 group-hover:text-zinc-400 transition-colors shrink-0 mt-0.5">
              View →
            </span>
          </div>

          {/* Occupancy bar */}
          {occ.total > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-400">Occupancy</span>
                <span className={`text-sm font-semibold tabular-nums ${occupancyTextColor}`}>
                  {occ.occupied}/{occ.total}
                </span>
              </div>
              <div className="w-full bg-zinc-100 rounded-full h-1">
                <div
                  className={`h-1 rounded-full ${occupancyBarColor}`}
                  style={{ width: `${occupancyPct ?? 0}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-zinc-300 italic">No room data</div>
          )}

          {/* Alert chips */}
          {(eviction > 0 || late > 0 || urgentNeeds.length > 0) && (
            <div className="flex flex-wrap gap-1.5 mt-4">
              {eviction > 0 && (
                <span className="inline-flex items-center text-[11px] bg-red-100 text-red-700 border border-red-200 rounded-full px-2.5 py-0.5 font-medium">
                  {eviction} eviction
                </span>
              )}
              {late > 0 && (
                <span className="inline-flex items-center text-[11px] bg-red-50 text-red-600 border border-red-100 rounded-full px-2.5 py-0.5">
                  {late} late
                </span>
              )}
              {urgentNeeds.length > 0 && (
                <span className="inline-flex items-center text-[11px] bg-amber-50 text-amber-700 border border-amber-100 rounded-full px-2.5 py-0.5">
                  {urgentNeeds.length} urgent maint
                </span>
              )}
            </div>
          )}

          {/* Prospects on vacant */}
          {prospectsOnVacant.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {prospectsOnVacant.map((pr, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 text-[11px] bg-blue-50 text-blue-700 border border-blue-100 rounded-full px-2.5 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                  {pr.room}: {pr.name}
                </span>
              ))}
            </div>
          )}
        </div>

        {hasMeta && (
          <div className="px-6 py-3 border-t border-zinc-100 flex flex-wrap gap-3">
            <InsuranceTag p={p} />
            <TaxTag p={p} />
          </div>
        )}
      </div>
    </Link>
  );
}

export default async function ClientPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const properties = getPropertiesByClientToken(token);
  if (properties.length === 0) notFound();

  const totalRooms = properties.reduce((s, p) => {
    const r = p.room_roster?.length ?? p.units?.length ?? 0;
    return s + r;
  }, 0);
  const totalOccupied = properties.reduce((s, p) => {
    const occ = occupancySummary(p);
    return s + occ.occupied;
  }, 0);
  const totalLate = properties.reduce((s, p) => {
    const { late } = paymentSummary(p.room_roster ?? []);
    return s + late;
  }, 0);
  const totalEviction = properties.reduce((s, p) => {
    const { eviction } = paymentSummary(p.room_roster ?? []);
    return s + eviction;
  }, 0);
  const totalOpenNeeds = properties.reduce((s, p) => {
    return s + (p.needs?.filter(n => n.status !== 'done').length ?? 0);
  }, 0);

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const totalOccupancyPct = totalRooms > 0 ? Math.round((totalOccupied / totalRooms) * 100) : null;

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Branded header */}
      <div className="bg-zinc-900 px-6 py-5">
        <div className="max-w-5xl mx-auto flex items-end justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-1">Client Portfolio</p>
            <h1 className="text-xl font-semibold text-white tracking-tight">
              {properties[0]?.owner ?? 'Portfolio'} Overview
            </h1>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-zinc-400">{today}</div>
            <div className="text-[10px] text-zinc-600 mt-0.5 uppercase tracking-wider">Initial Rentals LLC</div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* Portfolio summary strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border border-zinc-200 p-5 shadow-sm">
            <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 mb-3">Occupancy</div>
            <div className={`text-3xl font-bold tabular-nums ${
              totalOccupancyPct === 100 ? 'text-green-600' :
              totalOccupancyPct != null && totalOccupancyPct < 75 ? 'text-red-600' : 'text-amber-600'
            }`}>
              {totalOccupancyPct != null ? `${totalOccupancyPct}%` : '—'}
            </div>
            {totalRooms > 0 && (
              <div className="text-[11px] text-zinc-400 mt-1.5">{totalOccupied} of {totalRooms} rooms</div>
            )}
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-5 shadow-sm">
            <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 mb-3">Late / Delinquent</div>
            <div className={`text-3xl font-bold tabular-nums ${totalLate > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {totalLate > 0 ? totalLate : '✓'}
            </div>
            {totalLate > 0 && (
              <div className="text-[11px] text-zinc-400 mt-1.5">rooms past due</div>
            )}
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-5 shadow-sm">
            <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 mb-3">Eviction</div>
            <div className={`text-3xl font-bold tabular-nums ${totalEviction > 0 ? 'text-red-700' : 'text-zinc-200'}`}>
              {totalEviction > 0 ? totalEviction : '—'}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 p-5 shadow-sm">
            <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 mb-3">Open Maint</div>
            <div className={`text-3xl font-bold tabular-nums ${totalOpenNeeds > 0 ? 'text-amber-600' : 'text-zinc-200'}`}>
              {totalOpenNeeds > 0 ? totalOpenNeeds : '—'}
            </div>
          </div>
        </div>

        {/* Property cards grid */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Properties
            </h2>
            <span className="text-[11px] text-zinc-400">{properties.length} total</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {properties.map(p => (
              <PropertyCard key={p.id} p={p} token={token} />
            ))}
          </div>
        </div>

        <p className="text-center text-[10px] text-zinc-300 pt-2">
          Read-only · Data refreshed by management system
        </p>
      </div>
    </div>
  );
}
