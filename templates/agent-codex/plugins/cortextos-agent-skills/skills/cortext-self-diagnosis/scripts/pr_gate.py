#!/usr/bin/env python3
"""
pr_gate.py — scan a diff for anything that must not reach a public PR.

Two questions, both of which sink a PR:
  1. Does this leak the person or machine it came from?  (PII / secrets / paths)
  2. Is this focused on one bug?                          (unrelated files, noise)

    python3 pr_gate.py --base upstream/main
    python3 pr_gate.py --base upstream/main --repo ~/cortextos --json

Exit: 0 clean, 1 findings, 2 could not run.

This is a floor, not a ceiling. Pattern matching cannot tell that an agent name
is a real company's, that a fixture quotes a real customer, or that a comment
names an internal project. Read the diff yourself as well — the specific question
is not "is this sensitive" but "does this reveal anything about where it came
from". See references/upstream-pr.md section 5.
"""

import argparse
import getpass
import json
import os
import re
import socket
import subprocess
import sys

BLOCK, WARN, NOTE = "BLOCK", "WARN", "NOTE"

# (severity, label, compiled pattern, why it matters)
PATTERNS = [
    (BLOCK, "Telegram bot token",
     re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b"),
     "Live bot credential — rotate it if this ever left the machine."),
    (BLOCK, "OpenAI-style key",
     re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "Live API credential."),
    (BLOCK, "Anthropic key",
     re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b"), "Live API credential."),
    (BLOCK, "GitHub token",
     re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "Live GitHub credential."),
    (BLOCK, "AWS access key",
     re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b"), "Live AWS credential."),
    (BLOCK, "JWT",
     re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b"),
     "Signed token; often still valid."),
    (BLOCK, "Private key block",
     re.compile(r"-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----"),
     "Private key material."),
    (BLOCK, "Assigned secret",
     re.compile(r"""(?i)\b(api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*["']([^"'\s]{8,})["']"""),
     "Credential assigned to a literal. Use an env var or a dummy."),

    (BLOCK, "macOS home path",
     re.compile(r"/Users/[A-Za-z0-9._-]+"),
     "Reveals the username and machine layout."),
    (BLOCK, "Linux home path",
     re.compile(r"/home/[A-Za-z0-9._-]+"),
     "Reveals the username and machine layout."),
    (BLOCK, "Windows home path",
     re.compile(r"[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._-]+"),
     "Reveals the username and machine layout."),
    (WARN, "Tilde project path",
     re.compile(r"~/(Projects|Documents|Desktop|Downloads|Movies|Music)/"),
     "Local layout; use a relative path or a placeholder."),

    (BLOCK, "Email address",
     re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
     "Personal identifier."),
    (WARN, "Phone number",
     re.compile(r"(?<!\d)(\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)"),
     "Possible personal identifier."),
    (WARN, "Tailscale IP",
     re.compile(r"\b100\.(?:[6-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b"),
     "Private network address identifying this fleet."),
    (WARN, "Private LAN IP",
     re.compile(r"\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b"),
     "Local network address."),
    (WARN, "Telegram chat id",
     re.compile(r"""(?i)\b(chat[_-]?id|user[_-]?id|allowed[_-]?users?)\b\s*[:=]\s*["']?(-?\d{6,})"""),
     "Identifies a real account or chat."),
    (NOTE, "Webhook URL",
     re.compile(r"https://hooks\.[A-Za-z0-9.-]+/[A-Za-z0-9/_-]+"),
     "Endpoint may be private."),
]

# Paths that should essentially never appear in a focused framework fix.
FOCUS_RULES = [
    (BLOCK, re.compile(r"(^|/)\.env"),               "Environment file — never commit."),
    (BLOCK, re.compile(r"(^|/)secrets?/"),           "Secrets directory."),
    (BLOCK, re.compile(r"(^|/)(id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.key)$"), "Key material."),
    (WARN,  re.compile(r"(^|/)node_modules/"),       "Vendored dependencies."),
    (WARN,  re.compile(r"(^|/)dist/"),               "Build output — generated, not source."),
    (WARN,  re.compile(r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$"),
            "Lockfile churn; include only if the fix genuinely changes deps."),
    (WARN,  re.compile(r"(^|/)\.(vscode|idea)/"),    "Editor config — personal."),
    (WARN,  re.compile(r"(^|/)\.DS_Store$"),         "OS cruft."),
    (NOTE,  re.compile(r"(^|/)(logs?|tmp|scratch)/"), "Local artifacts."),
]

SKIP_SCAN = re.compile(r"(^|/)(node_modules|dist|\.git)/|\.(png|jpg|jpeg|gif|ico|pdf|zip|mp4|woff2?)$")


def sh(args, cwd):
    try:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        print(f"ERROR: {' '.join(args)}: {e}", file=sys.stderr)
        sys.exit(2)
    if r.returncode != 0 and "diff" in args:
        print(f"ERROR: {' '.join(args)}\n{r.stderr.strip()}", file=sys.stderr)
        sys.exit(2)
    return r.stdout


def local_identity_terms():
    """Install-specific strings worth flagging: username, hostname, agent names.

    These are the leaks a generic pattern list misses — an agent name is not a
    secret in general, but it is a fact about whoever's fleet it came from.
    """
    terms = {}
    try:
        u = getpass.getuser()
        if u and len(u) > 2:
            terms[u] = "local username"
    except Exception:
        pass
    try:
        h = socket.gethostname().split(".")[0]
        if h and len(h) > 2:
            terms[h] = "local hostname"
    except Exception:
        pass
    for root in (os.path.expanduser("~/.cortextos/default"), os.path.expanduser("~/.business-os")):
        logs = os.path.join(root, "logs")
        if os.path.isdir(logs):
            for a in os.listdir(logs):
                if len(a) > 3 and not a.startswith("."):
                    terms.setdefault(a, "local agent name")
    return terms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="upstream/main", help="base ref (default upstream/main)")
    ap.add_argument("--repo", default=os.path.expanduser("~/cortextos"))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-identity", action="store_true",
                    help="skip username/hostname/agent-name matching")
    a = ap.parse_args()

    repo = os.path.expanduser(a.repo)
    if not os.path.isdir(os.path.join(repo, ".git")):
        print(f"ERROR: not a git repo: {repo}", file=sys.stderr)
        sys.exit(2)

    files = [f for f in sh(["git", "diff", "--name-only", a.base], repo).splitlines() if f.strip()]
    if not files:
        print(f"No changes vs {a.base}. Nothing to gate.")
        sys.exit(0)

    findings = []

    for f in files:
        for sev, pat, why in FOCUS_RULES:
            if pat.search(f):
                findings.append({"severity": sev, "category": "focus",
                                 "label": "Unrelated or unsafe file", "file": f,
                                 "line": 0, "excerpt": f, "why": why})

    identity = {} if a.no_identity else local_identity_terms()

    # Scan added lines only — context lines are already upstream and not ours to fix.
    diff = sh(["git", "diff", "--unified=0", a.base], repo)
    cur, lineno = None, 0
    for raw in diff.splitlines():
        if raw.startswith("+++ b/"):
            cur, lineno = raw[6:], 0
            continue
        if raw.startswith("@@"):
            m = re.search(r"\+(\d+)", raw)
            lineno = int(m.group(1)) - 1 if m else 0
            continue
        if not raw.startswith("+") or raw.startswith("+++"):
            continue
        lineno += 1
        if not cur or SKIP_SCAN.search(cur):
            continue
        line = raw[1:]
        excerpt = line.strip()[:160]

        for sev, label, pat, why in PATTERNS:
            m = pat.search(line)
            if m:
                findings.append({"severity": sev, "category": "pii", "label": label,
                                 "file": cur, "line": lineno, "excerpt": excerpt, "why": why})

        for term, kind in identity.items():
            if re.search(rf"\b{re.escape(term)}\b", line, re.I):
                findings.append({"severity": WARN, "category": "identity",
                                 "label": f"{kind.capitalize()}: '{term}'", "file": cur,
                                 "line": lineno, "excerpt": excerpt,
                                 "why": f"Matches this install's {kind}; may not be meaningful upstream."})

    stats = sh(["git", "diff", "--stat", a.base], repo).strip().splitlines()

    if a.json:
        print(json.dumps({"base": a.base, "files": files, "findings": findings}, indent=2))
        sys.exit(1 if findings else 0)

    print(f"\nPR Gate — {len(files)} file(s) changed vs {a.base}\n")
    for l in stats[-1:]:
        print(f"  {l.strip()}")
    print()

    if not findings:
        print("  No automated findings.\n")
        print("  The scanner only matches patterns. Before you present this, read the")
        print("  diff yourself and ask of each line: does this reveal anything about")
        print("  the person or machine it came from, and is it needed for this one bug?\n")
        print(f"    git diff {a.base}\n")
        sys.exit(0)

    order = {BLOCK: 0, WARN: 1, NOTE: 2}
    findings.sort(key=lambda x: (order[x["severity"]], x["file"], x["line"]))

    counts = {s: sum(1 for f in findings if f["severity"] == s) for s in (BLOCK, WARN, NOTE)}
    print(f"  {counts[BLOCK]} blocking, {counts[WARN]} warnings, {counts[NOTE]} notes\n")

    shown = None
    for f in findings:
        if f["severity"] != shown:
            shown = f["severity"]
            head = {BLOCK: "BLOCKING — must be resolved",
                    WARN: "WARNING — review each",
                    NOTE: "NOTE — probably fine"}[shown]
            print(f"\n  ── {head} ──\n")
        loc = f"{f['file']}:{f['line']}" if f["line"] else f["file"]
        print(f"  [{f['label']}] {loc}")
        print(f"      {f['excerpt']}")
        print(f"      → {f['why']}\n")

    print("  Fix blocking findings before going further. For warnings, decide")
    print("  deliberately — and if you judge one acceptable, say so and why when")
    print("  you present this, rather than passing over it silently.\n")
    sys.exit(1)


if __name__ == "__main__":
    main()
