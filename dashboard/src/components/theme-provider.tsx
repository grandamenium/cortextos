'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  // next-themes v0.4.x injects a <script> tag to prevent FOUC.
  // React 19 warns about script tags inside components.
  // Using forcedTheme prevents the script injection entirely since
  // the theme is static and no client-side detection is needed.
  return (
    <NextThemesProvider {...props} forcedTheme="light">
      {children}
    </NextThemesProvider>
  );
}
