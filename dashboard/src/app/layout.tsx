import type { Metadata } from "next";
import { Sora, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

// Brand-aware metadata: set ASCENDOPS_BRAND=1 in the dashboard's environment
// (e.g. via .env.local in the dashboard directory) to show AscendOps branding.
// Uses generateMetadata() instead of a static `metadata` export so that
// process.env.ASCENDOPS_BRAND is evaluated at request time on the server,
// not baked in at build time (Next.js static metadata evaluation would always
// read an empty string if the var is set only in the runtime environment).
export async function generateMetadata(): Promise<Metadata> {
  const isAscendOps = process.env.ASCENDOPS_BRAND === "1";
  return {
    title: isAscendOps ? "AscendOps Dashboard" : "cortextOS Dashboard",
    description: isAscendOps
      ? "AscendOps property management AI platform"
      : "cortextOS agent orchestration dashboard",
    viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: isAscendOps ? "AscendOps" : "cortextOS",
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <SessionProvider>
          <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
            <TooltipProvider>
              {children}
            </TooltipProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
