#!/usr/bin/env python3
"""Health probes + data invariants — catch failures that "page loads" checks miss.

Problem this fixes (Greg, 2026-05-28): dogfood reviews kept reporting "clear"
because they verified that pages LOAD, not that the system WORKS. Two real
failures slipped through repeated all-clear passes:
  - orch_experiments: 23/26 runs marked status=complete with a green badge, but
    results_json held a parse_error. Root cause: GEMINI_API_KEY returned 429
    RESOURCE_EXHAUSTED (credits depleted) — every analysis call failed and the
    runner recorded the failure as Complete.
  - tab-translator: PR "Checks pass" (it compiled) but the Load feature was
    broken (flaky third-party corsproxy.io). Build-green is not feature-working.

This script is layers 1 + 2 of the comprehensive-detection design Greg approved:
  Layer 1 — DATA INVARIANTS: deterministic SQL/API assertions (no LLM judgment).
  Layer 2 — DEPENDENCY PROBES: actually EXERCISE every critical external key /
    endpoint. For LLM providers this means a minimal real generation call, since
    a credits-depleted key still returns 200 on GET /v1/models — only a real
    call surfaces the 429. (Layer 3, Playwright user-flow smoke tests, lives in
    the QA harness, not here.)

On a NEW failure (deduped against the prior run) it posts ONE alert to the
orchestrator inbox (cortex_messages) and logs it. Quiet on all-pass. Writes
status.json every run for the dashboard + morning review.

Runs from SYSTEM crontab (NOT a bus cron) so it never pollutes the orchestrator
conversation. Companion to board-reconcile.py and stale-assignee-reroute.py.
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
try:
    from zoneinfo import ZoneInfo
except Exception:  # noqa: BLE001
    ZoneInfo = None

SECRETS = "/home/cortextos/cortextos/orgs/revops-global/secrets.env"
LOGDIR = "/home/cortextos/cortextos/orgs/revops-global/agents/orchestrator/output/health-probes"
BRIEF_DIR = "/home/cortextos/cortextos/orgs/revops-global/agents/analyst/output"
ORG_ID = "00000000-0000-0000-0000-000000000001"
HTTP_TIMEOUT = 25


def load_secrets():
    env = {}
    try:
        with open(SECRETS) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env


def _req(url, method="GET", headers=None, data=None):
    """Return (status_code, body_text). Never raises for HTTP errors.

    Reads the FULL body on success — earlier versions capped at 2000 bytes,
    which silently broke JSON-parsing callers (notably _sb_get) when PostgREST
    returned multi-row responses larger than 2000 bytes. Symptom: invariant
    queries reported 'could not query <table>' on healthy tables (e.g.
    inv:experiments_no_malformed, 2026-05-29). Error bodies still truncate at
    2000 to keep failure logs scannable."""
    body = data.encode() if isinstance(data, str) else data
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=body)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


# ── Layer 2: dependency probes ──────────────────────────────────────────────
def probe_gemini(env):
    key = env.get("GEMINI_API_KEY")
    if not key:
        return False, "GEMINI_API_KEY missing"
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           f"gemini-2.5-flash:generateContent?key={key}")
    payload = json.dumps({"contents": [{"parts": [{"text": "ok"}]}],
                          "generationConfig": {"maxOutputTokens": 1}})
    code, body = _req(url, "POST", {"Content-Type": "application/json"}, payload)
    if code == 200:
        return True, "200"
    return False, f"HTTP {code}: {body[:160]}"


def probe_anthropic(env):
    key = env.get("ANTHROPIC_API_KEY")
    if not key:
        return False, "ANTHROPIC_API_KEY missing"
    payload = json.dumps({"model": "claude-haiku-4-5", "max_tokens": 1,
                          "messages": [{"role": "user", "content": "ok"}]})
    code, body = _req("https://api.anthropic.com/v1/messages", "POST",
                      {"x-api-key": key, "anthropic-version": "2023-06-01",
                       "Content-Type": "application/json"}, payload)
    if code == 200:
        return True, "200"
    return False, f"HTTP {code}: {body[:160]}"


def probe_openai(env):
    key = env.get("OPENAI_API_KEY")
    if not key:
        return False, "OPENAI_API_KEY missing"
    payload = json.dumps({"model": "gpt-4o-mini", "max_tokens": 1,
                          "messages": [{"role": "user", "content": "ok"}]})
    code, body = _req("https://api.openai.com/v1/chat/completions", "POST",
                      {"Authorization": f"Bearer {key}",
                       "Content-Type": "application/json"}, payload)
    if code == 200:
        return True, "200"
    return False, f"HTTP {code}: {body[:160]}"


def probe_supabase(env):
    url = env.get("RGOS_SUPABASE_URL")
    key = env.get("RGOS_SUPABASE_SERVICE_KEY")
    if not url or not key:
        return False, "RGOS supabase creds missing"
    code, body = _req(url.rstrip("/") + "/rest/v1/orch_tasks?select=id&limit=1",
                      "GET", {"apikey": key, "Authorization": f"Bearer {key}"})
    if code == 200:
        return True, "200"
    return False, f"HTTP {code}: {body[:160]}"


def probe_vercel(env):
    key = env.get("VERCEL_TOKEN")
    if not key:
        return False, "VERCEL_TOKEN missing"
    code, body = _req("https://api.vercel.com/v2/user", "GET",
                      {"Authorization": f"Bearer {key}"})
    if code == 200:
        return True, "200"
    return False, f"HTTP {code}: {body[:160]}"


DEP_PROBES = {
    "dep:gemini": probe_gemini,
    "dep:anthropic": probe_anthropic,
    "dep:openai": probe_openai,
    "dep:supabase": probe_supabase,
    "dep:vercel": probe_vercel,
}


# ── Layer 1: data invariants ────────────────────────────────────────────────
def _sb_get(env, path):
    url = env.get("RGOS_SUPABASE_URL")
    key = env.get("RGOS_SUPABASE_SERVICE_KEY")
    code, body = _req(url.rstrip("/") + "/rest/v1/" + path, "GET",
                      {"apikey": key, "Authorization": f"Bearer {key}"})
    if code != 200:
        return None
    try:
        return json.loads(body)
    except Exception:  # noqa: BLE001
        return None


def invariant_experiments_no_malformed(env):
    """No experiment completed in the last 6h may carry a parse_error /
    malformed-analysis result. A failed analysis must be status=failed, never
    complete — it must not hide behind a green badge."""
    since = (datetime.now(timezone.utc) - timedelta(hours=6)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    rows = _sb_get(
        env,
        "orch_experiments?select=id,results_json,updated_at"
        f"&status=eq.complete&updated_at=gte.{since}&limit=100",
    )
    if rows is None:
        return False, "could not query orch_experiments"
    bad = [r for r in rows
           if (r.get("results_json") or {}).get("parse_error")
           or "malformed" in ((r.get("results_json") or {}).get(
               "recommendation") or "").lower()]
    if bad:
        return False, (f"{len(bad)} experiment(s) completed in last 6h with "
                       f"malformed/parse_error results (ids: "
                       f"{', '.join(r['id'][:8] for r in bad[:5])})")
    return True, f"{len(rows)} recent complete experiments, all with real results"


def invariant_morning_brief_written(env):
    """On a weekday after the brief window closes (>=09:00 PT), today's
    morning-brief file MUST exist on disk and be non-empty. Catches the silent
    failure where a brief is SENT (Slack) but not SAVED — experiment scoring +
    the audit trail read from disk. The old brief-watchdog depended on codex
    (spawn-codex) and failed silently for 6 weekdays (2026-05-23..28) when codex
    credits ran out; this invariant has no codex dependency."""
    if ZoneInfo is not None:
        pt = datetime.now(ZoneInfo("America/Los_Angeles"))
    else:
        pt = datetime.now(timezone.utc) - timedelta(hours=7)  # PDT fallback
    if pt.weekday() >= 5:
        return True, "weekend — no brief expected"
    if pt.hour < 9:
        return True, f"brief window still open (PT {pt:%H:%M}); not yet due"
    fname = os.path.join(BRIEF_DIR, f"{pt:%Y-%m-%d}-morning-brief.md")
    if os.path.exists(fname) and os.path.getsize(fname) > 0:
        return True, f"{pt:%Y-%m-%d} morning brief saved"
    return False, (f"no morning-brief file for {pt:%Y-%m-%d} after 09:00 PT — "
                   f"brief may be sent to Slack but not saved to disk "
                   f"(expected {fname})")


def invariant_theta_session_written(env):
    """The nightly theta-wave fires ~05:00 UTC and MUST leave a theta_sessions
    row dated today (session_id=theta-<UTC date>) with status=complete. Catches
    the dominant theta failure mode: the cron runs via spawn-worker (fire-and-
    forget IPC), the worker dies, and the run vanishes with no artifact — or
    leaves a status=error placeholder that never gets patched to complete. An
    error row counts as a failure here, same as a missing brief file. Same class
    as inv:morning_brief_written; no spawn-worker dependency in the check itself."""
    now = datetime.now(timezone.utc)
    if now.hour < 8:
        return True, f"theta completion window still open (UTC {now:%H:%M}); fires ~05:00Z, not yet due"
    sid = f"theta-{now:%Y-%m-%d}"
    rows = _sb_get(
        env,
        f"theta_sessions?select=session_id,status,ran_at&session_id=eq.{sid}&limit=1",
    )
    if rows is None:
        return False, "could not query theta_sessions"
    if not rows:
        return False, (f"no theta_sessions row for {sid} after 08:00 UTC — "
                       f"nightly theta-wave fired (~05:00Z) but produced no session "
                       f"(spawn-worker silent failure)")
    status = rows[0].get("status")
    if status == "complete":
        return True, f"{sid} recorded complete"
    return False, (f"{sid} recorded status={status!r}, not complete — theta-wave "
                   f"ran but failed to finish (placeholder row never patched)")


INVARIANTS = {
    "inv:experiments_no_malformed": invariant_experiments_no_malformed,
    "inv:morning_brief_written": invariant_morning_brief_written,
    "inv:theta_session_written": invariant_theta_session_written,
}


# ── alert plumbing ──────────────────────────────────────────────────────────
def post_inbox_alert(env, subject, body):
    url = env.get("RGOS_SUPABASE_URL")
    key = env.get("RGOS_SUPABASE_SERVICE_KEY")
    if not url or not key:
        return
    row = json.dumps({
        "org_id": ORG_ID, "from_agent": "health-probes", "to_agent": "orchestrator",
        "message_type": "message", "subject": subject[:200], "body": body[:3000],
    }).encode()
    req = urllib.request.Request(
        url.rstrip("/") + "/rest/v1/cortex_messages", data=row, method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"})
    try:
        urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read()
    except Exception as e:  # noqa: BLE001
        print(f"inbox alert insert failed: {e}", file=sys.stderr)


def load_prev_failures():
    path = os.path.join(LOGDIR, "alerted.json")
    if os.path.exists(path):
        try:
            with open(path) as fh:
                return set(json.load(fh))
        except Exception:  # noqa: BLE001
            return set()
    return set()


def save_prev_failures(names):
    os.makedirs(LOGDIR, exist_ok=True)
    with open(os.path.join(LOGDIR, "alerted.json"), "w") as fh:
        json.dump(sorted(names), fh)


def main():
    env = load_secrets()
    os.makedirs(LOGDIR, exist_ok=True)
    now = datetime.now(timezone.utc)
    results = {}

    for name, fn in {**DEP_PROBES, **INVARIANTS}.items():
        try:
            ok, detail = fn(env)
        except Exception as e:  # noqa: BLE001
            ok, detail = False, f"probe raised {type(e).__name__}: {e}"
        results[name] = {"ok": ok, "detail": detail}

    failing = {n for n, r in results.items() if not r["ok"]}
    prev = load_prev_failures()
    new_failures = failing - prev
    recovered = prev - failing

    # status.json — always written, read by dashboard + morning review
    with open(os.path.join(LOGDIR, "status.json"), "w") as fh:
        json.dump({"checked_at": now.isoformat(), "all_ok": not failing,
                   "failing": sorted(failing), "results": results}, fh, indent=2)

    if new_failures:
        lines = [f"- {n}: {results[n]['detail']}" for n in sorted(new_failures)]
        body = ("Health probe detected NEW failure(s) that page-load checks "
                "would miss:\n\n" + "\n".join(lines) +
                "\n\nFull status: output/health-probes/status.json")
        post_inbox_alert(env, f"[health-probe] {len(new_failures)} new failure(s)", body)
        stamp = now.strftime("%Y-%m-%dT%H%M%SZ")
        with open(os.path.join(LOGDIR, "alerts.log"), "a") as fh:
            for n in sorted(new_failures):
                fh.write(f"{stamp}\tFAIL\t{n}\t{results[n]['detail']}\n")
        print(f"ALERT: {len(new_failures)} new failure(s): {sorted(new_failures)}")

    if recovered:
        stamp = now.strftime("%Y-%m-%dT%H%M%SZ")
        with open(os.path.join(LOGDIR, "alerts.log"), "a") as fh:
            for n in sorted(recovered):
                fh.write(f"{stamp}\tRECOVERED\t{n}\n")
        print(f"RECOVERED: {sorted(recovered)}")

    save_prev_failures(failing)
    if not failing:
        print("all health probes + invariants OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
