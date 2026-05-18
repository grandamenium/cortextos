# GCP Flows Scripts

These scripts replace repeated computer-use driven GCP and Vercel setup flows with idempotent, parameterized TypeScript scripts.

## Prerequisites

- Node 20+
- Dependencies installed with `npm install`
- Run `gcp-auth-setup` once on an approved Orgo/Codex-CU browser lane before using the Playwright-backed Google Cloud Console scripts:

```bash
npx tsx scripts/gcp-flows/gcp-auth-setup.ts
```

The setup helper launches Chromium in headed mode, lets you log in to Google manually, and saves browser state to `scripts/gcp-flows/.auth/google-session.json`. It refuses to run on macOS unless an explicit approved Mac fallback sets `ALLOW_MAC_BROWSER_AUTOMATION=1` and `ORGO_FAILURE_ARTIFACT`.

## Environment Variables

All Google REST scripts load these values from `process.env`:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

The Vercel script also requires:

- `VERCEL_TOKEN`

`gcp-project-create` and `vercel-project-setup` use REST APIs only and do not need the browser session.

## Create a GCP Project

```bash
GOOGLE_CLIENT_ID=... \
GOOGLE_CLIENT_SECRET=... \
GOOGLE_REFRESH_TOKEN=... \
npx tsx scripts/gcp-flows/gcp-project-create.ts \
  --project-id my-gcp-project \
  --display-name "My GCP Project" \
  --parent-folder folders/123456789
```

If the project already exists, the script logs that it is skipping and exits successfully.

## Configure OAuth Consent

```bash
npx tsx scripts/gcp-flows/gcp-oauth-consent.ts \
  --project-id my-gcp-project \
  --app-name "My App" \
  --support-email support@example.com \
  --developer-email dev@example.com \
  --homepage-url https://myapp.com
```

This uses the saved browser session at `scripts/gcp-flows/.auth/google-session.json`.

## Create an OAuth Web Client

```bash
npx tsx scripts/gcp-flows/gcp-oauth-client-create.ts \
  --project-id my-gcp-project \
  --client-name "My App Web" \
  --origins https://myapp.com,https://preview.myapp.com \
  --redirect-uris https://myapp.com/api/auth/callback/google,https://preview.myapp.com/api/auth/callback/google
```

Credentials are written to `scripts/gcp-flows/output/CLIENT_NAME-credentials.json`.

## Set Up a Vercel Project

```bash
VERCEL_TOKEN=... \
npx tsx scripts/gcp-flows/vercel-project-setup.ts \
  --project-name my-vercel-project \
  --framework nextjs \
  --git-repo owner/repo \
  --env-vars ./env.json
```

`--env-vars` should point to a JSON object mapping env var names to values.

To request a production redeploy after setup:

```bash
VERCEL_TOKEN=... \
npx tsx scripts/gcp-flows/vercel-project-setup.ts \
  --project-name my-vercel-project \
  --redeploy
```
