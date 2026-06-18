// Supabase auth — middleware session refresh. Runs on every request: refreshes the auth cookies
// and returns the authenticated user (verified server-side via getUser(), NOT just cookie presence
// — per the security spec). The app middleware uses this to gate routes + drive RBAC redirects.
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { User } from '@supabase/supabase-js';

export async function updateSession(request: NextRequest): Promise<{ response: NextResponse; user: User | null }> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // getUser() re-validates the JWT with the auth server — a real check, not cookie presence.
  const { data: { user } } = await supabase.auth.getUser();
  return { response, user };
}
