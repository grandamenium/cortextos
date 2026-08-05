#!/usr/bin/env python3
"""
Gmail search script for deal-digest-reader service account.
Called by the pm agent's daily-deal-digest cron.

Domain: monkeyattack.com
Service account: deal-digest-reader (domain-wide delegation)
Scope: gmail.readonly only

# To provision Vault secret when SA key arrives:
#   vault kv put secret/gmail \
#     sa_json=@/path/to/sa-key.json \
#     impersonate_email=meredith@monkeyattack.com  # confirmed: all 4 aliases funnel here
"""

import argparse
import base64
import json
import os
import sys

GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"


# ---------------------------------------------------------------------------
# Credential loading
# ---------------------------------------------------------------------------

def load_credentials():
    """
    Load SA JSON + impersonation email from Vault (secret/gmail/) or env fallback.

    Returns (sa_json_str, impersonate_email).
    Raises RuntimeError with a user-friendly message on failure.
    """
    sa_json_str = None
    impersonate_email = None

    # --- Try Vault first ---
    vault_token = os.getenv("VAULT_TOKEN")
    if vault_token:
        # Strategy 1: try hvac via VaultManager
        try:
            # Import inline so the script can still emit a clean JSON error if
            # vault_config is not on the path at all.
            sys.path.insert(0, "/home/claude-dev/repos/meta-trader-hub/backend")
            from core.vault_config import VaultManager  # noqa: PLC0415

            v = VaultManager()
            if v.client:
                secret = v.client.secrets.kv.read_secret_version(path="gmail")
                data = secret["data"]["data"]
                sa_json_str = data.get("sa_json")
                impersonate_email = data.get("impersonate_email")
        except Exception:  # vault unreachable, path missing, hvac not installed, etc.
            pass  # fall through to vault CLI strategy

        # Strategy 2: vault CLI fallback (works when hvac is absent or SSL fails)
        if not sa_json_str:
            try:
                import subprocess  # noqa: PLC0415

                vault_env = {
                    **os.environ,
                    "VAULT_TOKEN": vault_token,
                    "VAULT_ADDR": os.getenv("VAULT_ADDR", "https://127.0.0.1:8200"),
                    "VAULT_SKIP_VERIFY": "true",
                }
                for field, target_var in [("sa_json", "sa_json_str"), ("impersonate_email", "impersonate_email")]:
                    result = subprocess.run(
                        ["vault", "kv", "get", f"-field={field}", "secret/gmail"],
                        capture_output=True, text=True, env=vault_env, timeout=10,
                    )
                    if result.returncode == 0 and result.stdout.strip():
                        if target_var == "sa_json_str":
                            sa_json_str = result.stdout.strip()
                        else:
                            impersonate_email = result.stdout.strip()
            except Exception:  # vault CLI not found, timeout, etc.
                pass  # fall through to env-var path

    # --- Env-var fallback ---
    if not sa_json_str:
        sa_json_str = os.getenv("GMAIL_SA_JSON")
    if not impersonate_email:
        impersonate_email = os.getenv("GMAIL_IMPERSONATE_EMAIL")

    if not sa_json_str:
        raise RuntimeError(
            "SA JSON not found. Set VAULT_TOKEN (with secret/gmail/sa_json) "
            "or GMAIL_SA_JSON env var."
        )
    if not impersonate_email:
        raise RuntimeError(
            "Impersonation email not found. Set VAULT_TOKEN (with secret/gmail/impersonate_email) "
            "or GMAIL_IMPERSONATE_EMAIL env var."
        )

    return sa_json_str, impersonate_email


def build_gmail_service(sa_json_str: str, impersonate_email: str):
    """
    Build an authenticated Gmail API service client.

    Uses domain-wide delegation: SA credentials + subject= impersonate_email.
    """
    from google.oauth2 import service_account  # noqa: PLC0415
    from googleapiclient.discovery import build  # noqa: PLC0415

    sa_info = json.loads(sa_json_str)

    credentials = service_account.Credentials.from_service_account_info(
        sa_info,
        scopes=[GMAIL_READONLY_SCOPE],
    )
    delegated_credentials = credentials.with_subject(impersonate_email)

    service = build("gmail", "v1", credentials=delegated_credentials, cache_discovery=False)
    return service


# ---------------------------------------------------------------------------
# Gmail helpers
# ---------------------------------------------------------------------------

def _get_header(headers: list, name: str) -> str:
    """Extract a single header value by name (case-insensitive)."""
    name_lower = name.lower()
    for h in headers:
        if h.get("name", "").lower() == name_lower:
            return h.get("value", "")
    return ""


def _decode_body_part(part: dict) -> str | None:
    """
    Recursively decode a message part, preferring text/plain over text/html.
    Returns the first non-empty decoded string found, or None.
    """
    mime = part.get("mimeType", "")

    # Leaf text parts
    if mime in ("text/plain", "text/html"):
        data = part.get("body", {}).get("data", "")
        if data:
            try:
                return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
            except Exception:
                return None

    # Multipart: recurse, prefer text/plain
    if mime.startswith("multipart/"):
        sub_parts = part.get("parts", [])
        # First pass: plain text
        for sp in sub_parts:
            if sp.get("mimeType") == "text/plain":
                text = _decode_body_part(sp)
                if text:
                    return text
        # Second pass: any text
        for sp in sub_parts:
            text = _decode_body_part(sp)
            if text:
                return text

    return None


