#!/usr/bin/env node
// opencode-usage — read OpenCode Go (Zen) subscription usage: rolling / weekly / monthly quota.
//
// WHY THIS EXISTS
//   OpenCode Go exposes a live usage API. The canonical endpoint
//   `GET /zen/go/v1/usage` (Bearer-auth) is deployed — opencode PR #16513 merged 2026-08-11 —
//   and returns { usage: { rolling|weekly|monthly: {status,percent,resetsAt} } }.
//   `opencode stats` only reports local session token cost, not subscription quota.
//   The dashboard cookie scrape (community workaround, opencode issue #18648) is kept as a
//   fallback for keys/environments where the API is unreachable.
//
// STRATEGY (API-first; both the merged and the earlier proposed body shapes are parsed)
//   1. PRIMARY  — GET https://opencode.ai/zen/go/v1/usage  (Authorization: Bearer <key>).
//                 Uses the same key opencode-go agents already authenticate with.
//   2. FALLBACK — dashboard cookie scrape (needs OPENCODE_AUTH_COOKIE + workspace id).
//
// Zero runtime dependencies (Node >=18 global fetch). Cross-platform.
//
// USAGE
//   node scripts/opencode-usage.mjs                  # human table (matches `opencode usage` UX)
//   node scripts/opencode-usage.mjs --json           # structured JSON envelope
//   node scripts/opencode-usage.mjs --store <ctxRoot># also write envelope to <ctxRoot>/state/usage/
//   node scripts/opencode-usage.mjs --key sk-...     # explicit key (else env / auth.json)
//
// KEY RESOLUTION (first hit wins)
//   --key <k>  >  $OPENCODE_GO_API_KEY  >  $OPENCODE_API_KEY  >  ~/.local/share/opencode/auth.json (opencode-go.key)
// COOKIE (fallback only): $OPENCODE_AUTH_COOKIE ; workspace: $OPENCODE_WORKSPACE_ID or --workspace

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const DEFAULT_BASE = "https://opencode.ai"
const UA = "Mozilla/5.0 (compatible; cortextos-opencode-usage/0.1)"

export function parseArgs(argv) {
  const a = { json: false, key: null, workspace: null, store: null, debug: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === "--json") a.json = true
    else if (v === "--debug") a.debug = true
    else if (v === "--key") a.key = argv[++i]
    else if (v === "--workspace") a.workspace = argv[++i]
    else if (v === "--store") a.store = argv[++i]
    else if (v === "-h" || v === "--help") a.help = true
  }
  return a
}

export function resolveKey(cliKey, env = process.env, authPath = null) {
  if (cliKey) return cliKey.trim()
  if (env.OPENCODE_GO_API_KEY) return env.OPENCODE_GO_API_KEY.trim()
  if (env.OPENCODE_API_KEY) return env.OPENCODE_API_KEY.trim()
  try {
    const p = authPath || join(homedir(), ".local", "share", "opencode", "auth.json")
    const j = JSON.parse(readFileSync(p, "utf8"))
    for (const id of ["opencode-go", "opencode", "zen"]) {
      if (j[id] && typeof j[id].key === "string") return j[id].key.trim()
    }
    for (const val of Object.values(j)) if (val && typeof val.key === "string") return val.key.trim()
  } catch {}
  return null
}

// ---- PRIMARY: canonical Bearer endpoint (upstream shape) --------------------
export async function fetchPrimary(key, base = DEFAULT_BASE, fetchImpl = fetch) {
  const url = `${base}/zen/go/v1/usage`
  let res
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, "user-agent": UA, accept: "application/json" },
    })
  } catch (e) {
    return { ok: false, kind: "network", detail: String(e), url }
  }
  const ct = res.headers.get("content-type") || ""
  if (res.status === 404) return { ok: false, kind: "not-deployed", status: 404, url }
  if (res.status === 401) return { ok: false, kind: "unauthorized", status: 401, url }
  if (!res.ok || !ct.includes("json")) return { ok: false, kind: "unexpected", status: res.status, url }
  const body = await res.json()
  // Two accepted shapes:
  //   MERGED  (#16513, live): { usage: { rolling|weekly|monthly: {status,percent,resetsAt} } }
  //   LEGACY  (early proposal): { plan, useBalance, windows: [{name,status,usagePercent,resetInSec,used,limit}] }
  if (body?.usage && typeof body.usage === "object") {
    const windows = []
    for (const name of ["rolling", "weekly", "monthly"]) {
      const w = body.usage[name]
      if (w && typeof w === "object") {
        windows.push({
          name,
          status: w.status ?? null,
          usagePercent: w.percent ?? null,
          resetsAt: w.resetsAt ?? null,
          resetInSec: null,
          used: null,
          limit: null,
        })
      }
    }
    return {
      ok: true,
      method: "bearer-api",
      plan: body.plan ?? null,
      useBalance: body.useBalance ?? null,
      windows,
      url,
    }
  }
  return {
    ok: true,
    method: "bearer-api",
    plan: body.plan ?? null,
    useBalance: body.useBalance ?? null,
    windows: Array.isArray(body.windows) ? body.windows : [],
    url,
  }
}

