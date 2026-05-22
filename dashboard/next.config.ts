import type { NextConfig } from "next";
import path from "path";

const allowedDevOrigins = (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// CSP: strict-ish — allows Next.js inline hydration scripts + Cloudflare Turnstile.
// 'unsafe-inline' on script-src is required for Next.js App Router until nonce support
// is fully wired; acceptable for a single-admin internal tool.
const ContentSecurityPolicy = `
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https:;
  font-src 'self' data:;
  connect-src 'self' https://challenges.cloudflare.com;
  frame-src https://challenges.cloudflare.com;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  upgrade-insecure-requests;
`.replace(/\s{2,}/g, ' ').trim();

const securityHeaders = [
  { key: 'Content-Security-Policy', value: ContentSecurityPolicy },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // HSTS: 2-year max-age, includeSubDomains, preload — set here for non-CF-proxied paths;
  // Cloudflare also injects HSTS at the edge for proxied requests.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  // Confine NFT file tracing to dashboard/ — prevents it from tracing into
  // the cortextOS monorepo root (skills/, templates/, etc.) which don't exist
  // in the Vercel build environment and cause deploy-time ENOENT errors.
  outputFileTracingRoot: path.join(__dirname),
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
  async headers() {
    return [
      {
        source: '/((?!_next/static).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
          ...securityHeaders,
        ],
      },
    ];
  },
};

export default nextConfig;
