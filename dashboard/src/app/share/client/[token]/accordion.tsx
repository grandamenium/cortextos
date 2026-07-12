'use client';

import { useState } from 'react';
import type { JSX } from 'react';
import type { Property, RoomRosterEntry, ProspectEntry } from '@/lib/data/properties';

// ── helpers ────────────────────────────────────────────────────────────────

function prospectRoom(p: ProspectEntry): string | undefined {
  return p.target_room ?? p.room;
}
function prospectMoveIn(p: ProspectEntry): string | undefined {
  return p.move_in_date ?? p.expected_move_in;
}

function occupancySummary(p: Property) {
  const roster = p.room_roster ?? [];
  const today = new Date().toISOString().slice(0, 10);

  // Rooms with a committed/approved/lease_signed prospect whose move-in is still future
  const committedRooms = new Set<string>();
  for (const prospect of (p.prospect_pipeline ?? [])) {
    const moveIn = prospectMoveIn(prospect);
    if (moveIn && moveIn > today &&
        (prospect.stage === 'committed' || prospect.stage === 'approved' || prospect.stage === 'lease_signed')) {
      const r = prospectRoom(prospect);
      if (r) committedRooms.add(r.toLowerCase());
    }
  }

  if (roster.length === 0) {
    return {
      occupied: p.units?.filter(u => u.status === 'occupied').length ?? 0,
      total: p.units?.length ?? 0,
      committed: committedRooms.size,
    };
  }

  const committed = roster.filter(r => committedRooms.has((r.room ?? '').toLowerCase())).length;
  const occupied = roster.filter(r =>
    r.payment_status !== 'vacant' && !committedRooms.has((r.room ?? '').toLowerCase())
  ).length;
  return { occupied, total: roster.length, committed };
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

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(diff / 3600000);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function fmtMoveIn(d: string): string {
  try {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return d; }
}

const needPriorityCls: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high:   'bg-orange-100 text-orange-700 border-orange-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low:    'bg-zinc-100 text-zinc-500 border-zinc-200',
};

const outcomeColor: Record<string, string> = {
  paid:             'text-green-600',
  partial:          'text-amber-600',
  'promise-to-pay': 'text-blue-600',
  pending:          'text-zinc-400',
  'no-response':    'text-red-500',
};

const statusDotCls: Record<string, string> = {
  current:    'text-green-500',
  late:       'text-red-400',
  delinquent: 'text-red-500',
  eviction:   'text-red-700',
  vacant:     'text-zinc-300',
};

const priorityOrder: Record<string, number> = {
  urgent: 0, high: 1, medium: 2, low: 3,
};

const stageLabel: Record<string, string> = {
  lead:        'Lead',
  applied:     'Applied',
  screening:   'Screening',
  approved:    'Approved',
  committed:   'Committed',
  lease_signed:'Lease Signed',
  moved_in:    'Moved In',
};
const stageCls: Record<string, string> = {
  lead:        'bg-zinc-100 text-zinc-500 border-zinc-200',
  applied:     'bg-zinc-100 text-zinc-500 border-zinc-200',
  screening:   'bg-amber-50 text-amber-700 border-amber-200',
  approved:    'bg-blue-50 text-blue-700 border-blue-200',
  committed:   'bg-purple-50 text-purple-700 border-purple-200',
  lease_signed:'bg-green-50 text-green-700 border-green-200',
  moved_in:    'bg-green-100 text-green-800 border-green-200',
};

const NEEDS_PREVIEW = 3;

// ── Prospect Pipeline panel ────────────────────────────────────────────────

