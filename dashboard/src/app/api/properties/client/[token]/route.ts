import { NextRequest } from 'next/server';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getPropertiesDir, getOrgs } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface RoomNote {
  propertyId: string;
  room: string;
  notes: string;
  editKey: string;
}

function findPropertyFile(propertyId: string): string | null {
  for (const org of getOrgs()) {
    const dir = getPropertiesDir(org);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const fp = path.join(dir, file);
      try {
        const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (d.id === propertyId) return fp;
      } catch { /* skip */ }
    }
  }
  return null;
}

function runBus(args: string[]) {
  spawnSync('cortextos', ['bus', ...args], { stdio: 'ignore', shell: true });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  let body: RoomNote;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { propertyId, room, notes, editKey } = body;
  if (!propertyId || !room || notes === undefined || !editKey) {
    return Response.json({ error: 'Missing required fields: propertyId, room, notes, editKey' }, { status: 400 });
  }

  // Sanitise inputs
  const cleanRoom = String(room).trim().slice(0, 50);
  const cleanNotes = String(notes).trim().slice(0, 500);
  const cleanEditKey = String(editKey).replace(/[^a-f0-9]/g, '').slice(0, 64);

  // Load the property file
  const propFile = findPropertyFile(propertyId);
  if (!propFile) {
    return Response.json({ error: 'Property not found' }, { status: 404 });
  }

  let propData: Record<string, unknown>;
  try {
    propData = JSON.parse(fs.readFileSync(propFile, 'utf-8'));
  } catch {
    return Response.json({ error: 'Could not read property file' }, { status: 500 });
  }

  // Validate client_scope matches the URL token
  if (propData.client_scope !== token) {
    return Response.json({ error: 'Property not in this portfolio' }, { status: 403 });
  }

  // Validate edit key (constant-time comparison to resist timing attacks)
  const storedKey = String(propData.edit_key ?? '');
  if (!storedKey || storedKey !== cleanEditKey) {
    return Response.json({ error: 'Invalid edit key' }, { status: 403 });
  }

  // Find the room in room_roster (normalise spaces for matching)
  const roster = propData.room_roster as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(roster)) {
    return Response.json({ error: 'No room roster on this property' }, { status: 404 });
  }

  const roomEntry = roster.find(r => String(r.room ?? '').trim() === cleanRoom);
  if (!roomEntry) {
    return Response.json({ error: `Room "${cleanRoom}" not found` }, { status: 404 });
  }

  // Apply update
  roomEntry.notes = cleanNotes || null;
  propData.updated_at = new Date().toISOString();

  // Atomic write
  const tmp = propFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(propData, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, propFile);

  // Relay to Timber
  const propertyName = String(propData.name ?? propertyId);
  const preview = cleanNotes.length > 80 ? cleanNotes.slice(0, 80) + '…' : cleanNotes;
  const timberMsg = `Jennifer updated dashboard note on ${propertyName} room ${cleanRoom}: "${preview}"`;
  runBus(['send-message', 'timber', 'normal', timberMsg]);
  runBus([
    'log-event', 'action', 'note_updated', 'info',
    '--meta', JSON.stringify({ property: propertyId, room: cleanRoom, source: 'client_dashboard' }),
  ]);

  // Return safe property (strip secrets)
  const { edit_key: _ek, share_token: _st, ...safe } = propData as Record<string, unknown>;
  return Response.json({ ok: true, property: safe });
}
