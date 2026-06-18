// Fleet box-side supabase-sync — the Supabase writer client.
//
// Runs ON each customer box (server-side, never in a browser). Uses a SCOPED SERVICE-ROLE key
// limited to writing its own org's fleet rows (per the schema-spec RLS). NEVER exposed to a client
// bundle, NEVER a NEXT_PUBLIC_ var.
//
// The Supabase project does not exist yet (fresh-vs-existing infra call pending Bode). This is
// code-complete and schema-aligned; it connects the moment SUPABASE_URL + the writer key are set.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

// The DEDICATED fleet project — `FLEET_*` ONLY. The bare SUPABASE_* in secrets point at a SHARED
// app (Bode's dating app); never use those here. FLEET_SUPABASE_SERVICE_ROLE_KEY is the box writer
// (server-only, scoped to fleet rows by RLS).
function fleetUrl() { return process.env.FLEET_SUPABASE_URL; }
function fleetKey() { return process.env.FLEET_SUPABASE_SERVICE_ROLE_KEY; }

export function getSyncClient(): SupabaseClient {
  const url = fleetUrl();
  const key = fleetKey();
  if (!url || !key) {
    throw new Error(
      'supabase-sync: FLEET_SUPABASE_URL + FLEET_SUPABASE_SERVICE_ROLE_KEY (server-only) are required. ' +
        'Do NOT fall back to the shared SUPABASE_* (different project). Set the FLEET_ vars on the box.',
    );
  }
  if (!_client) {
    _client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-fleet-sync': '1' } },
    });
  }
  return _client;
}

export function isConfigured(): boolean {
  return Boolean(fleetUrl() && fleetKey());
}
