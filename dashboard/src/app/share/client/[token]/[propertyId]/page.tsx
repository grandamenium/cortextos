import { getPropertiesByClientToken } from '@/lib/data/properties';
import type { RoomRosterEntry, CollectionNote } from '@/lib/data/properties';
import { notFound } from 'next/navigation';
import Link from 'next/link';

function fmt(n: number | null | undefined) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US');
}

const paymentBadge: Record<string, string> = {
  current: 'bg-green-50 text-green-700 border-green-200',
  late: 'bg-red-50 text-red-700 border-red-200',
  delinquent: 'bg-red-100 text-red-800 border-red-300 font-semibold',
  eviction: 'bg-red-200 text-red-900 border-red-400 font-bold',
  vacant: 'bg-zinc-100 text-zinc-500 border-zinc-200',
};

const statusLeftBorder: Record<string, string> = {
  current: 'border-l-green-500',
  late: 'border-l-red-400',
  delinquent: 'border-l-red-500',
  eviction: 'border-l-red-700',
  vacant: 'border-l-zinc-200',
};

function statusBadge(status: string) {
  const cls = paymentBadge[status] ?? 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full border ${cls} capitalize`}>
      {status}
    </span>
  );
}

const needPriorityColors: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-zinc-100 text-zinc-500 border-zinc-200',
};

const needStatusColors: Record<string, string> = {
  needed: 'text-red-600',
  in_progress: 'text-blue-600',
  quote_pending: 'text-purple-600',
  pending: 'text-amber-600',
  on_hold: 'text-zinc-400',
  done: 'text-green-600',
};

function CollectionNoteRow({ note }: { note: CollectionNote }) {
  const outcomeColors: Record<string, string> = {
    paid: 'text-green-600',
    partial: 'text-amber-600',
    'promise-to-pay': 'text-blue-600',
    pending: 'text-zinc-400',
    'no-response': 'text-red-500',
  };
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-zinc-50 last:border-0">
      <div className="text-[10px] text-zinc-400 w-16 shrink-0 tabular-nums pt-0.5">{note.date}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-zinc-800 leading-snug">{note.note}</div>
        <div className="text-[10px] text-zinc-400 mt-0.5">
          {note.room} · {note.method} · {note.contact}
          {note.amount_discussed != null && ` · ${fmt(note.amount_discussed)}`}
        </div>
      </div>
      <span className={`text-[10px] shrink-0 font-medium capitalize ${outcomeColors[note.outcome] ?? 'text-zinc-400'}`}>
        {note.outcome.replace('-', ' ')}
      </span>
    </div>
  );
}

function RoomRow({ room, prospect }: { room: RoomRosterEntry; prospect?: { name: string; stage: string } }) {
  const notes = room.collection_notes ?? [];
  const isVacant = room.payment_status === 'vacant';
  const stageLabels: Record<string, string> = {
    applied: 'Applied', screening: 'Screening', approved: 'Approved',
    lease_signed: 'Lease Signed', moved_in: 'Moved In',
  };
  const borderAccent = statusLeftBorder[room.payment_status] ?? 'border-l-zinc-200';
  return (
    <div className={`border border-l-4 border-zinc-200 ${borderAccent} rounded-lg p-3 ${isVacant && prospect ? 'bg-blue-50/30' : 'bg-white'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-[13px] text-zinc-900">{room.room}</div>
        <div className="flex items-center gap-1.5">
          {isVacant && prospect && (
            <span className="inline-flex items-center gap-1 text-[10px] bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">
              <span className="w-1 h-1 rounded-full bg-blue-500 shrink-0" />
              {prospect.name} · {stageLabels[prospect.stage] ?? prospect.stage}
            </span>
          )}
          {statusBadge(room.payment_status)}
        </div>
      </div>
      {(room.tenant || room.amount_due != null || room.lease_expiration || room.eviction_status || room.notes) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-zinc-400">
          {room.tenant && <span>{room.tenant}</span>}
          {room.amount_due != null && <span className="tabular-nums">Due: {fmt(room.amount_due)}</span>}
          {room.lease_expiration && <span>Exp: {room.lease_expiration}</span>}
          {room.eviction_status && <span className="text-red-500">{room.eviction_status}</span>}
          {room.notes && <span className="italic">{room.notes}</span>}
        </div>
      )}
      {notes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-zinc-100">
          <div className="text-[9px] uppercase tracking-[0.12em] text-zinc-400 mb-1">Collection Notes</div>
          {notes.map((n, i) => <CollectionNoteRow key={i} note={n} />)}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-2">
      <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400">{title}</h3>
      {count && <span className="text-[10px] text-zinc-300">{count}</span>}
    </div>
  );
}

