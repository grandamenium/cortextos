// Dashboard API: cortextOS framework upstream status
// Shows pending upstream commits + last sync timestamp.
// Used by dashboard widget so user always knows whether framework is current.

import { NextResponse } from "next/server"
import { execFileSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface UpstreamStatus {
  ok: boolean
  current_sha: string
  current_message: string
  pending_count: number
  pending_commits: Array<{ sha: string; title: string; classification: "fix" | "feat" | "chore" | "other" }>
  last_check: string
  last_applied: string | null
  needs_review_count: number
}

function classify(title: string): "fix" | "feat" | "chore" | "other" {
  if (/^fix[(:]/i.test(title)) return "fix"
  if (/^feat[(:]|^BREAKING/i.test(title)) return "feat"
  if (/^(chore|docs|test|refactor|style|build|ci)[(:]/i.test(title)) return "chore"
  return "other"
}

function gitOutput(args: string[], cwd: string, timeoutMs = 10000): string {
  try {
    return execFileSync("git", args, { cwd, timeout: timeoutMs, encoding: "utf-8" }).trim()
  } catch {
    return ""
  }
}

export async function GET(): Promise<NextResponse<UpstreamStatus | { error: string }>> {
  const FRAMEWORK_ROOT = process.env.CTX_FRAMEWORK_ROOT || "/Users/arndt/cortextos"
  const CTX_ROOT = process.env.CTX_ROOT || join(homedir(), ".cortextos", "default")

  try {
    // Fetch upstream silently (best-effort — don't fail if offline)
    gitOutput(["fetch", "upstream", "--quiet"], FRAMEWORK_ROOT)

    const currentSha = gitOutput(["rev-parse", "HEAD"], FRAMEWORK_ROOT)
    const currentMessage = gitOutput(["log", "-1", "--pretty=%s", "HEAD"], FRAMEWORK_ROOT)
    const pendingLog = gitOutput(
      ["log", "origin/main..upstream/main", "--pretty=format:%h|%s", "--no-merges"],
      FRAMEWORK_ROOT
    )
    const pending = pendingLog.split("\n").filter(Boolean).map(l => {
      const [sha, ...rest] = l.split("|")
      const title = rest.join("|")
      return { sha, title, classification: classify(title) }
    })

    const notifiedPath = join(CTX_ROOT, "state", "upstream-notified.json")
    let lastCheck = new Date().toISOString()
    let lastApplied: string | null = null
    if (existsSync(notifiedPath)) {
      try {
        const data = JSON.parse(readFileSync(notifiedPath, "utf-8"))
        lastCheck = data.last_check ?? lastCheck
        lastApplied = data.last_applied ?? null
      } catch {
        // ignore parse errors
      }
    }

    const needsReview = pending.filter(c => c.classification === "feat").length

    return NextResponse.json({
      ok: true,
      current_sha: currentSha.slice(0, 7),
      current_message: currentMessage,
      pending_count: pending.length,
      pending_commits: pending.slice(0, 25),
      last_check: lastCheck,
      last_applied: lastApplied,
      needs_review_count: needsReview,
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
