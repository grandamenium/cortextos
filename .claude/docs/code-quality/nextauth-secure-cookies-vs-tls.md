---
domain: [auth, deployment, dashboard]
applies_to: [engineer, fullstack]
severity: blocker
---

# NextAuth secure cookie flag must track TLS availability, not deployment mode

**`secure: process.env.NODE_ENV === 'production'` breaks local-HTTP and private-network sign-in.** `next start` runs in production mode unconditionally, which forces Secure cookies. Browsers refuse to store/send Secure cookies over plain HTTP, including the CSRF cookie — login fails with `MissingCSRF` or post-redirect "Network error" before the user lands on a real page.

## Pattern fix

`secure: process.env.AUTH_COOKIE_SECURE === 'true'` (env-controlled, default false for local-friendly setup). Set `AUTH_COOKIE_SECURE=true` in production env when behind Cloudflare Tunnel / Tailscale Serve / reverse proxy with TLS.

## Rule of thumb

`NODE_ENV === 'production'` is a deployment-mode check, not a TLS-availability check. Cookie security flags should track TLS availability, not deployment mode. Same trap recurs for any cookie/header that conflates "is production" with "has HTTPS."

## Source incident

Micro-retro 2026-05-05 — Saurav's auth fix be445f0 in cortextOS dashboard. Login flow broke on Tailscale tailnet (private network, plain HTTP); browsers wouldn't store the CSRF cookie.
