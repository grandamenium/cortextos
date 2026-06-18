// Supabase — privileged admin client (service-role). SERVER-ONLY, never imported into a client
// component or shipped to the browser. Bypasses RLS, so use it ONLY for trusted server actions
// (e.g. provisioning app_users/user_roles when an invite is accepted). Prefer the session-scoped
// server client (server.ts) everywhere else.
//
// SECURITY: uses the EXPLICIT fleet-scoped vars (FLEET_SUPABASE_*). The box environment exports a
// BARE SUPABASE_SERVICE_ROLE_KEY pointing at a DIFFERENT shared Supabase project, and Next.js lets
// real env vars override .env.local — so reading the bare key here could write fleet user data into
// the wrong project. We read FLEET_* only, and hard-guard that the key and URL are the same project.
import 'server-only';
import { createClient } from '@supabase/supabase-js';

function urlRef(url: string): string | null {
  return url.match(/https:\/\/([a-z0-9]+)\./)?.[1] ?? null;
}
function keyRef(jwt: string): string | null {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64').toString()).ref ?? null;
  } catch {
    return null;
  }
}

export function createAdminClient() {
  const url = process.env.FLEET_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.FLEET_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('admin client: FLEET_SUPABASE_URL + FLEET_SUPABASE_SERVICE_ROLE_KEY (server-only) required');
  }
  // The service-role key MUST belong to the same project as the URL — never cross
  // projects (defends against the bare SUPABASE_* key leaking in from the box env).
  const ur = urlRef(url);
  const kr = keyRef(key);
  if (!ur || !kr || ur !== kr) {
    throw new Error(`admin client: service-role key project (${kr}) != URL project (${ur}). Refusing to cross projects.`);
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
