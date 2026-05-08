# `_test_clients/` — fault-injectable Gemini clients

Test-only stand-ins for `google.genai.Client`, used to behaviorally verify the
retry loop in `mmrag._retry_generate_content` without hitting the real Gemini
API.

## How the indirection works

`mmrag.get_genai_client()` checks `MMRAG_GEMINI_CLIENT_FACTORY`. If unset, it
returns the real `google.genai.Client` (current production behavior, unchanged
byte-for-byte). If set, the variable is interpreted as a dotted import path of
a callable; the result of `factory(api_key)` is used as the client.

The path may be written `module.attr` or `module:attr` (the colon form is
preferred because it disambiguates submodule vs attribute lookups).

## Reference client: `fault_injection.py`

A scripted-response client that lets a test driver dictate the outcome of each
`generate_content()` call.

```bash
export MMRAG_GEMINI_CLIENT_FACTORY=_test_clients.fault_injection:make_client
export MMRAG_FAULT_INJECTION_SCRIPT="503,503,200"
```

The script is a comma-separated list of one entry per call. Each entry is
`<http_code>` or `<http_code>:<message>`. `200` returns a stub success
response; any other code raises an `APIError` with the corresponding gRPC
status name set on `.status` and `.code` set to the HTTP int. See the
docstring at the top of `fault_injection.py` for the full code → status map.

The client only scripts `generate_content` — `embed_content` raises loudly if
called. Tests should target `_retry_generate_content` directly rather than
running the full `ingest_pdf` pipeline.

## Running the tests

```bash
cd knowledge-base/scripts
python -m _test_clients.test_retry
```

Three scenarios run in milliseconds (`backoffs=(0, 0, 0)` skips real sleeps):

1. **transient_then_success** — `503 → 200` returns the success response.
2. **all_exhausted** — `503 → 503 → 503` re-raises the last `APIError`.
3. **fail_fast_nontransient** — a `403` whose message text contains `"503"`
   raises immediately. This is the false-positive class flagged in the PR #309
   review (substring-match would have entered the retry loop); the structured
   `.code`/`.status` predicate rejects it. Same scenario the #309 sandbox
   covered as TC-8 — recreated here as a unit test.

The exit code is 0 on all-pass, 1 on any assertion failure.

## Why this lives in `knowledge-base/scripts/_test_clients/` and not elsewhere

`mmrag.py` runs as a script (`python knowledge-base/scripts/mmrag.py …`),
which puts its own directory on `sys.path[0]` automatically. That makes
`_test_clients.fault_injection` importable from `mmrag` with no path-manip
boilerplate at runtime.

The leading underscore marks the package as test-internal — it's not part of
the user-facing CLI surface and doesn't ship in the runtime hot path.
