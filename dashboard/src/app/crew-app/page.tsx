// Standalone Crew app — the phone-first companion chat, outside the
// dashboard shell (no sidebar, topbar, or bottom nav). Installable as its
// own PWA: this route carries its own manifest and icons, so "Add to Home
// Screen" from /crew-app produces a separate "Crew" app that launches
// straight into the roster, independent of the main dashboard PWA.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { CrewAppClient } from './crew-app-client';

export const metadata: Metadata = {
  title: 'Crew',
  manifest: '/crew.webmanifest',
  icons: {
    icon: [{ url: '/crew-icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/crew-apple-touch.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Crew',
  },
};

export default async function CrewAppPage() {
  const session = await auth();
  if (!session) redirect('/login?callbackUrl=/crew-app');
  return <CrewAppClient />;
}