function ProspectPanel({ pipeline }: { pipeline: ProspectEntry[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const active = pipeline
    .filter(p => p.stage !== 'moved_in')
    .sort((a, b) => {
      const stageOrder: Record<string, number> = {
        committed: 0, approved: 1, lease_signed: 2, screening: 3, applied: 4, lead: 5,
      };
      return (stageOrder[a.stage] ?? 9) - (stageOrder[b.stage] ?? 9);
    });

  if (active.length === 0) return null;

  return (
    <div className="bg-white rounded-md border border-zinc-100 p-3">
      <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">
        Prospect Pipeline · {active.length}
      </div>
      <div className="divide-y divide-zinc-50">
        {active.map((p, i) => {
          const moveIn = prospectMoveIn(p);
          const room = prospectRoom(p);
          const isFuture = moveIn && moveIn > today;
          return (
            <div key={i} className="py-1.5 first:pt-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-medium text-zinc-800">{p.name}</span>
                <span className={`text-[9px] px-1 py-0.5 rounded border whitespace-nowrap ${stageCls[p.stage] ?? 'bg-zinc-100 text-zinc-500 border-zinc-200'}`}>
                  {stageLabel[p.stage] ?? p.stage}
                </span>
                {p.no_reply && (
                  <span className="text-[9px] px-1 py-0.5 rounded border bg-red-50 text-red-500 border-red-200 whitespace-nowrap">No reply</span>
                )}
                {room && room !== 'TBD' && (
                  <span className="text-[9px] text-zinc-400">{room}</span>
                )}
              </div>
              {moveIn && (
                <div className={`text-[9px] mt-0.5 pl-0.5 ${isFuture ? 'text-purple-600' : 'text-zinc-400'}`}>
                  Planning to move in {fmtMoveIn(moveIn)}
                </div>
              )}
              {!moveIn && p.notes && (
                <div className="text-[9px] text-zinc-400 mt-0.5 pl-0.5 truncate">{p.notes.slice(0, 60)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── expanded detail — two-column dashboard layout ───────────────────────────

function PropertyDetail({ property }: { property: Property }) {
  const roster = property.room_roster ?? [];
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const openNeeds = (property.needs?.filter(n => n.status !== 'done') ?? [])
    .slice()
    .sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9));

  const visibleNeeds = showAllNeeds ? openNeeds : openNeeds.slice(0, NEEDS_PREVIEW);
  const hiddenCount = openNeeds.length - NEEDS_PREVIEW;
  const totalEst = openNeeds.reduce((s, n) => s + (n.cost ?? 0), 0);
  const totalQuoted = openNeeds.reduce((s, n) => s + (n.quoted_amount ?? 0), 0);
  const hasAnyCost = openNeeds.some(n => n.cost != null);
  const hasAnyQuote = openNeeds.some(n => n.quoted_amount != null);

  const recentOutreach = (property.occupancy_outreach?.outreach_log ?? []).slice(-1)[0];
  const pipeline = property.prospect_pipeline ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-3">

      {/* LEFT: Room Status table */}
      <div className="bg-white rounded-md border border-zinc-100 p-3 min-w-0 overflow-x-auto">
        <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-2">Room Status</div>

        {roster.length === 0 ? (
          <p className="text-[11px] text-zinc-400 italic">No room data</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="text-left text-[9px] uppercase tracking-[0.12em] text-zinc-400 font-medium pb-1.5 pr-3 w-[88px]">Room</th>
                <th className="text-left text-[9px] uppercase tracking-[0.12em] text-zinc-400 font-medium pb-1.5 pr-3">Tenant / Prospect</th>
                <th className="text-right text-[9px] uppercase tracking-[0.12em] text-zinc-400 font-medium pb-1.5 pr-3 w-[58px]">Rent/mo</th>
                <th className="text-right text-[9px] uppercase tracking-[0.12em] text-zinc-400 font-medium pb-1.5 pr-3 w-[58px]">Last Pmt</th>
                <th className="text-right text-[9px] uppercase tracking-[0.12em] text-zinc-400 font-medium pb-1.5 pr-3 w-[58px]">Due</th>
                <th className="text-left text-[9px] uppercase tracking-[0.12em] text-zinc-400 font-medium pb-1.5">Notes</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((room, i) => {
                const unit = property.units.find(
                  u => u.name?.toLowerCase() === room.room?.toLowerCase()
                );
                const monthlyRent = unit?.rent ?? null;
                const recentNote = (room.collection_notes ?? [])
                  .slice()
                  .sort((a, b) => b.date.localeCompare(a.date))[0];
                const prospect = pipeline.find(
                  p => (p.target_room ?? p.room) === room.room && p.stage !== 'moved_in'
                );
                const isVacant = room.payment_status === 'vacant';
                const isFlagged = !!(room.flag || room.move_out_planned);
                const moveIn = prospect ? prospectMoveIn(prospect) : room.expected_move_in ?? null;
                const isCommitted = !!(moveIn && moveIn > today && prospect &&
                  (prospect.stage === 'committed' || prospect.stage === 'approved' || prospect.stage === 'lease_signed'));
                const dotCls = statusDotCls[room.payment_status] ?? 'text-zinc-300';
                const rowBg = i % 2 === 1 ? 'bg-zinc-50/50' : '';

                // Context-aware notes cell
                let noteCell: JSX.Element;
                if (room.flag) {
                  noteCell = <span className="text-orange-600 font-medium">{room.flag}</span>;
                } else if (room.move_out_planned) {
                  noteCell = (
                    <span className="text-purple-600">
                      Move-out planned{room.move_out_date ? `: ${fmtMoveIn(room.move_out_date)}` : ''}
                    </span>
                  );
                } else if (isVacant || isCommitted) {
                  if (prospect) {
                    noteCell = prospect.notes
                      ? <span className="text-zinc-600">{prospect.notes.slice(0, 50)}</span>
                      : <span className="text-zinc-300">—</span>;
                  } else if (recentOutreach) {
                    noteCell = (
                      <>
                        <span className="text-zinc-400 tabular-nums mr-1">{recentOutreach.date}</span>
                        <span className="text-zinc-500 uppercase text-[9px] mr-1">{recentOutreach.type}</span>
                        <span className="text-zinc-600">
                          {(recentOutreach.detail ?? '').length > 40
                            ? (recentOutreach.detail ?? '').slice(0, 40) + '…'
                            : (recentOutreach.detail ?? '')}
                        </span>
                      </>
                    );
                  } else {
                    noteCell = <span className="text-zinc-300">No fill outreach</span>;
                  }
                } else if (recentNote) {
                  noteCell = (
                    <>
                      <span className="text-zinc-400 tabular-nums mr-1">{recentNote.date}</span>
                      <span className="text-zinc-600">
                        {(recentNote.note ?? '').length > 40 ? (recentNote.note ?? '').slice(0, 40) + '…' : (recentNote.note ?? '')}
                      </span>
                      {recentNote.outcome && (
                        <span className={`ml-1 font-medium ${outcomeColor[recentNote.outcome] ?? 'text-zinc-400'}`}>
                          · {recentNote.outcome.replace(/-/g, ' ')}
                        </span>
                      )}
                    </>
                  );
                } else {
                  noteCell = <span className="text-zinc-300">—</span>;
                }

                return (
                  <tr key={i} className={`border-b border-zinc-50 last:border-0 align-top ${rowBg}`}>

                    {/* Room + flag indicator */}
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1 whitespace-nowrap">
                        <span className={`text-[8px] shrink-0 leading-none ${isCommitted ? 'text-purple-400' : dotCls}`}>●</span>
                        <span className={`text-[12px] font-semibold ${isFlagged ? 'text-orange-700' : isCommitted ? 'text-purple-700' : 'text-zinc-900'}`}>
                          {room.room}
                        </span>
                        {isFlagged && <span className="text-[10px] text-orange-400">⚑</span>}
                      </div>
                      {room.eviction_status && (
                        <div className="text-[9px] text-red-500 mt-0.5 pl-3">{room.eviction_status}</div>
                      )}
                    </td>

                    {/* Tenant / Prospect + stage + move-in */}
                    <td className="py-2 pr-3 max-w-[160px]">
                      {room.tenant && !isCommitted ? (
                        <div>
                          <span className="text-[11px] text-zinc-700 truncate block">{room.tenant}</span>
                        </div>
                      ) : prospect ? (
                        <div>
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className={`text-[11px] font-medium truncate ${isCommitted ? 'text-purple-700' : 'text-blue-600'}`}>{prospect.name}</span>
                            <span className={`text-[9px] px-1 py-0.5 rounded border whitespace-nowrap ${stageCls[prospect.stage] ?? 'bg-zinc-100 text-zinc-500 border-zinc-200'}`}>
                              {stageLabel[prospect.stage] ?? prospect.stage}
                            </span>
                            {prospect.no_reply && (
                              <span className="text-[9px] px-1 py-0.5 rounded border bg-red-50 text-red-500 border-red-200 whitespace-nowrap">No reply</span>
                            )}
                          </div>
                          {moveIn && (
                            <span className="text-[9px] text-purple-600 mt-0.5 block">
                              Planning to move in {fmtMoveIn(moveIn)}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-zinc-400 italic">Vacant</span>
                      )}
                    </td>

                    {/* Rent/mo */}
                    <td className="py-2 pr-3 text-right align-top">
                      {monthlyRent != null ? (
                        <span className="text-[11px] text-zinc-600 tabular-nums">{fmt(monthlyRent)}</span>
                      ) : (
                        <span className="text-[11px] text-zinc-300">—</span>
                      )}
                    </td>

                    {/* Last Pmt */}
                    <td className="py-2 pr-3 text-right align-top">
                      <span className="text-[11px] text-zinc-300">—</span>
                    </td>

                    {/* Amount Due */}
                    <td className="py-2 pr-3 text-right align-top">
                      {!isVacant && !isCommitted ? (
                        room.amount_due != null && room.amount_due > 0 ? (
                          <span className="text-[11px] font-semibold text-red-600 tabular-nums">{fmt(room.amount_due)}</span>
                        ) : (
                          <span className="text-[11px] text-green-600">—</span>
                        )
                      ) : (
                        <span className="text-[11px] text-zinc-300">—</span>
                      )}
                    </td>

                    {/* Context-aware Notes */}
                    <td className="py-2 text-[10px] leading-snug align-top">{noteCell}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* RIGHT: Secondary info panels */}
      <div className="space-y-2 min-w-0">

        {/* Prospect Pipeline */}
        {pipeline.filter(p => p.stage !== 'moved_in').length > 0 && (
          <ProspectPanel pipeline={pipeline} />
        )}

        {/* Open Maintenance — top N by priority, expandable */}
        <div className="bg-white rounded-md border border-zinc-100 p-3">
          <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-400 mb-1.5">
            Maintenance{openNeeds.length > 0 ? ` · ${openNeeds.length} open` : ''}
          </div>
          {openNeeds.length === 0 ? (
            <p className="text-[11px] text-zinc-300">None open</p>
          ) : (
            <>
              <div className="divide-y divide-zinc-50">
                {visibleNeeds.map((n, i) => (
                  <div key={i} className="py-1.5 first:pt-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[9px] w-4 text-center py-0.5 rounded border shrink-0 ${
                        needPriorityCls[n.priority] ?? 'bg-zinc-100 text-zinc-500 border-zinc-200'
                      }`}>
                        {n.priority[0].toUpperCase()}
                      </span>
                      <span className="text-[11px] text-zinc-700 flex-1 truncate">{n.item}</span>
                      {n.unit && (
                        <span className="text-[9px] bg-zinc-100 text-zinc-500 border border-zinc-200 rounded px-1 py-0.5 shrink-0">{n.unit}</span>
                      )}
                      {n.cost != null && (
                        <span className="text-[10px] text-zinc-400 tabular-nums shrink-0">{fmt(n.cost)}</span>
                      )}
                    </div>
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
              {hiddenCount > 0 && (
                <button
                  onClick={() => setShowAllNeeds(v => !v)}
                  className="mt-1.5 text-[10px] text-blue-500 hover:text-blue-700 transition-colors"
                >
                  {showAllNeeds ? '▴ Show less' : `▾ View all (${openNeeds.length})`}
                </button>
              )}
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

        {/* Property Notes (status_updates) */}
        {(property.status_updates ?? []).length > 0 && (
          <div className="bg-white rounded-md border border-blue-100 p-3">
            <div className="text-[9px] uppercase tracking-[0.14em] text-blue-500 mb-1.5">
              Property Notes
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
                    <div className="text-zinc-600 mt-0.5">{note.text}</div>
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
  const flaggedRooms = roster.filter(r => r.flag || r.move_out_planned).length;
  const vacantRooms = occ.total - occ.occupied - occ.committed;
  const pct = occ.total > 0 ? Math.round((occ.occupied / occ.total) * 100) : null;
  const latestNote = (property.status_updates ?? [])
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))[0];

  const barColor = pct === 100 ? 'bg-green-500' : vacantRooms >= 2 ? 'bg-red-400' : 'bg-amber-400';
  const occColor = pct === 100 ? 'text-green-600' : vacantRooms >= 2 ? 'text-red-600' : 'text-amber-600';

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-zinc-50/80 transition-colors"
        aria-expanded={isOpen}
      >
        <span className="text-[10px] text-zinc-300 shrink-0 w-3 text-center select-none">
          {isOpen ? '▾' : '▸'}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={`text-[14px] font-semibold ${isOpen ? 'text-blue-600' : 'text-zinc-900'} transition-colors`}>
              {property.name}
            </span>
            <span className="text-[11px] text-zinc-400">{property.city}, {property.state}</span>
          </div>
        </div>

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
          {occ.committed > 0 && (
            <span className="text-[10px] bg-purple-50 text-purple-700 border border-purple-100 rounded-full px-2 py-0.5">
              {occ.committed} committed
            </span>
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
          {flaggedRooms > 0 && (
            <span className="text-[10px] bg-orange-50 text-orange-700 border border-orange-100 rounded-full px-2 py-0.5">
              ⚑ {flaggedRooms}
            </span>
          )}
          {latestNote && (
            <span className="text-[10px] text-blue-400 hidden sm:inline-block">
              ↳ note {relativeTime(latestNote.at)}
            </span>
          )}
        </div>
      </button>

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
