# Wave 2a — Fleet hot-state backup: verified state map (2026-07-05)

Verified by read-only investigation (agent a49d8f7ea849e123f). This is the grounding for a backup script/cron. **No production src needed — this is a shell-script cron (larry domain).**

## Live data root (verified)
Running daemon = instance **`cortextos1`**. `pm2 describe cortextos-daemon` → script `dist/daemon.js`, pid resolves `CTX_ROOT=/Users/joshweiss/.cortextos/cortextos1`. Active-instance marker `~/.cortextos/state/ACTIVE_INSTANCE` = `cortextos1`. Source: `src/utils/env.ts:29-39` (CTX_ROOT || .cortextos-env || `~/.cortextos/<instanceId>`); crons at `$CTX_ROOT/.cortextOS/state/agents/<agent>/crons.json` (`src/bus/crons.ts:44` + `crons-schema.ts:21`). NOTE: macOS case-insensitive — `.cortextos` and `.cortextOS` (nested subdir) are distinct path SEGMENTS, not two dirs.

State is split across TWO roots:
1. **DATA root** `~/.cortextos/cortextos1/` — daemon runtime (crons, tasks, inbox, per-agent session state, KB). NOT a git repo.
2. **REPO tree** `/Users/joshweiss/code/cortextos/orgs/` — agent working dirs (`state/current-mission.txt`, `memory/`, config, MD). These are **gitignored** → not in committed repo → must be backed up.

## INCLUDE (irreplaceable, not in git) — critical set ≈ 1.3 GB
```
~/.cortextos/cortextos1/.cortextOS/                                  # all agents' crons.json (1.7M)
~/.cortextos/cortextos1/tasks/                                       # instance/audit tasks (64K)
~/.cortextos/cortextos1/orgs/clearworksai/tasks/                     # 11.5k task store (90M)
~/.cortextos/cortextos1/orgs/personal/tasks/                         # (5.9M)
~/.cortextos/cortextos1/orgs/clearworksai/approvals/                 # (92K)
~/.cortextos/cortextos1/orgs/clearworksai/deliverables/             # (4.4M)
~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/chromadb/   # live vector store (981M) — true RAG memory
~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/config.json
~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/media/
~/.cortextos/cortextos1/inbox/                                       # undelivered bus msgs (832K)
~/.cortextos/cortextos1/config/  + .env + dashboard.env             # instance config + secrets
~/.cortextos/cortextos1/state/<named-agent>/                        # per-agent session/heartbeat (~5M real)
~/.cortextos/state/ACTIVE_INSTANCE
/Users/joshweiss/code/cortextos/orgs/                               # gitignored mission/memory/goals/config (~196M excl. larry bloat)
```

## EXCLUDE (regenerable / disposable / stale / bloat)
```
~/.cortextos/cortextos1/logs/                                        # 1.1G rolling logs
~/.cortextos/cortextos1/processed/                                   # 28M
~/.cortextos/cortextos1/state/comms-check-* meeting-commitments-* fleet-reconcile-*   # ~1009 ephemeral dirs (~88M)
~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/embedding-cache.sqlite       # 3.3G re-derivable
~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/chromadb.{bak,old,archived}-*  # ~2.2G stale snapshots
~/.cortextos/default/                                                # ORPHAN old instance (Jun 27-28)
/Users/joshweiss/code/cortextos/.cortextOS/  + .claude/worktrees/*/.cortextOS/         # repo-relative/worktree stale crons (alice)
orgs/clearworksai/agents/larry/state/deploy-*.log                   # ~190M disposable
orgs/clearworksai/agents/larry/state/cowork-handoff-pkg/            # 61M disposable
```
CAUTION for the `state/` include: keep named-agent dirs + top-level `*.json` control files; DROP the `comms-check-*`/`meeting-commitments-*`/`fleet-reconcile-*` globs.

## Proposed approach (v1)
Shell-script cron (larry writes scripts): `tar` the INCLUDE set with the EXCLUDE filters to a timestamped archive under `~/.cortextos-backups/`, keep last N (rotate/prune), log a one-line receipt. Local snapshots address the clobber/corruption risk that actually bit us (CRM overwrote a mission file). Off-machine/remote push = v2 (secrets in .env/config → do NOT push to a git remote without scrubbing; ask Josh before any off-box destination).

OPEN DECISION for Josh (v1 vs v2): local-only snapshot (safe default, no secret-leak risk) now; off-box replication later. Recommend building local-only v1 autonomously.
