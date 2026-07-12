'use client';

import { useState } from 'react';
import type { Property, RoomRosterEntry } from '@/lib/data/properties';

// ── helpers ────────────────────────────────────────────────────────────────

function occupancySummary(p: Property) {
  const roster = p.room_roster ?? [];
  if (roster.length === 0) {
    return {
      occupied: p.units?.filter(u => u.status === 'occupied').length ?? 0,
      total: p.units?.length ?? 0,
    };
  }
  return { occupied: roster.filter(r => r.payment_status !== 'vacant').length, total: roster.length };
}

function paymentSummary(roster: RoomRosterEntry[]) {
  return {
    late: roster.filter(r => r.payment_status === 'late' || r.payment_status === 'delinquent').length,
    eviction: roster.filter(r => r.payment_status === 'eviction').length,
  };
}

function fmt(n: number | null | undefined) {
  return n == null ? '—' : '$' + n.toLocaleString('en-US');
}

const paymentBadgeCls: Record<string, string> = {
  current:    'bg-green-50 text-green-700 border-green-200',
  late:       'bg-red-50 text-red-700 border-red-200',
  delinquent: 'bg-red-100 text-red-800 border-red-300 font-semibold',
  eviction:   'bg-red-200 text-red-900 border-red-400 font-bold',
  vacant:     'bg-zinc-100 text-zinc-500 border-zinc-200',
};

const statusLeftBorder: Record<string, string> = {
  current:    'border-l-green-500',
  late:       'border-l-red-400',
  delinquent: 'border-l-red-500',
  eviction:   'border-l-red-700',
  vacant:     'border-l-zinc-200',
};

const needPriorityCls: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high:   'bg-orange-100 text-orange-700 border-orange-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low:    'bg-zinc-100 text-zinc-500 border-zinc-200',
};

const outcomeColor: Record<string, string> = {
  paid:              'text-green-600',
  partial:           'text-amber-600',
  'promise-to-pay':  'text-blue-600',
  pending:           'text-zinc-400',
  'no-response':     'text-red-500',
};

// ── expanded detail — two-column dashboard layout ───────────────────────────

