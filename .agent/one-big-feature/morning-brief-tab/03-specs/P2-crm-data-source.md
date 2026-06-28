# P2 — CRM pipeline data source

**Goal:** Read-only `getCrmPipeline()` over `interactions.jsonl`, exposed via a route, with tests.

## Create `src/lib/data/crm.ts`
```ts
export interface CrmRecentContact { contactId: string; type: string; date: string; summary: string; }
export interface CrmPipeline { total: number; last7d: number; recent: CrmRecentContact[]; }
export function getCrmPipeline(): CrmPipeline
```
- Path resolution: reuse `getFrameworkRoot()` / `getCTXRoot()` from `@/lib/config` (same as `api/tasks/route.ts`). File =
  `join(<root>, 'orgs/clearworksai/agents/crm/crm/interactions.jsonl')`. Validate root against the existing `SAFE_PATH_REGEX` pattern used in `api/tasks/route.ts`.
- Read with `fs.readFileSync(path, 'utf-8')`, split on `\n`, `JSON.parse` each non-empty line inside try/catch — **skip malformed lines, never throw**.
- Each record shape: `{ ts, contact_id, type, summary, ... }`.
- `total` = count of valid records. `last7d` = records with `ts` within 7×24h of now.
- `recent` = newest 5 by `ts`, mapped to `{ contactId: contact_id, type, date: ts, summary: summary.slice(0,80) }`.
- Missing file (`ENOENT`) → return `{ total: 0, last7d: 0, recent: [] }`.
- No `any` (type the parsed line as `Record<string, unknown>` and narrow). No `console.log` — `console.error` only on unexpected read failure.

## Create `src/app/api/crm/pipeline/route.ts`
- `export const dynamic = 'force-dynamic';` GET handler returns `Response.json(getCrmPipeline())`, wrapped in try/catch → `{ error }` 500 on failure (match `api/tasks` shape).

## Create `src/lib/data/__tests__/crm.test.ts`
- Happy path: temp JSONL with 3 records (one >7d old) → asserts `total=3`, `last7d=2`, `recent` newest-first, summary truncated.
- Missing file → `{ total:0, last7d:0, recent:[] }`.
- Malformed line interleaved with valid → malformed skipped, valid counted.
- Use the project's existing test runner/fixture pattern (see `src/app/api/comms/__tests__/routes.test.ts`).

## Acceptance
- `npm test` green incl. new test. `npm run build` clean.
- `GET /api/crm/pipeline` returns live totals from the real file in dev.
