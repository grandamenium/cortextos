"use client"

import { useEffect, useState } from "react"
import { GitBranch, AlertCircle, CheckCircle2, GitCommit } from "lucide-react"

interface UpstreamCommit {
  sha: string
  title: string
  classification: "fix" | "feat" | "chore" | "other"
}

interface UpstreamStatus {
  ok: boolean
  current_sha: string
  current_message: string
  pending_count: number
  pending_commits: UpstreamCommit[]
  last_check: string
  last_applied: string | null
  needs_review_count: number
}

export function UpstreamStatusWidget() {
  const [status, setStatus] = useState<UpstreamStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    fetch("/api/upstream", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.ok) setStatus(d)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="rounded-md border border-border/50 bg-card/50 p-3 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5 animate-pulse" />
          cortextOS Framework prüft …
        </div>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="rounded-md border border-border/50 bg-card/50 p-3 text-xs text-muted-foreground">
        Upstream-Status nicht verfügbar
      </div>
    )
  }

  const isCurrent = status.pending_count === 0
  const fixCount = status.pending_commits.filter(c => c.classification === "fix").length

  return (
    <div className="rounded-md border border-border/50 bg-card/50 p-3 text-xs">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-label="cortextOS Framework Status anzeigen"
      >
        <div className="flex items-center gap-2">
          {isCurrent ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-amber-500" aria-hidden />
          )}
          <span className="font-medium">
            cortextOS Framework
          </span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {isCurrent ? "aktuell" : `${status.pending_count} pending`}
        </span>
      </button>

      <div className="mt-1.5 truncate text-[10px] text-muted-foreground">
        {status.current_sha} · {status.current_message}
      </div>

      {!isCurrent && (
        <div className="mt-2 space-y-1 text-[10px]">
          <div className="flex justify-between text-muted-foreground">
            <span>{fixCount} Bugfixes (auto-mergeable)</span>
            {status.needs_review_count > 0 && (
              <span className="font-medium text-amber-600">
                {status.needs_review_count} Features brauchen Review
              </span>
            )}
          </div>
        </div>
      )}

      {expanded && status.pending_commits.length > 0 && (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto border-t border-border/30 pt-2">
          {status.pending_commits.map(c => (
            <div key={c.sha} className="flex items-start gap-1.5 text-[10px]">
              <GitCommit
                className={`mt-0.5 h-2.5 w-2.5 shrink-0 ${
                  c.classification === "fix"
                    ? "text-emerald-500"
                    : c.classification === "feat"
                    ? "text-amber-500"
                    : "text-muted-foreground"
                }`}
                aria-hidden
              />
              <span className="flex-1 truncate font-mono">
                {c.sha} · {c.title}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>Letzter Check: {new Date(status.last_check).toLocaleTimeString("de-DE")}</span>
        {!isCurrent && (
          <a
            href="https://github.com/grandamenium/cortextos/commits/main"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium hover:text-foreground"
          >
            GitHub →
          </a>
        )}
      </div>
    </div>
  )
}
