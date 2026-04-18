'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';
import { useEffect, useState } from 'react';

export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  // next-themes v0.4.x injects a <script> tag to prevent FOUC.
  // React 19 warns about script tags rendered inside components.
  // Defer mounting until client-side to avoid the SSR script injection.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    // During SSR / first render, just render children without theme provider.
    // This avoids the script tag warning. Theme defaults to light via CSS.
    return <>{children}</>;
  }

  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
