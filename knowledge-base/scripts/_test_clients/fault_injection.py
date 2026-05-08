"""Fault-injecting Gemini client for testing mmrag._retry_generate_content.

Wired via two env vars consumed by mmrag.get_genai_client:

    MMRAG_GEMINI_CLIENT_FACTORY=_test_clients.fault_injection:make_client
    MMRAG_FAULT_INJECTION_SCRIPT="503,503,200"

The script is a comma-separated list of one entry per generate_content() call.
Each entry is either "<code>" or "<code>:<message>". Code 200 returns a stub
success response; any other code raises an APIError with the corresponding
status name.

Code -> status mapping (set is intentionally narrow — covers what the retry
loop predicate distinguishes between transient and non-transient):

    429 -> RESOURCE_EXHAUSTED   (transient)
    500 -> INTERNAL             (transient by HTTP code)
    503 -> UNAVAILABLE          (transient)
    400 -> INVALID_ARGUMENT     (non-transient)
    401 -> UNAUTHENTICATED      (non-transient)
    403 -> PERMISSION_DENIED    (non-transient)
"""

import os
from google.genai.errors import APIError


_STATUS_FOR_CODE = {
    429: "RESOURCE_EXHAUSTED",
    500: "INTERNAL",
    503: "UNAVAILABLE",
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
}


class _InjectedAPIError(APIError):
    """APIError subclass that sets .code/.status/.message directly.

    Avoids invoking APIError.__init__ because the SDK's constructor expects a
    real HTTP response object and parses response_json in version-specific
    ways. Subclassing preserves `except google.genai.errors.APIError` catches
    in callers (an _InjectedAPIError is-a APIError).
    """
    def __init__(self, code, status, message=""):
        Exception.__init__(self, message)
        self.code = code
        self.status = status
        self.message = message


class _StubResponse:
    def __init__(self, text):
        self.text = text
        self.usage_metadata = None


class _StubModels:
    def __init__(self, script):
        self._script = list(script)
        self._index = 0

    def generate_content(self, model=None, contents=None, **kwargs):
        if self._index >= len(self._script):
            raise RuntimeError(
                f"fault_injection: script exhausted at attempt {self._index + 1} "
                f"(scripted {len(self._script)} responses)"
            )
        code, message = self._script[self._index]
        self._index += 1
        if code == 200:
            return _StubResponse(message or "[stub] fault-injection success")
        status = _STATUS_FOR_CODE.get(code, "UNKNOWN")
        raise _InjectedAPIError(code, status, message or f"injected {code} {status}")

    def embed_content(self, *a, **kw):
        raise RuntimeError(
            "fault_injection: embed_content is not scripted. Tests should target "
            "_retry_generate_content directly, not the full ingest_pdf pipeline."
        )


class FaultInjectionClient:
    def __init__(self, script):
        self.models = _StubModels(script)


def _parse_script(spec):
    entries = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" in chunk:
            code_s, message = chunk.split(":", 1)
        else:
            code_s, message = chunk, ""
        entries.append((int(code_s), message))
    return entries


def make_client(api_key=None):
    """Factory entry point. Signature matches the real Client constructor;
    api_key is accepted but ignored — fault injection is fully driven by
    MMRAG_FAULT_INJECTION_SCRIPT.
    """
    spec = os.environ.get("MMRAG_FAULT_INJECTION_SCRIPT", "200")
    return FaultInjectionClient(_parse_script(spec))