function PropertyDetail({ property }: { property: Property }) {
  const roster = property.room_roster ?? [];
  const openNeeds = property.needs?.filter(n => n.status !== 'done') ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-3">

      {/* LEFT: Room Status — primary panel */}
      <div className="bg-white rounded-md border border-zinc-100 p-3 min-w-0">
        <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-2">Room Status</div>

        {roster.length === 0 ? (
          <p className="text-[11px] text-zinc-400 italic">No room data</p>
        ) : (
          <div className="divide-y divide-zinc-50">
            {roster.map((room, i) => {
              // Try to match rent from the units[] array
              const unit = property.units.find(
                u => u.name?.toLowerCase() === room.room?.toLowerCase()
              );
              const monthlyRent = unit?.rent ?? null;

              // Most-recent 2 collection notes (only for non-vacant)
              const notes = room.payment_status !== 'vacant'
                ? (room.collection_notes ?? [])
                    .slice()
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .slice(0, 2)
                : [];

              const prospect =
                room.payment_status === 'vacant'
                  ? (property.prospect_pipeline ?? []).find(
                      p => p.room === room.room && p.stage !== 'moved_in'
                    )
                  : undefined;

              const isVacant = room.payment_status === 'vacant';
              const borderCls = statusLeftBorder[room.payment_status] ?? 'border-l-zinc-200';
              const badgeCls = paymentBadgeCls[room.payment_status] ?? 'bg-amber-50 text-amber-700 border-amber-200';

              return (
                <div key={i} className={`py-2 pl-2.5 border-l-[3px] ${borderCls}`}>
                  {/* Room header row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-zinc-900 shrink-0">
                      {room.room}
                    </span>
                    <span className="text-[11px] text-zinc-500 flex-1 min-w-0 truncate">
                      {room.tenant
                        ? room.tenant
                        : prospect
                        ? `${prospect.name} · ${prospect.stage.replace(/_/g, ' ')}`
                        : 'Vacant'}
                    </span>
                    {monthlyRent != null && (
                      <span className="text-[10px] text-zinc-400 tabular-nums shrink-0">
                        {fmt(monthlyRent)}/mo
                      </span>
                    )}
                    {!isVacant && (
                      room.amount_due != null && room.amount_due > 0 ? (
                        <span className="text-[11px] font-semibold text-red-600 tabular-nums shrink-0">
                          {fmt(room.amount_due)} due
                        </span>
                      ) : (
                        <span className="text-[10px] text-zinc-300 tabular-nums shrink-0">—</span>
                      )
                    )}
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full border shrink-0 capitalize ${badgeCls}`}>
                      {room.payment_status}
                    </span>
                  </div>

                  {/* Rent-recovery notes */}
                  {notes.length > 0 && (
                    <div className="mt-0.5 space-y-0.5">
                      {notes.map((n, ni) => (
                        <div key={ni} className="flex items-baseline gap-1.5 text-[10px] pl-1">
                          <span className="text-zinc-300 shrink-0">↳</span>
                          <span className="text-zinc-400 shrink-0 tabular-nums w-14">{n.date}</span>
                          <span className="text-zinc-500 flex-1 min-w-0 truncate">{n.note}</span>
                          <span className={`shrink-0 font-medium ${outcomeColor[n.outcome] ?? 'text-zinc-400'}`}>
                            {n.outcome.replace(/-/g, ' ')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Eviction note */}
                  {room.eviction_status && (
                    <div className="text-[10px] text-red-500 mt-0.5 pl-1">{room.eviction_status}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* RIGHT: Secondary info panels */}
      <div className="space-y-2 min-w-0">

        {/* Open Maintenance */}
        {(() => {
          const totalEst = openNeeds.reduce((s, n) => s + (n.cost ?? 0), 0);
          const totalQuoted = openNeeds.reduce((s, n) => s + (n.quoted_amount ?? 0), 0);
          const hasAnyCost = openNeeds.some(n => n.cost != null);
          const hasAnyQuote = openNeeds.some(n => n.quoted_amount != null);
          return (
            <div className="bg-white rounded-md border border-zinc-100 p-3">
              <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">
                Maintenance{openNeeds.length > 0 ? ` · ${openNeeds.length} open` : ''}
              </div>
              {openNeeds.length === 0 ? (
                <p className="text-[11px] text-zinc-300">None open</p>
              ) : (
                <>
                  <div className="divide-y divide-zinc-50">
                    {openNeeds.slice(0, 6).map((n, i) => (
                      <div key={i} className="py-1.5 first:pt-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[9px] w-4 text-center py-0.5 rounded border shrink-0 ${
                            needPriorityCls[n.priority] ?? 'bg-zinc-100 text-zinc-500 border-zinc-200'
                          }`}>
                            {n.priority[0].toUpperCase()}
                          </span>
                          <span className="text-[11px] text-zinc-700 flex-1 truncate">{n.item}</span>
                          {n.cost != null && (
                            <span className="text-[10px] text-zinc-400 tabular-nums shrink-0">
                              {fmt(n.cost)}
                            </span>
                          )}
                        </div>
                        {/* Quoted indicator */}
                        {n.quoted_amount != null ? (
                          <div className="text-[10px] text-green-600 pl-5 mt-0.5">
                            Quoted: {fmt(n.quoted_amount)}
                            {n.vendor && <span className="text-zinc-400"> · {n.vendor}</span>}
                          </div>
                        ) : n.status === 'quote_pending' ? (
                          <div className="text-[10px] text-amber-500 pl-5 mt-0.5">Quote pending</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  {openNeeds.length > 6 && (
                    <div className="text-[10px] text-zinc-400 mt-1">+{openNeeds.length - 6} more</div>
                  )}
                  {/* Totals row */}
                  {(hasAnyCost || hasAnyQuote) && (
                    <div className="mt-2 pt-2 border-t border-zinc-100 flex justify-between text-[10px]">
                      {hasAnyCost && (
                        <span className="text-zinc-500">Est: <span className="font-medium text-zinc-700 tabular-nums">{fmt(totalEst)}</span></span>
                      )}
                      {hasAnyQuote && (
                        <span className="text-zinc-500">Quoted: <span className="font-medium text-green-600 tabular-nums">{fmt(totalQuoted)}</span></span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {/* Insurance + Taxes */}
        <div className="bg-white rounded-md border border-zinc-100 p-3">
          <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">
            Insurance &amp; Taxes
          </div>
          <div className="space-y-1.5">
            {property.insurance ? (
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="text-zinc-500 shrink-0">Insurance</span>
                <span className="text-zinc-700 text-right">
                  Renews {property.insurance.renewal_date}
                  {property.insurance.carrier && (
                    <span className="text-zinc-400"> · {property.insurance.carrier}</span>
                  )}
                </span>
              </div>
            ) : (
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-zinc-400">Insurance</span>
                <span className="text-zinc-300">not tracked</span>
              </div>
            )}
            {property.taxes ? (
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="text-zinc-500 shrink-0">Property tax</span>
                <span className="text-zinc-700 text-right">
                  Due {property.taxes.due_date}
                  {property.taxes.status && (
                    <span className="text-zinc-400"> · {property.taxes.status}</span>
                  )}
                </span>
              </div>
            ) : (
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-zinc-400">Property tax</span>
                <span className="text-zinc-300">not tracked</span>
              </div>
            )}
          </div>
        </div>

        {/* Utilities + HOA */}
        {(property.utilities ||
          (property.hoa && property.hoa.status !== 'not_applicable')) && (
          <div className="bg-white rounded-md border border-zinc-100 p-3">
            <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">
              Utilities &amp; HOA
            </div>
            <div className="space-y-1">
              {property.utilities &&
                (['electric', 'water', 'gas', 'trash'] as const).map(key => {
                  const u = property.utilities?.[key];
                  if (!u) return null;
                  return (
                    <div key={key} className="flex items-baseline justify-between text-[11px]">
                      <span className="text-zinc-400 capitalize">{key}</span>
                      <span className="text-zinc-600 tabular-nums">
                        {u.monthly_est != null ? `${fmt(u.monthly_est)}/mo` : (u.provider ?? '—')}
                      </span>
                    </div>
                  );
                })}
              {property.hoa && property.hoa.status !== 'not_applicable' && (
                <div className="flex items-baseline justify-between text-[11px]">
                  <span className="text-zinc-400">HOA</span>
                  <span className={`tabular-nums ${property.hoa.status === 'overdue' ? 'text-red-600' : 'text-zinc-600'}`}>
                    {property.hoa.monthly_fee != null
                      ? `${fmt(property.hoa.monthly_fee)}/mo`
                      : property.hoa.status}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Fill Effort — only when vacancies exist */}
        {property.occupancy_outreach && property.occupancy_outreach.vacant_rooms > 0 && (
          <div className="bg-white rounded-md border border-amber-100 p-3">
            <div className="text-[9px] uppercase tracking-[0.14em] text-amber-600 mb-1.5">
              Fill Effort · {property.occupancy_outreach.vacant_rooms} vacant
            </div>
            <div className="space-y-0.5">
              {(property.occupancy_outreach.outreach_log ?? [])
                .slice(-3)
                .reverse()
                .map((e, i) => (
                  <div key={i} className="flex gap-2 text-[10px]">
                    <span className="text-zinc-400 shrink-0 tabular-nums">{e.date}</span>
                    <span className="text-zinc-500 uppercase shrink-0 w-10">{e.type}</span>
                    <span className="text-zinc-600 truncate">{e.detail}</span>
                  </div>
                ))}
              {!property.occupancy_outreach.outreach_log?.length && (
                <p className="text-[11px] text-zinc-300">No outreach logged</p>
              )}
            </div>
          </div>
        )}

        {/* Agent Notes (status_updates) */}
        {(property.status_updates ?? []).length > 0 && (
          <div className="bg-white rounded-md border border-blue-100 p-3">
            <div className="text-[9px] uppercase tracking-[0.14em] text-blue-500 mb-1.5">
              Agent Notes
            </div>
            <div className="space-y-1">
              {(property.status_updates ?? [])
                .slice()
                .sort((a, b) => b.at.localeCompare(a.at))
                .slice(0, 5)
                .map((note, i) => (
                  <div key={i} className="text-[10px]">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-zinc-400 tabular-nums shrink-0">
                        {new Date(note.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                      <span className="text-zinc-300 shrink-0">·</span>
                      <span className="text-blue-500 shrink-0">{note.from}</span>
                    </div>
                    <div className="text-zinc-600 mt-0.5 pl-0.5">{note.text}</div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── accordion row ───────────────────────────────────────────────────────────

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(diff / 3600000);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function PropertyRow({ property, isOpen, onToggle }: {
  property: Property;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const occ = occupancySummary(property);
  const roster = property.room_roster ?? [];
  const { late, eviction } = paymentSummary(roster);
  const openNeeds = property.needs?.filter(n => n.status !== 'done') ?? [];
  const urgentNeeds = openNeeds.filter(n => n.priority === 'urgent' || n.priority === 'high');
  const vacantRooms = occ.total - occ.occupied;
  const pct = occ.total > 0 ? Math.round((occ.occupied / occ.total) * 100) : null;
  const latestNote = (property.status_updates ?? [])
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))[0];

  const barColor = pct === 100 ? 'bg-green-500' : vacantRooms >= 2 ? 'bg-red-400' : 'bg-amber-400';
  const occColor = pct === 100 ? 'text-green-600' : vacantRooms >= 2 ? 'text-red-600' : 'text-amber-600';

  return (
    <div>
      {/* Collapsed header row */}
      <button
        onClick={onToggle}
        className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-zinc-50/80 transition-colors"
        aria-expanded={isOpen}
      >
        <span className="text-[10px] text-zinc-300 shrink-0 w-3 text-center select-none">
          {isOpen ? '▾' : '▸'}
        </span>

        {/* Name + location */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={`text-[14px] font-semibold ${isOpen ? 'text-blue-600' : 'text-zinc-900'} transition-colors`}>
              {property.name}
            </span>
            <span className="text-[11px] text-zinc-400">{property.city}, {property.state}</span>
          </div>
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-2 shrink-0">
          {occ.total > 0 && (
            <>
              <div className="w-14 bg-zinc-100 rounded-full h-1 hidden sm:block">
                <div className={`h-1 rounded-full ${barColor}`} style={{ width: `${pct ?? 0}%` }} />
              </div>
              <span className={`text-[12px] font-semibold tabular-nums w-8 text-right ${occColor}`}>
                {occ.occupied}/{occ.total}
              </span>
            </>
          )}
          {eviction > 0 && (
            <span className="text-[10px] bg-red-100 text-red-700 border border-red-200 rounded-full px-2 py-0.5 font-medium">
              {eviction} eviction
            </span>
          )}
          {late > 0 && (
            <span className="text-[10px] bg-red-50 text-red-600 border border-red-100 rounded-full px-2 py-0.5">
              {late} late
            </span>
          )}
          {urgentNeeds.length > 0 && (
            <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-100 rounded-full px-2 py-0.5">
              {urgentNeeds.length} maint
            </span>
          )}
          {latestNote && (
            <span className="text-[10px] text-blue-400 hidden sm:inline-block">
              ↳ note {relativeTime(latestNote.at)}
            </span>
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {isOpen && (
        <div className="border-t border-zinc-100 bg-zinc-50 px-4 py-3">
          <PropertyDetail property={property} />
        </div>
      )}
    </div>
  );
}

// ── main export ─────────────────────────────────────────────────────────────

export function PropertyAccordion({ properties }: { properties: Property[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => setOpenId(prev => prev === id ? null : id);

  return (
    <div className="bg-white rounded-xl border border-zinc-200 shadow-sm divide-y divide-zinc-100 overflow-hidden">
      {properties.map(p => (
        <PropertyRow
          key={p.id}
          property={p}
          isOpen={openId === p.id}
          onToggle={() => toggle(p.id)}
        />
      ))}
    </div>
  );
}