def fetch_thread_metadata(service, thread_id: str) -> dict:
    """
    Fetch a thread in metadata format and extract subject/from/date from the
    first message's headers.
    """
    thread = (
        service.users()
        .threads()
        .get(userId="me", id=thread_id, format="metadata",
             metadataHeaders=["Subject", "From", "Date"])
        .execute()
    )

    messages = thread.get("messages", [])
    snippet = thread.get("snippet", "")

    subject = from_ = date = ""
    if messages:
        headers = messages[0].get("payload", {}).get("headers", [])
        subject = _get_header(headers, "Subject")
        from_ = _get_header(headers, "From")
        date = _get_header(headers, "Date")

    return {
        "id": thread_id,
        "thread_id": thread_id,  # alias — Gmail API list() returns `id`; downstream consumers expect `thread_id`
        "snippet": snippet,
        "subject": subject,
        "from": from_,
        "date": date,
    }


def fetch_thread_full(service, thread_id: str) -> dict:
    """
    Fetch a thread with full payload and extract body text in addition to
    standard metadata fields.
    """
    thread = (
        service.users()
        .threads()
        .get(userId="me", id=thread_id, format="full")
        .execute()
    )

    messages = thread.get("messages", [])
    snippet = thread.get("snippet", "")

    subject = from_ = date = ""
    body_text = ""

    if messages:
        first_msg = messages[0]
        payload = first_msg.get("payload", {})
        headers = payload.get("headers", [])
        subject = _get_header(headers, "Subject")
        from_ = _get_header(headers, "From")
        date = _get_header(headers, "Date")
        body_text = _decode_body_part(payload) or ""

        # Fallback: some threads (delivery wrappers, forwards with an empty
        # cover message) carry the real content in a later message. If the
        # first message decodes to nothing, walk the rest of the thread and
        # take the first non-empty body.
        if not body_text.strip():
            for msg in messages[1:]:
                candidate = _decode_body_part(msg.get("payload", {})) or ""
                if candidate.strip():
                    body_text = candidate
                    break

    return {
        "id": thread_id,
        "thread_id": thread_id,  # alias — Gmail API list() returns `id`; downstream consumers expect `thread_id`
        "snippet": snippet,
        "subject": subject,
        "from": from_,
        "date": date,
        "body_text": body_text,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(
        description="Search Gmail via service account and output JSON."
    )
    parser.add_argument(
        "--query",
        required=True,
        help="Gmail search query string (e.g. 'subject:deal from:sender@example.com')",
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=50,
        dest="max_results",
        help="Maximum number of threads to return (default: 50)",
    )
    parser.add_argument(
        "--format",
        choices=["metadata", "full"],
        default="metadata",
        dest="fmt",
        help="Response format: metadata (default) or full (includes body_text)",
    )
    return parser.parse_args()


def emit_error(error: str, message: str, status: str = "auth_error") -> None:
    """Emit a JSON error and exit 1. status: auth_error (creds/delegation) or search_error (API/query)."""
    print(
        json.dumps(
            {
                "status": status,
                "error": error,
                "message": message,
            },
            indent=2,
        )
    )
    sys.exit(1)


def main():
    args = parse_args()

    # --- Load credentials ---
    try:
        sa_json_str, impersonate_email = load_credentials()
    except RuntimeError as exc:
        emit_error(str(exc), "Gmail connector unreachable — re-auth or check SA delegation")

    # --- Build service ---
    try:
        service = build_gmail_service(sa_json_str, impersonate_email)
    except Exception as exc:
        emit_error(str(exc), "Gmail connector unreachable — re-auth or check SA delegation")

    # --- Search threads ---
    try:
        response = (
            service.users()
            .threads()
            .list(userId="me", q=args.query, maxResults=args.max_results)
            .execute()
        )
    except Exception as exc:
        # Search failures are NOT necessarily auth failures — a malformed query
        # or transient API error lands here too. Report honestly so the caller
        # doesn't send Chris chasing SA delegation for a bad query string.
        emit_error(str(exc), "Gmail search failed — check query syntax / API availability",
                   status="search_error")

    thread_stubs = response.get("threads", [])
    threads = []

    for stub in thread_stubs:
        thread_id = stub["id"]
        try:
            if args.fmt == "full":
                t = fetch_thread_full(service, thread_id)
            else:
                t = fetch_thread_metadata(service, thread_id)
            threads.append(t)
        except Exception as exc:
            # Soft-fail individual thread fetches; include error record
            threads.append(
                {
                    "id": thread_id,
                    "thread_id": thread_id,
                    "snippet": stub.get("snippet", ""),
                    "subject": "",
                    "from": "",
                    "date": "",
                    "fetch_error": str(exc),
                }
            )

    result = {
        "status": "ok",
        "query": args.query,
        "thread_count": len(threads),
        "threads": threads,
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
