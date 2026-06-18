// Supabase auth — server client (server components + route handlers). Cookie-backed session via
// @supabase/ssr. Uses the public URL + anon key; RLS + the user's session enforce access. NEVER
// use the service-role key here (that's admin.ts, privileged, server-only).
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(URL, ANON, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // In a Server Component, set() throws — safe to ignore; middleware refreshes the session.
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          /* called from a Server Component — middleware handles cookie refresh */
        }
      },
    },
  });
}