export default async function ClientPropertyDetailPage({
  params,
}: {
  params: Promise<{ token: string; propertyId: string }>;
}) {
  const { token, propertyId } = await params;
  const properties = getPropertiesByClientToken(token);
  if (properties.length === 0) notFound();
  const property = properties.find(p => p.id === propertyId);
  if (!property) notFound();

  const openNeeds = property.needs?.filter(n => n.status !== 'done') ?? [];
  const roster = property.room_roster ?? [];
  const occupiedRooms = roster.filter(r => r.payment_status !== 'vacant');
  const vacantRooms = roster.filter(r => r.payment_status === 'vacant');
  const lateRooms = roster.filter(r => r.payment_status === 'late' || r.payment_status === 'delinquent');
  const evictionRooms = roster.filter(r => r.payment_status === 'eviction');
  const collectionNotes = roster.flatMap(r => r.collection_notes ?? []).sort((a, b) => b.date.localeCompare(a.date));
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      <div className="bg-zinc-900 px-5 py-3.5">
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          <Link href={`/share/client/${token}`} className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors">
            ← Portfolio
          </Link>
          <span className="text-zinc-700">/</span>
          <h1 className="text-[14px] font-semibold text-white">{property.name}</h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-4 space-y-3">

        {/* Property stats */}
        <div className="bg-white rounded-lg border border-zinc-200 shadow-sm p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="text-[13px] text-zinc-600">{property.city}, {property.state}</div>
              <div className="text-[11px] text-zinc-400">{property.entity} · {property.type}</div>
            </div>
            <div className="text-[10px] text-zinc-400 tabular-nums">{today}</div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {[
              {
                label: 'Occupancy',
                value: roster.length > 0 ? `${occupiedRooms.length}/${roster.length}` : '—',
                color: roster.length === 0 ? 'text-zinc-300' : occupiedRooms.length === roster.length ? 'text-green-600' : vacantRooms.length >= 2 ? 'text-red-600' : 'text-amber-600',
              },
              {
                label: 'Late',
                value: roster.length > 0 ? (lateRooms.length > 0 ? String(lateRooms.length) : '✓') : '—',
                color: lateRooms.length > 0 ? 'text-red-600' : 'text-green-600',
              },
              {
                label: 'Eviction',
                value: evictionRooms.length > 0 ? String(evictionRooms.length) : '—',
                color: evictionRooms.length > 0 ? 'text-red-700' : 'text-zinc-200',
              },
              {
                label: 'Maint',
                value: openNeeds.length > 0 ? String(openNeeds.length) : '—',
                color: openNeeds.length > 0 ? 'text-amber-600' : 'text-zinc-200',
              },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div className="text-[9px] uppercase tracking-[0.12em] text-zinc-400 mb-1">{label}</div>
                <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Compliance + Utilities merged */}
        <div className="bg-white rounded-lg border border-zinc-200 shadow-sm p-4">
          <SectionHeader title="Compliance &amp; Utilities" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-0">
            {property.insurance ? (
              <div>
                <div className="text-[11px] font-medium text-zinc-600">Insurance</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">
                  Renewal: {property.insurance.renewal_date}
                  {property.insurance.carrier && ` · ${property.insurance.carrier}`}
                  {property.insurance.amount != null && ` · ${fmt(property.insurance.amount)}/yr`}
                </div>
              </div>
            ) : <div className="text-[11px] text-zinc-400 italic">Insurance: not tracked</div>}
            {property.taxes ? (
              <div>
                <div className="text-[11px] font-medium text-zinc-600">Property Tax</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">
                  Due: {property.taxes.due_date}
                  {property.taxes.status && ` · ${property.taxes.status}`}
                  {property.taxes.amount != null && ` · ${fmt(property.taxes.amount)}`}
                </div>
              </div>
            ) : <div className="text-[11px] text-zinc-400 italic">Taxes: not tracked</div>}
          </div>
          {property.utilities && (
            <div className="mt-3 pt-3 border-t border-zinc-100 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(['electric', 'water', 'gas', 'trash'] as const).map(key => {
                const u = property.utilities?.[key];
                if (!u) return null;
                return (
                  <div key={key}>
                    <div className="text-[10px] font-medium text-zinc-500 capitalize">{key}</div>
                    <div className="text-[11px] text-zinc-700">{u.provider ?? 'unknown'}</div>
                    {u.monthly_est != null && <div className="text-[10px] text-zinc-400 tabular-nums">~{fmt(u.monthly_est)}/mo</div>}
                    <div className={`text-[10px] ${u.status === 'current' ? 'text-green-600' : u.status === 'overdue' ? 'text-red-500' : 'text-zinc-400'}`}>{u.status}</div>
                  </div>
                );
              })}
            </div>
          )}
          {property.hoa && property.hoa.status !== 'not_applicable' && (
            <div className="mt-3 pt-3 border-t border-zinc-100">
              <span className="text-[10px] font-medium text-zinc-500">HOA: </span>
              <span className="text-[11px] text-zinc-600">
                {property.hoa.name ?? 'Unknown'}
                {property.hoa.monthly_fee != null && ` · ${fmt(property.hoa.monthly_fee)}/mo`}
                {' · '}{property.hoa.status}
              </span>
            </div>
          )}
        </div>

        {/* Tenant Roster */}
        {roster.length > 0 && (
          <div className="bg-white rounded-lg border border-zinc-200 shadow-sm p-4">
            <SectionHeader title="Tenant Roster" count={`${occupiedRooms.length} occupied · ${vacantRooms.length} vacant`} />
            <div className="space-y-1.5">
              {roster.map((r, i) => {
                const prospect = r.payment_status === 'vacant'
                  ? (property.prospect_pipeline ?? []).find(p => p.room === r.room && p.stage !== 'moved_in')
                  : undefined;
                return <RoomRow key={i} room={r} prospect={prospect} />;
              })}
            </div>
          </div>
        )}

        {/* Open Maintenance — collapsible if present */}
        {openNeeds.length > 0 && (
          <details open className="bg-white rounded-lg border border-zinc-200 shadow-sm">
            <summary className="p-4 cursor-pointer list-none flex items-center justify-between">
              <SectionHeader title="Open Maintenance" count={`${openNeeds.length} items`} />
              <span className="text-[10px] text-zinc-300 ml-auto">▾</span>
            </summary>
            <div className="px-4 pb-3 border-t border-zinc-100 pt-2">
              {openNeeds.map((n, i) => (
                <div key={i} className="flex items-start gap-2 py-1.5 border-b border-zinc-50 last:border-0">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 mt-0.5 font-medium ${needPriorityColors[n.priority] ?? 'bg-zinc-100 text-zinc-500 border-zinc-200'}`}>
                    {n.priority}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-zinc-800">{n.item}</div>
                    {n.unit && <div className="text-[10px] text-zinc-400">{n.unit}</div>}
                    {n.notes && <div className="text-[10px] text-zinc-400 italic">{n.notes}</div>}
                  </div>
                  <span className={`text-[10px] shrink-0 font-medium ${needStatusColors[n.status] ?? 'text-zinc-400'}`}>
                    {n.status.replace('_', ' ')}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* Collection Activity — collapsible */}
        <details open={collectionNotes.length > 0} className="bg-white rounded-lg border border-zinc-200 shadow-sm">
          <summary className="p-4 cursor-pointer list-none flex items-center justify-between">
            <SectionHeader title="Collection Activity" count={collectionNotes.length > 0 ? `${collectionNotes.length}` : undefined} />
            <span className="text-[10px] text-zinc-300 ml-auto">▾</span>
          </summary>
          <div className="px-4 pb-3 border-t border-zinc-100 pt-2">
            {collectionNotes.length > 0 ? (
              collectionNotes.map((n, i) => <CollectionNoteRow key={i} note={n} />)
            ) : (
              <p className="text-[11px] text-zinc-400 italic">No collection notes logged</p>
            )}
          </div>
        </details>

        {/* Recent Outreach — collapsible */}
        <details open={!!(property.recent_outreach?.length)} className="bg-white rounded-lg border border-zinc-200 shadow-sm">
          <summary className="p-4 cursor-pointer list-none flex items-center justify-between">
            <SectionHeader title="Recent Outreach (24h)" />
            <span className="text-[10px] text-zinc-300 ml-auto">▾</span>
          </summary>
          <div className="px-4 pb-3 border-t border-zinc-100 pt-2">
            {property.recent_outreach && property.recent_outreach.length > 0 ? (
              property.recent_outreach.slice(0, 10).map((o, i) => (
                <div key={i} className="flex items-start gap-2 py-1.5 border-b border-zinc-50 last:border-0">
                  <div className="text-[10px] text-zinc-400 w-20 shrink-0 tabular-nums">
                    {new Date(o.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-zinc-700">{o.to}{o.room ? ` · ${o.room}` : ''}</div>
                    {o.message_preview && <div className="text-[10px] text-zinc-400 italic truncate">{o.message_preview}</div>}
                  </div>
                  <span className="text-[9px] text-zinc-400 shrink-0 uppercase tracking-wider">{o.platform}</span>
                </div>
              ))
            ) : (
              <p className="text-[11px] text-zinc-400 italic">No outreach logged in last 24h</p>
            )}
          </div>
        </details>

        {/* Fill Effort — collapsible, only if vacant */}
        {property.occupancy_outreach && property.occupancy_outreach.vacant_rooms > 0 && (
          <details open className="bg-white rounded-lg border border-amber-200 shadow-sm">
            <summary className="p-4 cursor-pointer list-none flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-600">Fill Effort</h3>
                <span className="text-[10px] text-amber-500">{property.occupancy_outreach.vacant_rooms} vacant</span>
              </div>
              <span className="text-[10px] text-amber-300 ml-auto">▾</span>
            </summary>
            <div className="px-4 pb-3 border-t border-amber-100 pt-2">
              {property.occupancy_outreach.outreach_log?.length ? (
                property.occupancy_outreach.outreach_log.map((e, i) => (
                  <div key={i} className="flex gap-2 text-[10px] py-1.5 border-b border-amber-50 last:border-0">
                    <span className="text-zinc-400 shrink-0 w-20 tabular-nums">{e.date}</span>
                    <span className="text-zinc-500 uppercase shrink-0 w-14 tracking-wider">{e.type}</span>
                    <span className="text-zinc-700">{e.detail}</span>
                  </div>
                ))
              ) : (
                <p className="text-[11px] text-zinc-400 italic">No outreach logged yet</p>
              )}
            </div>
          </details>
        )}

        <p className="text-center text-[9px] text-zinc-300 pt-1">
          Read-only · Data refreshed by management system
        </p>
      </div>
    </div>
  );
}
