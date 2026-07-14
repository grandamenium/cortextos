#!/usr/bin/env node
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const SECRETS_DIR = path.join(__dirname, '../../../secrets');
const PROPERTIES_DIR = path.join(
  require('os').homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default',
  'orgs', process.env.CTX_ORG || 'atlasos', 'properties'
);

// Tasks confirmed resolved by Jennifer — permanently suppressed from dashboard
// regardless of DoorLoop status. Add task IDs here; they will never regenerate.
const USER_CONFIRMED_RESOLVED = {
  '6948b02d8fc75c6b21732bba': 'Dryer Gas Hookup — Jennifer confirmed installed; DL task stale (confirmed ~50x)',
};

function loadKey() {
  if (process.env.DOORLOOP_API_KEY) return process.env.DOORLOOP_API_KEY;
  const keyFile = path.join(SECRETS_DIR, 'doorloop_api_key.txt');
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  throw new Error('DOORLOOP_API_KEY not found in env or secrets/doorloop_api_key.txt');
}

function doorloopGet(apiKey, endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'app.doorloop.com',
      path: '/api/' + endpoint,
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Parse error for ' + endpoint + ': ' + d.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAll(apiKey, resource) {
  const all = [];
  let page = 1;
  while (true) {
    const res = await doorloopGet(apiKey, `${resource}?limit=200&page=${page}`);
    const items = res.data || [];
    all.push(...items);
    if (items.length < 200) break;
    page++;
  }
  return all;
}

function derivePaymentStatus(lease) {
  if (!lease) return 'vacant';
  const s = (lease.recurringRentStatus || '').toUpperCase();
  if (s === 'EVICTION' || s === 'EVICTION_FILED') return 'eviction';
  if (lease.overdueBalance > 0) return 'late';
  return 'current';
}

