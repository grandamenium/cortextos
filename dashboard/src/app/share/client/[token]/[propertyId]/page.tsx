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
    <span className={`inline-block text-[11px] px-2.5 py-0.5 rounded-full border ${cls} capitalize`}>
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
    <div className="flex items-start gap-3 py-3 border-b border-zinc-50 last:border-0">
      <div className="text-[11px] text-zinc-400 w-20 shrink-0 tabular-nums pt-0.5">{note.date}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-800 leading-snug">{note.note}</div>
        <div className="text-[11px] text-zinc-400 mt-1">
          {note.room} · {note.method} · {note.contact}
          {note.amount_discussed != null && ` · ${fmt(note.amount_discussed)}`}
        </div>
      </div>
      <span className={`text-[11px] shrink-0 font-medium capitalize ${outcomeColors[note.outcome] ?? 'text-zinc-400'}`}>
        {note.outcome.replace('-', ' ')}
      </span>
    </div>
  );
}

function RoomRow({ room, prospect }: { room: RoomRosterEntry; prospect?: { name: string; stage: string } }) {
  const notes = room.collection_notes ?? [];
  const isVacant = room.payment_status === 'vacant';
  const stageLabels: Record<string, string> = {
    applied: 'Applied',
    screening: 'Screening',
    approved: 'Approved',
    lease_signed: 'Lease Signed',
    moved_in: 'Moved In',
  };
  const borderAccent = statusLeftBorder[room.payment_status] ?? 'border-l-zinc-200';

  return (
    <div className={`border border-l-4 border-zinc-200 ${borderAccent} rounded-xl p-4 space-y-2 ${isVacant && prospect ? 'bg-blue-50/30' : 'bg-white'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-sm text-zinc-900">{room.room}</div>
        <div className="flex items-center gap-2">
          {isVacant && prospect && (
            <span className="inline-flex items-center gap-1.5 text-[11px] bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2.5 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
              {prospect.name} · {stageLabels[prospect.stage] ?? prospect.stage}
            </span>
          )}
          {statusBadge(room.payment_status)}
        </div>
      </div>
      {room.tenant && (
        <div className="text-[12px] text-zinc-500">{room.tenant}</div>
      )}
      <div className="flex flex-wrap gap-3 text-[11px] text-zinc-400">
        {room.amount_due != null && <span className="tabular-nums">Due: {fmt(room.amount_due)}</span>}
        {room.lease_expiration && <span>Lease exp: {room.lease_expiration}</span>}
        {room.eviction_status && <span className="text-red-500">{room.eviction_status}</span>}
        {room.notes && <span className="italic">{room.notes}</span>}
      </div>
      {notes.length > 0 && (
        <div className="mt-1 pt-3 border-t border-zinc-100">
          <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-400 mb-2">Collection Notes</div>
          {notes.map((n, i) => <CollectionNoteRow key={i} note={n} />)}
        </div>
      )}
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
  const collectionNotes = roster.flatMap(r => r.collection_notes ?? [])
    .sort((a, b) => b.date.localeCompare(a.date));

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Branded header with breadcrumb */}
      <div className="bg-zinc-900 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          <Link
            href={`/share/client/${token}`}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← Portfolio
          </Link>
          <span className="text-zinc-700">/</span>
          <h1 className="text-[15px] font-semibold text-white">{property.name}</h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">

        {/* Property header card */}
        <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
          <div className="flex items-start justify-between mb-6">
            <div>
              <div className="text-sm text-zinc-600">{property.city}, {property.state}</div>
              <div className="text-[12px] text-zinc-400 mt-0.5">{property.entity} · {property.type}</div>
            </div>
            <div className="text-[11px] text-zinc-400 tabular-nums">{today}</div>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-400 mb-1.5">Occupancy</div>
              <div className={`text-2xl font-bold tabular-nums ${
                roster.length === 0 ? 'text-zinc-300' :
                occupiedRooms.length === roster.length ? 'text-green-600' :
                vacantRooms.length >= 2 ? 'text-red-600' : 'text-amber-600'
              }`}>
                {roster.length > 0 ? `${occupiedRooms.length}/${roster.length}` : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-400 mb-1.5">Late</div>
              <div className={`text-2xl font-bold tabular-nums ${lateRooms.length > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {roster.length > 0 ? (lateRooms.length > 0 ? lateRooms.length : '✓') : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-400 mb-1.5">Eviction</div>
              <div className={`text-2xl font-bold tabular-nums ${evictionRooms.length > 0 ? 'text-red-700' : 'text-zinc-200'}`}>
                {evictionRooms.length > 0 ? evictionRooms.length : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-400 mb-1.5">Maint Items</div>
              <div className={`text-2xl font-bold tabular-nums ${openNeeds.length > 0 ? 'text-amber-600' : 'text-zinc-200'}`}>
                {openNeeds.length > 0 ? openNeeds.length : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Compliance */}
        <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 mb-4">Compliance</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {property.insurance ? (
              <div>
                <div className="text-sm font-medium text-zinc-700">Insurance</div>
                <div className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                  Renewal: {property.insurance.renewal_date}
                  {property.insurance.carrier && ` · ${property.insurance.carrier}`}
                  {property.insurance.amount != null && ` · ${fmt(property.insurance.amount)}/yr`}
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-zinc-400 italic">Insurance: not tracked</div>
            )}
            {property.taxes ? (
              <div>
                <div className="text-sm font-medium text-zinc-700">Property Tax</div>
                <div className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                  Due: {property.taxes.due_date}
                  {property.taxes.status && ` · ${property.taxes.status}`}
                  {property.taxes.amount != null && ` · ${fmt(property.taxes.amount)}`}
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-zinc-400 italic">Taxes: not tracked</div>
            )}
          </div>
        </div>

        {/* Utilities & HOA */}
        <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 mb-4">Utilities &amp; HOA</h3>
          {property.utilities ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {(['electric', 'water', 'gas', 'trash'] as const).map(key => {
                const u = property.utilities?.[key];
                if (!u) return null;
                return (
                  <div key={key}>
                    <div className="text-[11px] font-medium text-zinc-500 capitalize mb-1">{key}</div>
                    <div className="text-[12px] text-zinc-700">{u.provider ?? 'unknown'}</div>
                    {u.monthly_est != null && (
                      <div className="text-[11px] text-zinc-400 tabular-nums">~{fmt(u.monthly_est)}/mo</div>
                    )}
                    <div className={`text-[10px] mt-0.5 ${u.status === 'current' ? 'text-green-600' : u.status === 'overdue' ? 'text-red-500' : 'text-zinc-400'}`}>
                      {u.status}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[12px] text-zinc-400 italic">Utility details not yet tracked for this property</p>
          )}
          {property.hoa && property.hoa.status !== 'not_applicable' && (
            <div className="mt-4 pt-4 border-t border-zinc-100">
              <div className="text-[11px] font-medium text-zinc-500">HOA</div>
              <div className="text-[12px] text-zinc-600 mt-0.5">
                {property.hoa.name ?? 'Unknown HOA'}
                {property.hoa.monthly_fee != null && ` · ${fmt(property.hoa.monthly_fee)}/mo`}
                {' · '}{property.hoa.status}
              </div>
            </div>
          )}
        </div>

        {/* Tenant Roster */}
        {roster.length > 0 && (
          <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 mb-1">
              Tenant Roster
            </h3>
            <p className="text-[11px] text-zinc-400 mb-4">
              {occupiedRooms.length} occupied · {vacantRooms.length} vacant
            </p>
            <div className="space-y-2">
              {roster.map((r, i) => {
                const prospect = r.payment_status === 'vacant'
                  ? (property.prospect_pipeline ?? []).find(
                      p => p.room === r.room && p.stage !== 'moved_in'
                    )
                  : undefined;
                return <RoomRow key={i} room={r} prospect={prospect} />;
              })}
            </div>
          </div>
        )}

        {/* Collection Activity */}
        <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 mb-4">Collection Activity</h3>
          {collectionNotes.length > 0 ? (
            <div>
              {collectionNotes.map((n, i) => <CollectionNoteRow key={i} note={n} />)}
            </div>
          ) : (
            <p className="text-[12px] text-zinc-400 italic">No collection notes logged for this property</p>
          )}
        </div>

        {/* Open Maintenance */}
        {openNeeds.length > 0 && (
          <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 mb-1">
              Open Maintenance
            </h3>
            <p className="text-[11px] text-zinc-400 mb-4">{openNeeds.length} items</p>
            <div className="space-y-0">
              {openNeeds.map((n, i) => (
                <div key={i} className="flex items-start gap-3 py-3 border-b border-zinc-50 last:border-0">
                  <span className={`text-[10px] px-2 py-0.5 rounded border shrink-0 mt-0.5 font-medium ${needPriorityColors[n.priority] ?? 'bg-zinc-100 text-zinc-500 border-zinc-200'}`}>
                    {n.priority}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-800">{n.item}</div>
                    {n.unit && <div className="text-[11px] text-zinc-400 mt-0.5">{n.unit}</div>}
                    {n.notes && <div className="text-[11px] text-zinc-400 italic mt-0.5">{n.notes}</div>}
                  </div>
                  <span className={`text-[11px] shrink-0 font-medium ${needStatusColors[n.status] ?? 'text-zinc-400'}`}>
                    {n.status.replace('_', ' ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Outreach */}
        <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 mb-4">Recent Outreach (24h)</h3>
          {property.recent_outreach && property.recent_outreach.length > 0 ? (
            <div>
              {property.recent_outreach.slice(0, 10).map((o, i) => (
                <div key={i} className="flex items-start gap-3 py-2.5 border-b border-zinc-50 last:border-0">
                  <div className="text-[11px] text-zinc-400 w-24 shrink-0 tabular-nums pt-0.5">
                    {new Date(o.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-zinc-700">{o.to}{o.room ? ` · ${o.room}` : ''}</div>
                    {o.message_preview && (
                      <div className="text-[11px] text-zinc-400 italic truncate mt-0.5">{o.message_preview}</div>
                    )}
                  </div>
                  <span className="text-[10px] text-zinc-400 shrink-0 uppercase tracking-wider">{o.platform}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-zinc-400 italic">No outreach logged in last 24h</p>
          )}
        </div>

        {/* Low-occupancy fill effort */}
        {property.occupancy_outreach && property.occupancy_outreach.vacant_rooms > 0 && (
          <div className="bg-white rounded-xl border border-amber-200 shadow-sm p-6">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-600 mb-1">
              Fill Effort
            </h3>
            <p className="text-[11px] text-amber-600/70 mb-4">
              {property.occupancy_outreach.vacant_rooms} vacant room{property.occupancy_outreach.vacant_rooms > 1 ? 's' : ''}
            </p>
            {property.occupancy_outreach.outreach_log && property.occupancy_outreach.outreach_log.length > 0 ? (
              <div>
                {property.occupancy_outreach.outreach_log.map((e, i) => (
                  <div key={i} className="flex gap-3 text-[11px] py-2 border-b border-amber-50 last:border-0">
                    <span className="text-zinc-400 shrink-0 w-24 tabular-nums">{e.date}</span>
                    <span className="text-zinc-500 uppercase shrink-0 w-16 tracking-wider">{e.type}</span>
                    <span className="text-zinc-700">{e.detail}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-zinc-400 italic">No outreach logged yet for vacant rooms</p>
            )}
          </div>
        )}

        <p className="text-center text-[10px] text-zinc-300 pt-2">
          Read-only · Data refreshed by management system
        </p>
      </div>
    </div>
  );
}
