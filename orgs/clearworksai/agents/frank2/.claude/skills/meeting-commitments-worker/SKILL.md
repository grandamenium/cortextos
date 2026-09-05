# Meeting Commitments Worker

You are a SHORT-LIVED WORKER SESSION. Your only job is to run the Fireflies commitment extractor and surface Josh's NEW meeting commitments. Complete it and stop.

DO NOT:
- Read bootstrap files (IDENTITY.md, SOUL.md, etc.)
- Update heartbeat
- Write to daily memory
- Send confirmations or narration

DO:
- Run the steps below
- Send Telegram to 6690120787 only if NEW commitments found
- Output DONE when complete

---

## Step 1 — Task + dedup setup (Bash)

```bash
TASK_ID=$(cortextos bus create-task "Cron: meeting-commitments" --desc "Post-meeting commitment extractor" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
cortextos bus update-cron-fire meeting-commitments --interval 2h 2>/dev/null
mkdir -p state
SURFACED_FILE='state/meeting-commitments-surfaced.txt'
[[ -f "$SURFACED_FILE" ]] || touch "$SURFACED_FILE"
echo "surfaced=$(wc -l < $SURFACED_FILE)"
```

There is no cutoff/timestamp logic here anymore. The old `state/meeting-commitments-last.txt` cutoff is replaced by the extractor's own watermark (`state/ff-extractor-watermark.json`), which the extractor advances only after a successful ingest POST — so nothing is lost if a run fails partway.

---

## Step 2 — Run the extractor (Bash)

The extractor owns the full pipeline: Haiku casualness gate + Sonnet extraction + first-person/concreteness refinement, then a POST to `$BRIEFS_INGEST_URL` (header `x-api-key: $TASKS_INGEST_TOKEN`) that turns commitments into durable tasks with server-side dedup by deterministic id. Do not query the Fireflies API directly from this SKILL — the extractor is the only Fireflies touchpoint.

Working directory MUST be the frank2 agent dir (`/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2`) so `scripts/` and `state/` resolve.

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2
# set -a auto-exports everything sourced — .env/secrets.env use bare KEY=value
# (no `export`), and without this the python3 child would NOT inherit the vars
# even though the bash guard below sees them (guard says OK, extractor fails).
set -a
source /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/.env 2>/dev/null
source /Users/joshweiss/code/cortextos/orgs/clearworksai/secrets.env 2>/dev/null
set +a

DEGRADED=0
if [[ -z "$BRIEFS_INGEST_URL" || -z "$TASKS_INGEST_TOKEN" ]]; then
  # Env guard: ingest not configured — extract + print only, no POST, watermark NOT advanced
  DEGRADED=1
  python3 scripts/ff-extractor.py --limit 20 --dry-run > /tmp/ff-commitments.json
else
  python3 scripts/ff-extractor.py --limit 20 > /tmp/ff-commitments.json
fi
EXTRACTOR_RC=$?
echo "extractor_rc=$EXTRACTOR_RC degraded=$DEGRADED"
```

The extractor exits nonzero on failure. If `EXTRACTOR_RC` is nonzero: log silently and skip directly to Step 6 — no Telegram, no dedup writes.

---

## Step 3 — Parse results

The extractor stdout JSON always contains an `items` array of `{id, text, direction, source, sourceRef}` (contract owned by `ff-extractor.py`). Read `/tmp/ff-commitments.json` and iterate `items`.

Keep the existing exclusion rules as a belt-and-suspenders post-filter before surfacing:

**EXCLUDE:**
- Anything mentioning Marcos Santa Ana (hard no — never surface)
- rachel_security_deliverables_jsp (suppressed permanently)

---

## Step 4 — Dedup check (mandatory)

Dedup key is the deterministic commitment `id` from the extractor (`ff_…` / `ffin_…`). For each item:

```bash
grep -qF "$ID" state/meeting-commitments-surfaced.txt && echo SKIP || echo NEW
# If NEW:
echo "$ID $(date -u +%s)" >> state/meeting-commitments-surfaced.txt
```

Old-format lines (`TRANSCRIPT_ID:RECIPIENT:first_3_words`) remain in the file harmlessly — never match the new id keys, never delete them.

---

## Step 5 — Surface new commitments

For NEW commitments only, send ONE Telegram to 6690120787, grouped by `direction`. Use `sourceRef` for the meeting title.

Outbound items (Josh committed to them):
```
[Meeting title] — you committed to:
1. [commitment text]
```

Inbound items (they committed to Josh):
```
[Meeting title] — they committed to you:
1. [commitment text]
```

If `items` is empty or everything was deduped: log silently, no Telegram.

If `DEGRADED=1`, prepend one line to the message noting commitments were NOT persisted to the tasks board (missing `BRIEFS_INGEST_URL`/`TASKS_INGEST_TOKEN` in frank2/.env — these may not be set yet).

---

## Step 6 — Complete and exit

```bash
cortextos bus complete-task $TASK_ID --result "Meeting commitments checked" 2>/dev/null
cortextos bus log-event action cron_completed info --meta '{"cron":"meeting-commitments","agent":"frank2"}' 2>/dev/null
# FINAL — self-terminate this worker PTY so it does not leak (worker-leak fix #25)
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