function deriveEvictionStatus(lease) {
  const s = (lease.recurringRentStatus || '').toUpperCase();
  if (s === 'EVICTION' || s === 'EVICTION_FILED') return 'eviction in progress';
  return null;
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function mapTaskStatus(s) {
  const u = (s || '').toUpperCase();
  if (u === 'OPEN') return 'needed';
  if (u === 'IN_PROGRESS') return 'in_progress';
  if (u === 'PENDING_APPROVAL') return 'pending';
  if (u === 'COMPLETED') return 'done';
  return 'needed';
}

function mapTaskPriority(p) {
  const u = (p || '').toUpperCase();
  if (u === 'URGENT') return 'urgent';
  if (u === 'HIGH') return 'high';
  if (u === 'MEDIUM') return 'medium';
  return 'low';
}

async function main() {
  const apiKey = loadKey();
  console.log('[doorloop-sync] Starting...');

  const [allLeases, allUnits, allTasks, allPayments] = await Promise.all([
    fetchAll(apiKey, 'leases'),
    fetchAll(apiKey, 'units'),
    fetchAll(apiKey, 'tasks'),
    fetchAll(apiKey, 'lease-payments'),
  ]);

  console.log(`[doorloop-sync] Fetched ${allLeases.length} leases, ${allUnits.length} units, ${allTasks.length} tasks, ${allPayments.length} payments`);

  // Build latest payment per lease ID (most recent date wins)
  const latestPaymentByLease = {};
  for (const pmt of allPayments) {
    if (!pmt.lease || !pmt.date || !pmt.amountReceived) continue;
    const existing = latestPaymentByLease[pmt.lease];
    if (!existing || pmt.date > existing.date) {
      latestPaymentByLease[pmt.lease] = { date: pmt.date, amount: pmt.amountReceived };
    }
  }

  // Group open tasks by DoorLoop property ID
  const tasksByProperty = {};
  for (const task of allTasks) {
    if (!task.property) continue;
    const status = (task.status || '').toUpperCase();
    if (status === 'COMPLETED') continue; // only include open/in-progress
    if (!tasksByProperty[task.property]) tasksByProperty[task.property] = [];
    tasksByProperty[task.property].push(task);
  }

  // Build unit ID → unit name lookup
  const unitNames = {};
  for (const u of allUnits) {
    unitNames[u.id] = u.name || u.unitNumber || u.id;
  }

  // Group active leases by property ID
  const leasesByProperty = {};
  for (const lease of allLeases) {
    if (lease.status !== 'ACTIVE') continue;
    const propId = lease.property;
    if (!leasesByProperty[propId]) leasesByProperty[propId] = [];
    leasesByProperty[propId].push(lease);
  }

  // Build unit → lease lookup per property (unit ID → lease)
  const unitLeaseMap = {};
  for (const lease of allLeases) {
    if (lease.status !== 'ACTIVE') continue;
    for (const unitId of (lease.units || [])) {
      unitLeaseMap[unitId] = lease;
    }
  }

  if (!fs.existsSync(PROPERTIES_DIR)) {
    console.log('[doorloop-sync] Properties dir not found:', PROPERTIES_DIR);
    return;
  }

  const files = fs.readdirSync(PROPERTIES_DIR).filter(f => f.endsWith('.json'));
  let synced = 0;

  for (const file of files) {
    const filePath = path.join(PROPERTIES_DIR, file);
    let prop;
    try { prop = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { continue; }

    if (!prop.doorloop_property_id) continue;

    const propId = prop.doorloop_property_id;
    const propUnits = allUnits.filter(u => u.property === propId);
    const propLeases = leasesByProperty[propId] || [];

    if (propUnits.length === 0 && propLeases.length === 0) {
      console.log(`[doorloop-sync] ${file}: no DoorLoop data found for property ${propId}`);
      continue;
    }

    // room_roster[].notes is a CURATED, human/agent-owned field (edited via the
    // dashboard + set by Atlas/Timber) and is the authoritative Notes column.
    // It must survive every sync: snapshot the existing notes by normalized room
    // key and re-apply them onto the rebuilt roster. The sync NEVER writes note
    // text of its own (overdue/deposit amounts live in the Due column, not Notes).
    const normRoom = s => (s || '').toLowerCase().replace(/\s+/g, '');
    const priorNotes = new Map(
      (prop.room_roster || []).map(r => [normRoom(r.room), r.notes ?? null])
    );

    // Strip DL status prefixes like "retired | " from tenant names
    const sanitizeTenant = n => n ? n.replace(/^[^|]+\|\s*/, '').trim() : n;

    // Build room_roster from units (each unit gets a row, occupied or vacant)
    const roster = propUnits.map(unit => {
      const lease = unitLeaseMap[unit.id];
      const roomName = unitNames[unit.id] || unit.id;
      if (lease) {
        return {
          room: roomName,
          tenant: sanitizeTenant(lease.name) || null,
          lease_expiration: lease.end || null,
          payment_status: derivePaymentStatus(lease),
          amount_due: lease.totalBalanceDue > 0 ? lease.totalBalanceDue : null,
          last_payment: latestPaymentByLease[lease.id] ?? null,
          eviction_status: deriveEvictionStatus(lease),
          notes: priorNotes.get(normRoom(roomName)) ?? null,
        };
      } else {
        return {
          room: roomName,
          tenant: null,
          lease_expiration: null,
          payment_status: 'vacant',
          amount_due: null,
          last_payment: null,
          eviction_status: null,
          notes: priorNotes.get(normRoom(roomName)) ?? null,
        };
      }
    });

    // Also catch leases that reference units not in our unit list
    for (const lease of propLeases) {
      for (const unitId of (lease.units || [])) {
        if (!propUnits.find(u => u.id === unitId)) {
          const roomName = unitNames[unitId] || unitId;
          roster.push({
            room: roomName,
            tenant: sanitizeTenant(lease.name) || null,
            lease_expiration: lease.end || null,
            payment_status: derivePaymentStatus(lease),
            amount_due: lease.totalBalanceDue > 0 ? lease.totalBalanceDue : null,
            last_payment: latestPaymentByLease[lease.id] ?? null,
            eviction_status: deriveEvictionStatus(lease),
            notes: priorNotes.get(normRoom(roomName)) ?? null,
          });
        }
      }
    }

    roster.sort((a, b) => (a.room || '').localeCompare(b.room || ''));

    prop.room_roster = roster;

    // Sync open maintenance tasks → needs[]
    // Preserve manually-curated needs (those without a doorloop_task_id).
    // For DL-sourced needs: DL wins on all fields EXCEPT status — if an agent
    // manually marked a DL item done/resolved locally, that override is preserved
    // until Ashley closes it in DL (at which point DL drops it from the open list).
    const existingManual = (prop.needs || []).filter(n => !n.doorloop_task_id);
    const localDoneOverrides = {};
    for (const n of (prop.needs || [])) {
      if (n.doorloop_task_id && (n.status === 'done' || n.status === 'resolved')) {
        localDoneOverrides[n.doorloop_task_id] = n.status;
      }
    }
    const propTasks = tasksByProperty[propId] || [];
    const dlNeeds = propTasks.map(t => ({
      item: t.subject || '(no subject)',
      unit: null,
      vendor: null,
      cost: null,
      status: USER_CONFIRMED_RESOLVED[t.id] ? 'resolved' : (localDoneOverrides[t.id] ?? mapTaskStatus(t.status)),
      priority: mapTaskPriority(t.priority),
      notes: null,
      doorloop_task_id: t.id,
      doorloop_updated_at: t.updatedAt || null,
    }));
    prop.needs = [...existingManual, ...dlNeeds];

    prop.updated_at = new Date().toISOString();
    prop.last_report = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    prop.last_report_by = 'DoorLoop sync';

    atomicWrite(filePath, prop);
    const pmtCount = roster.filter(r => r.last_payment).length;
    console.log(`[doorloop-sync] ${file}: ${roster.length} units (${roster.filter(r => r.tenant).length} occ), ${dlNeeds.length} open tasks, ${pmtCount}/${roster.length} rooms with last_payment`);
    synced++;
  }

  console.log(`[doorloop-sync] Done. ${synced} property file(s) updated.`);
}

main().catch(e => { console.error('[doorloop-sync] Error:', e.message); process.exit(1); });