// ---- FALLBACK: dashboard cookie scrape (works today, fragile) ---------------
export async function fetchFallback(cookie, workspaceId, base = DEFAULT_BASE, fetchImpl = fetch) {
  if (!cookie) return { ok: false, kind: "no-cookie" }
  if (!workspaceId) return { ok: false, kind: "no-workspace" }
  const url = `${base}/workspace/${workspaceId}`
  let html
  try {
    const res = await fetchImpl(url, {
      headers: {
        cookie: `auth=${cookie}`,
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        referer: `${base}/`,
      },
    })
    if (res.status === 401 || res.status === 403) return { ok: false, kind: "cookie-rejected", status: res.status }
    html = await res.text()
  } catch (e) {
    return { ok: false, kind: "network", detail: String(e) }
  }
  return parseDashboardHtml(html, url)
}

// Pure parser split out for testability.
export function parseDashboardHtml(html, url = null) {
  const clean = html.replace(/<!--\$-->/g, "").replace(/<!--\/?-->/g, "")
  const windows = []
  const pct = (label, re) => {
    const m = clean.match(re)
    if (m) windows.push({ name: label, status: "ok", usagePercent: Number(m[1]), resetInSec: null, used: null, limit: null })
  }
  pct("rolling", /Rolling Usage.*?(\d+)%/s)
  pct("weekly", /Weekly Usage.*?(\d+)%/s)
  pct("monthly", /Monthly Usage.*?(\d+)%/s)
  const bal = clean.match(/Current balance.*?\$?(\d+\.?\d*)/s)
  if (windows.length === 0 && !bal) return { ok: false, kind: "parse-failed", url }
  return { ok: true, method: "dashboard-scrape", plan: null, useBalance: null, windows, balance: bal ? Number(bal[1]) : null, url }
}

