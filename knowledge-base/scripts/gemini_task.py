#!/usr/bin/env python3
"""Hermes Gemini Path-1 (API) task entrypoint.

Thin wrapper over the production-proven mmrag.py Gemini client + retry
classifier. Runs ONE generate_content call for a single dispatched task and
prints exactly one JSON line to stdout describing the outcome.

Contract (read by src/workers/hermes/adapters/gemini.ts):
  SUCCESS: {"ok": true, "output": <resp.text>, "servedModel": <model>}
  FAILURE (rate-limit): {"ok": false, "failure": "rate-limit", "detail": "..."}
  FAILURE (auth):       {"ok": false, "failure": "no-auth",    "detail": "..."}
  FAILURE (other):      {"ok": false, "failure": "process-fail","detail": "..."}

Exit code is ALWAYS 0 for an expected backend failure (the failure is encoded in
the JSON envelope so the TS adapter never has to catch a thrown error). Only a
genuinely unexpected internal crash exits non-zero.

All heavy imports (google.genai, mmrag) happen inside main() so this module
py_compiles and --help works even when the google SDK is not installed.
"""

import argparse
import json
import os
import sys
from pathlib import Path


def _print(envelope):
    """Emit exactly one JSON line on stdout."""
    sys.stdout.write(json.dumps(envelope) + "\n")
    sys.stdout.flush()


def _classify_api_error(err):
    """Map a google.genai APIError onto the adapter failure vocabulary.

    Mirrors mmrag.py's transient classifier (_retry_generate_content):
      code in {429, 500, 503} or status in {UNAVAILABLE, RESOURCE_EXHAUSTED}
        -> rate-limit (retryable upstream)
    Auth-class (401/403, UNAUTHENTICATED, PERMISSION_DENIED, invalid key)
        -> no-auth
    everything else -> process-fail
    """
    code = getattr(err, "code", None)
    status = getattr(err, "status", None)
    text = (str(err) or "").lower()

    rate_codes = {429, 500, 503}
    rate_statuses = {"UNAVAILABLE", "RESOURCE_EXHAUSTED"}
    if code in rate_codes or status in rate_statuses:
        return "rate-limit"

    auth_codes = {401, 403}
    auth_statuses = {"UNAUTHENTICATED", "PERMISSION_DENIED"}
    auth_markers = ("api key not valid", "invalid api key", "unauthenticated",
                    "permission denied", "api_key", "missing key")
    if code in auth_codes or status in auth_statuses or any(m in text for m in auth_markers):
        return "no-auth"

    return "process-fail"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Hermes Gemini Path-1 task entrypoint.")
    parser.add_argument("--model", required=True, help="Gemini model id to pin (e.g. gemini-2.5-pro).")
    parser.add_argument("--prompt-file", required=True, help="Path to a UTF-8 file containing the prompt.")
    parser.add_argument("--workdir", required=False, default=None,
                        help="Working directory for the task (informational; reserved).")
    args = parser.parse_args(argv)

    # Make mmrag.py importable from the same dir, then reuse its proven helpers.
    script_dir = Path(__file__).resolve().parent
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))

    try:
        prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    except OSError as e:
        _print({"ok": False, "failure": "process-fail", "detail": f"prompt-file unreadable: {e}"})
        return 0

    # workdir is accepted for forward-compat (tool-grounded runs); unused in v1.
    _ = args.workdir

    try:
        import mmrag  # noqa: E402  (deferred so py_compile / --help work without the SDK)
    except Exception as e:  # pragma: no cover - import wiring
        _print({"ok": False, "failure": "process-fail", "detail": f"mmrag import failed: {e}"})
        return 0

    # Auth: get_api_key sys.exit(1)s when no key is present. Detect the absence
    # ourselves first so we can encode it as no-auth in the envelope rather than
    # crashing the caller.
    if not (os.environ.get("GEMINI_API_KEY")):
        try:
            config_probe = mmrag.load_config()
            if not config_probe.get("gemini_api_key"):
                _print({"ok": False, "failure": "no-auth", "detail": "GEMINI_API_KEY absent and no config key"})
                return 0
        except SystemExit:
            _print({"ok": False, "failure": "no-auth", "detail": "GEMINI_API_KEY absent; config not found"})
            return 0
        except Exception as e:
            _print({"ok": False, "failure": "process-fail", "detail": f"config load failed: {e}"})
            return 0

    try:
        config = mmrag.load_config()
        api_key = mmrag.get_api_key(config)
        client = mmrag.get_genai_client(api_key)
    except SystemExit:
        # get_api_key / load_config exit(1) on missing creds/config.
        _print({"ok": False, "failure": "no-auth", "detail": "credentials or config missing"})
        return 0
    except Exception as e:
        _print({"ok": False, "failure": "process-fail", "detail": f"client init failed: {e}"})
        return 0

    try:
        from google.genai import errors as genai_errors
    except Exception:  # pragma: no cover - SDK not installed at runtime
        genai_errors = None

    try:
        resp = mmrag._retry_generate_content(client, model=args.model, contents=prompt)
        text = getattr(resp, "text", None)
        if text is None:
            _print({"ok": False, "failure": "process-fail",
                    "detail": "response had no .text field"})
            return 0
        _print({"ok": True, "output": text, "servedModel": args.model})
        return 0
    except Exception as e:
        # APIError carries code/status; classify it. Anything else is process-fail.
        if genai_errors is not None and isinstance(e, genai_errors.APIError):
            failure = _classify_api_error(e)
            _print({"ok": False, "failure": failure, "detail": str(e)[:400]})
            return 0
        # Duck-type: some envs surface APIError-shaped objects without the import.
        if hasattr(e, "code") or hasattr(e, "status"):
            failure = _classify_api_error(e)
            _print({"ok": False, "failure": failure, "detail": str(e)[:400]})
            return 0
        _print({"ok": False, "failure": "process-fail", "detail": str(e)[:400]})
        return 0


if __name__ == "__main__":
    sys.exit(main())
