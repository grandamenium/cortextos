/**
 * scripts/opencode-usage.mjs — OpenCode Go usage reader.
 *
 * OpenCode Go exposes a live usage API: GET /zen/go/v1/usage (Bearer auth) is deployed —
 * anomalyco/opencode #16513 merged 2026-08-11 — and returns usage:{rolling,weekly,monthly}.
 * This script parses that merged shape, keeps back-compat for the legacy windows[] shape,
 * and falls back to a dashboard cookie scrape when the API is unreachable. These tests pin:
 *   (1) key resolution precedence, (2) the primary 200 parse (both shapes) into the fleet
 *   envelope, (3) 404 -> cookie fallback -> precise failure, (4) --store writes the
 *   usage-monitor files, (5) rendering + reset formatting. A regression here would silently
 *   report wrong quota (or a false "no data") and let agents blow past Go limits mid-run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  parseArgs,
  resolveKey,
  fetchPrimary,
  fetchFallback,
  parseDashboardHtml,
  fmtReset,
  bar,
  planLabel,
  renderHuman,
  envelope,
  storeEnvelope,
  getUsage,
  main,
} from "../../../scripts/opencode-usage.mjs"

// Minimal Response-like stub so we never touch the network.
function res(status: number, body: string, contentType = "application/json") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
  }
}
const USAGE_200 = JSON.stringify({
  plan: "lite",
  useBalance: false,
  windows: [
    { name: "rolling", status: "ok", usagePercent: 42, resetInSec: 5400, used: 2.1, limit: 5 },
    { name: "monthly", status: "rate-limited", usagePercent: 97, resetInSec: 864000, used: 194, limit: 200 },
  ],
})
// Real body from the merged endpoint (opencode #16513, live GET /zen/go/v1/usage).
const USAGE_REAL = JSON.stringify({
  usage: {
    rolling: { status: "ok", percent: 52, resetsAt: "2026-09-23T00:34:52.704Z" },
    weekly: { status: "ok", percent: 20, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 61, resetsAt: "2026-09-25T14:30:41.000Z" },
  },
})

describe("opencode-usage: parseArgs", () => {
  it("parses flags and values", () => {
    const a = parseArgs(["--json", "--key", "sk-x", "--workspace", "wrk_1", "--store", "/root", "--debug"])
    expect(a).toMatchObject({ json: true, key: "sk-x", workspace: "wrk_1", store: "/root", debug: true })
  })
})

describe("opencode-usage: resolveKey precedence", () => {
  it("prefers --key, then env, then auth.json", () => {
    expect(resolveKey("sk-cli", { OPENCODE_GO_API_KEY: "sk-env" })).toBe("sk-cli")
    expect(resolveKey(null, { OPENCODE_GO_API_KEY: "sk-go", OPENCODE_API_KEY: "sk-generic" })).toBe("sk-go")
    expect(resolveKey(null, { OPENCODE_API_KEY: "sk-generic" })).toBe("sk-generic")
  })
  it("reads opencode-go.key from an auth.json file", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-auth-"))
    const p = join(dir, "auth.json")
    writeFileSync(p, JSON.stringify({ "opencode-go": { type: "api", key: "sk-fromfile" } }))
    expect(resolveKey(null, {}, p)).toBe("sk-fromfile")
    rmSync(dir, { recursive: true, force: true })
  })
  it("returns null when nothing is available", () => {
    expect(resolveKey(null, {}, "/nonexistent/auth.json")).toBeNull()
  })
})

describe("opencode-usage: fetchPrimary", () => {
  it("parses the real merged usage:{rolling,weekly,monthly} shape (#16513)", async () => {
    const r = await fetchPrimary("sk-x", "https://x", async () => res(200, USAGE_REAL))
    expect(r.ok).toBe(true)
    expect(r.method).toBe("bearer-api")
    expect(r.windows).toHaveLength(3)
    expect(r.windows.map((w: any) => w.name)).toEqual(["rolling", "weekly", "monthly"])
    expect(r.windows.map((w: any) => w.usagePercent)).toEqual([52, 20, 61])
    for (const w of r.windows) {
      expect(typeof w.resetsAt).toBe("string")
      expect(w.used).toBeNull()
      expect(w.limit).toBeNull()
      expect(w.resetInSec).toBeNull()
    }
  })
  it("parses a legacy windows[] 200 (back-compat)", async () => {
    const r = await fetchPrimary("sk-x", "https://x", async () => res(200, USAGE_200))
    expect(r.ok).toBe(true)
    expect(r.method).toBe("bearer-api")
    expect(r.plan).toBe("lite")
    expect(r.windows).toHaveLength(2)
    expect(r.windows[1]).toMatchObject({ name: "monthly", usagePercent: 97, status: "rate-limited" })
  })
  it("flags a 404 (unexpected now the endpoint is live; still a handled state)", async () => {
    const r = await fetchPrimary("sk-x", "https://x", async () => res(404, "<!DOCTYPE html>", "text/html"))
    expect(r).toMatchObject({ ok: false, kind: "not-deployed", status: 404 })
  })
  it("flags 401 as unauthorized", async () => {
    const r = await fetchPrimary("sk-x", "https://x", async () => res(401, "{}"))
    expect(r).toMatchObject({ ok: false, kind: "unauthorized", status: 401 })
  })
  it("does not trust a 200 that is not JSON", async () => {
    const r = await fetchPrimary("sk-x", "https://x", async () => res(200, "<html>", "text/html"))
    expect(r).toMatchObject({ ok: false, kind: "unexpected" })
  })
  it("captures network errors", async () => {
    const r = await fetchPrimary("sk-x", "https://x", async () => { throw new Error("boom") })
    expect(r).toMatchObject({ ok: false, kind: "network" })
  })
})

describe("opencode-usage: fetchFallback + parseDashboardHtml", () => {
  it("requires a cookie and a workspace", async () => {
    expect(await fetchFallback(null, "wrk_1")).toMatchObject({ kind: "no-cookie" })
    expect(await fetchFallback("ck", null)).toMatchObject({ kind: "no-workspace" })
  })
  it("scrapes rolling/weekly/monthly percentages and balance", () => {
    const html = "Current balance $12.50 ... Rolling Usage 30% Resets ... Weekly Usage 55% ... Monthly Usage 80%"
    const r = parseDashboardHtml(html)
    expect(r.ok).toBe(true)
    expect(r.balance).toBe(12.5)
    expect(r.windows.map((w: any) => [w.name, w.usagePercent])).toEqual([
      ["rolling", 30], ["weekly", 55], ["monthly", 80],
    ])
  })
  it("reports parse-failed when nothing matches", () => {
    expect(parseDashboardHtml("totally unrelated page")).toMatchObject({ ok: false, kind: "parse-failed" })
  })
  it("rejects an expired cookie (403)", async () => {
    const r = await fetchFallback("ck", "wrk_1", "https://x", async () => res(403, "nope", "text/html"))
    expect(r).toMatchObject({ ok: false, kind: "cookie-rejected", status: 403 })
  })
})

describe("opencode-usage: getUsage orchestration", () => {
  it("returns primary when it succeeds", async () => {
    const { result } = await getUsage({ key: "sk", base: "https://x", fetchImpl: async () => res(200, USAGE_200) })
    expect(result?.method).toBe("bearer-api")
  })
  it("returns the real merged shape from the primary", async () => {
    const { result } = await getUsage({ key: "sk", base: "https://x", fetchImpl: async () => res(200, USAGE_REAL) })
    expect(result?.method).toBe("bearer-api")
    expect(result?.windows).toHaveLength(3)
  })
  it("falls back to the cookie scrape on 404", async () => {
    const fetchImpl = async (url: string) =>
      url.includes("/zen/go/v1/usage")
        ? res(404, "<!DOCTYPE html>", "text/html")
        : res(200, "Rolling Usage 10%", "text/html")
    const { result, primary, fallback } = await getUsage({ key: "sk", base: "https://x", cookie: "ck", workspace: "wrk_1", fetchImpl })
    expect(primary.kind).toBe("not-deployed")
    expect(result?.method).toBe("dashboard-scrape")
    expect(fallback?.windows?.[0]).toMatchObject({ name: "rolling", usagePercent: 10 })
  })
  it("surfaces 401 without attempting fallback", async () => {
    const { result, unauthorized } = await getUsage({ key: "sk", base: "https://x", fetchImpl: async () => res(401, "{}") })
    expect(result).toBeNull()
    expect(unauthorized).toBe(true)
  })
  it("returns no result when 404 and no cookie", async () => {
    const { result, primary, fallback } = await getUsage({ key: "sk", base: "https://x", fetchImpl: async () => res(404, "x", "text/html") })
    expect(result).toBeNull()
    expect(primary.kind).toBe("not-deployed")
    expect(fallback.kind).toBe("no-cookie")
  })
})

describe("opencode-usage: envelope + store", () => {
  const norm = { ok: true, method: "bearer-api", plan: "lite", useBalance: false, windows: [{ name: "rolling", status: "ok", usagePercent: 42, resetInSec: 5400, used: 2.1, limit: 5 }], url: "https://x/zen/go/v1/usage" }
  it("builds a stable monitor envelope keyed source:opencode-go", () => {
    const e = envelope(norm as any, "2026-07-03T00:00:00.000Z")
    expect(e).toMatchObject({ source: "opencode-go", method: "bearer-api", plan: "lite", fetched_at: "2026-07-03T00:00:00.000Z" })
    expect(e.windows[0]).toMatchObject({ name: "rolling", usagePercent: 42, used: 2.1, limit: 5 })
  })
  it("maps a real-shape window with resetsAt and null used/limit", () => {
    const real = { ok: true, method: "bearer-api", plan: null, useBalance: null, windows: [{ name: "rolling", status: "ok", usagePercent: 52, resetsAt: "2026-09-23T00:34:52.704Z", resetInSec: null, used: null, limit: null }], url: "https://x/zen/go/v1/usage" }
    const e = envelope(real as any, "2026-09-22T00:00:00.000Z")
    expect(e.windows[0]).toMatchObject({ name: "rolling", usagePercent: 52, resetsAt: "2026-09-23T00:34:52.704Z", used: null, limit: null })
  })
  it("--store writes latest.json + a daily jsonl under state/usage", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-store-"))
    const e = envelope(norm as any, "2026-07-03T09:00:00.000Z")
    const p = storeEnvelope(root, e)
    const latest = JSON.parse(readFileSync(p, "utf8"))
    expect(latest.source).toBe("opencode-go")
    const files = readdirSync(join(root, "state", "usage"))
    expect(files).toContain("opencode-go-latest.json")
    expect(files).toContain("opencode-go-2026-07-03.jsonl")
    rmSync(root, { recursive: true, force: true })
  })
})

describe("opencode-usage: rendering helpers", () => {
  it("formats reset windows", () => {
    expect(fmtReset(null)).toBe("unknown")
    expect(fmtReset(0)).toBe("now")
    expect(fmtReset(90 * 60)).toBe("1 hour 30 minutes")
    expect(fmtReset(3 * 86400)).toBe("3 days")
  })
  it("labels plans and clamps the bar", () => {
    expect(planLabel("lite")).toBe("Go (Lite)")
    expect(planLabel("black")).toBe("Black")
    expect(bar(200)).toBe("██████████")
    expect(bar(-5)).toBe("░░░░░░░░░░")
  })
  it("renders a real-shape window (resetsAt, null $ fields) without $ or NaN", () => {
    const future = new Date(Date.now() + 2 * 86400000).toISOString()
    const out = renderHuman({ method: "bearer-api", plan: null, useBalance: null, windows: [{ name: "rolling", status: "ok", usagePercent: 52, resetsAt: future, resetInSec: null, used: null, limit: null }] } as any)
    expect(out).toContain("52%")
    expect(out).toContain("resets in")
    expect(out).not.toContain("$")
    expect(out).not.toContain("NaN")
  })
  it("renders a human table with a rate-limited marker", () => {
    const out = renderHuman({ method: "bearer-api", plan: "lite", useBalance: false, windows: [{ name: "monthly", status: "rate-limited", usagePercent: 97, resetInSec: 864000, used: 194, limit: 200 }] } as any)
    expect(out).toContain("GO USAGE")
    expect(out).toContain("Go (Lite)")
    expect(out).toContain("●! monthly limit  97%")
  })
})

describe("opencode-usage: main exit codes", () => {
  it("exits 2 when no key is resolvable", async () => {
    const code = await main(["--json"], { OPENCODE_AUTH_PATH: "/nonexistent/auth.json" })
    expect(code).toBe(2)
  })
})