// ---- rendering / normalization ---------------------------------------------
export function fmtReset(sec) {
  if (sec == null) return "unknown"
  if (sec <= 0) return "now"
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.ceil((sec % 3600) / 60)
  const u = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`
  if (d > 0) return h > 0 ? `${u(d, "day")} ${u(h, "hour")}` : u(d, "day")
  if (h > 0) return m > 0 ? `${u(h, "hour")} ${u(m, "minute")}` : u(h, "hour")
  return m > 0 ? u(m, "minute") : "less than a minute"
}
// Seconds-until-reset from either shape: prefer numeric resetInSec, else derive from resetsAt ISO.
export function resetSeconds(w, now = Date.now()) {
  if (w.resetInSec != null) return w.resetInSec
  if (w.resetsAt != null) {
    const t = Date.parse(w.resetsAt)
    if (!Number.isNaN(t)) return Math.round((t - now) / 1000)
  }
  return null
}
export const money = (v) => (v == null ? "—" : `$${Number(v).toFixed(2)}`)
export function bar(p) {
  const f = Math.round((Math.min(100, Math.max(0, p)) / 100) * 10)
  return "█".repeat(f) + "░".repeat(10 - f)
}
export function planLabel(plan) {
  return plan === "lite" ? "Go (Lite)" : plan === "black" ? "Black" : (plan ?? "unknown")
}
export function renderHuman(r) {
  const lines = []
  lines.push("┌──────────────────────────────────────────────────────┐")
  lines.push("│                       GO USAGE                        │")
  lines.push("├──────────────────────────────────────────────────────┤")
  lines.push(`  Plan: ${planLabel(r.plan)}${r.useBalance == null ? "" : `   Use Balance: ${r.useBalance ? "On" : "Off"}`}`)
  lines.push(`  via: ${r.method}`)
  if (r.balance != null) lines.push(`  Zen balance: ${money(r.balance)}`)
  if (!r.windows || r.windows.length === 0) {
    lines.push("  (no active usage windows)")
  } else {
    for (const w of r.windows) {
      const dot = w.status === "rate-limited" ? "●!" : "●"
      const used = w.used != null ? `  ${money(w.used)} / ${money(w.limit)}` : ""
      lines.push(`  ${dot} ${w.name} limit  ${w.usagePercent}%  ${bar(w.usagePercent)}${used}`)
      lines.push(`     resets in ${fmtReset(resetSeconds(w))}`)
    }
  }
  lines.push("└──────────────────────────────────────────────────────┘")
  return lines.join("\n")
}

export function envelope(r, now = new Date().toISOString()) {
  return {
    source: "opencode-go",
    method: r.method,
    plan: r.plan ?? null,
    useBalance: r.useBalance ?? null,
    balance: r.balance ?? null,
    windows: (r.windows || []).map((w) => ({
      name: w.name,
      status: w.status ?? null,
      usagePercent: w.usagePercent ?? null,
      used: w.used ?? null,
      limit: w.limit ?? null,
      resetInSec: w.resetInSec ?? null,
      resetsAt: w.resetsAt ?? null,
    })),
    endpoint: r.url,
    fetched_at: now,
  }
}

// ---- store (usage-monitor plug) --------------------------------------------
// Mirrors src/bus/metrics.ts storeUsageData: <ctxRoot>/state/usage/opencode-go-latest.json + daily jsonl.
export function storeEnvelope(ctxRoot, env) {
  const dir = join(ctxRoot, "state", "usage")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "opencode-go-latest.json"), JSON.stringify(env, null, 2) + "\n", "utf-8")
  const day = (env.fetched_at || "").slice(0, 10) || "unknown"
  appendFileSync(join(dir, `opencode-go-${day}.jsonl`), JSON.stringify(env) + "\n", "utf-8")
  return join(dir, "opencode-go-latest.json")
}

// ---- orchestration (pure-ish; injectable fetch for tests) -------------------
export async function getUsage({ key, base = DEFAULT_BASE, cookie = null, workspace = null, fetchImpl = fetch }) {
  const primary = await fetchPrimary(key, base, fetchImpl)
  if (primary.ok) return { result: primary, primary }
  if (primary.kind === "unauthorized") return { result: null, primary, unauthorized: true }
  const fb = await fetchFallback(cookie, workspace, base, fetchImpl)
  if (fb.ok) return { result: fb, primary, fallback: fb }
  return { result: null, primary, fallback: fb }
}

// ---- CLI main ---------------------------------------------------------------
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log("opencode-usage — OpenCode Go rolling/weekly/monthly quota. Flags: --json --store <ctxRoot> --key <k> --workspace <id> --debug")
    return 0
  }
  const key = resolveKey(args.key, env, env.OPENCODE_AUTH_PATH || null)
  if (!key) {
    const msg = "No OpenCode Go API key found (checked --key, $OPENCODE_GO_API_KEY, $OPENCODE_API_KEY, ~/.local/share/opencode/auth.json)."
    if (args.json) console.log(JSON.stringify({ source: "opencode-go", ok: false, error: msg }))
    else console.error(msg)
    return 2
  }
  const base = env.OPENCODE_BASE_URL || DEFAULT_BASE
  const cookie = env.OPENCODE_AUTH_COOKIE || null
  const workspace = args.workspace || env.OPENCODE_WORKSPACE_ID || null

  const { result, primary, unauthorized, fallback } = await getUsage({ key, base, cookie, workspace })
  if (args.debug) console.error("[debug] primary:", JSON.stringify({ ...primary, windows: undefined }))

  if (result) {
    const env0 = envelope(result)
    if (args.store) {
      try { const p = storeEnvelope(args.store, env0); if (args.debug) console.error("[debug] stored:", p) }
      catch (e) { console.error("store failed:", String(e)) }
    }
    if (args.json) console.log(JSON.stringify(env0))
    else console.log(renderHuman(result))
    return 0
  }

  if (unauthorized) {
    const msg = "OpenCode Go key rejected (401). Key invalid or lacks Go subscription."
    if (args.json) console.log(JSON.stringify({ source: "opencode-go", ok: false, error: msg, status: 401 }))
    else console.error(msg)
    return 3
  }

  const reason =
    primary.kind === "not-deployed"
      ? "Endpoint /zen/go/v1/usage returned 404 (it is live since opencode #16513 merged 2026-08-11; a 404 now means the wrong base URL or a key without Go access). "
      : `Primary failed (${primary.kind}${primary.status ? " " + primary.status : ""}). `
  const fb = fallback || { kind: "no-cookie" }
  const fbReason =
    fb.kind === "no-cookie" ? "No OPENCODE_AUTH_COOKIE set for dashboard fallback."
    : fb.kind === "no-workspace" ? "Cookie present but no workspace id (set --workspace / $OPENCODE_WORKSPACE_ID)."
    : fb.kind === "cookie-rejected" ? "Dashboard cookie rejected (expired session cookie)."
    : `Dashboard fallback failed (${fb.kind}).`
  const out = { source: "opencode-go", ok: false, primary: primary.kind, fallback: fb.kind, error: reason + fbReason }
  if (args.json) console.log(JSON.stringify(out))
  else {
    console.error(reason + fbReason)
    console.error("The Bearer API is the primary path; if it is unreachable, the fallback needs an opencode.ai browser `auth` cookie (DevTools > Application > Cookies > opencode.ai) as OPENCODE_AUTH_COOKIE, plus the workspace id.")
  }
  return 4
}

// run only when executed directly, not when imported by tests
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirect) {
  main().then((code) => process.exit(code))
}
