"""Behavioral tests for mmrag's theta-62 daily-quota fail-fast gate.

Run from knowledge-base/scripts:

    python -m _test_clients.test_retry_quota

Exits 0 on all-pass, 1 on any failure. Seven scenarios from
docs/architecture/kb-retry-fail-fast-on-quota.md:

  1. single exhausted does NOT trip the gate
  2. two exhausted within 5min trips the gate; next call fails fast
  3. a successful call clears the gate
  4. gate auto-releases at UTC midnight
  5. gate persists across BOTH retry functions (shared module state)
  6. false-positive edge: 2 exhausted 10min apart do NOT trip
  7. telemetry payload for a fail_fast_quota event

backoffs is passed as (0, 0, 0) so tests run in milliseconds.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag
from _test_clients import fault_injection


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def _reset_gate():
    """Clear all module-level quota-gate state between tests."""
    mmrag._recent_exhausted = []
    mmrag._quota_drained_until = None


def _client(spec):
    return fault_injection.FaultInjectionClient(fault_injection._parse_script(spec))


def _embed(client):
    return mmrag._retry_embed_content(
        client, model="x", contents=["x"], embed_config=None, backoffs=(0, 0, 0)
    )


def _generate(client):
    return mmrag._retry_generate_content(
        client, model="x", contents=["x"], backoffs=(0, 0, 0)
    )


def test_1_single_exhausted_no_gate():
    print("\n[test 1/7] single exhausted does NOT trip gate")
    _reset_gate()
    client = _client("429,429,429,200")  # first call exhausts (3), second succeeds
    raised = None
    try:
        _embed(client)
    except Exception as e:
        raised = e
    _check("first call exhausted (raised)", raised is not None)
    _check("gate NOT set after single exhaustion", mmrag._quota_drained_until is None)
    result = _embed(client)  # should proceed normally, consume the 200
    _check("second call proceeds and succeeds", result is not None)


def test_2_two_exhausted_trips_gate():
    print("\n[test 2/7] two exhausted within 5min trips gate; 3rd fails fast")
    _reset_gate()
    client = _client("429,429,429,429,429,429")  # two full exhaustions
    for _ in range(2):
        try:
            _embed(client)
        except Exception:
            pass
    _check("gate set after 2 exhaustions", mmrag._quota_drained_until is not None)
    idx_before = client.models._index
    raised = None
    try:
        _embed(client)  # third call — must fail fast, NOT touch the client
    except Exception as e:
        raised = e
    _check("third call raised (fail-fast)", raised is not None)
    _check("fail-fast error code is 429", getattr(raised, "code", None) == 429)
    _check("fail-fast status RESOURCE_EXHAUSTED",
           getattr(raised, "status", None) == "RESOURCE_EXHAUSTED")
    _check("client NOT called on fail-fast (no backoff, no request)",
           client.models._index == idx_before, detail=f"index moved to {client.models._index}")


def test_3_success_clears_gate():
    print("\n[test 3/7] successful call clears the gate")
    _reset_gate()
    # Simulate an active gate, then bypass the gate check once so a probe runs.
    mmrag._quota_drained_until = mmrag.time.time() + 3600
    mmrag._recent_exhausted = [mmrag.time.time()]
    orig_gate = mmrag._quota_gate_check
    mmrag._quota_gate_check = lambda func, model: None  # bypass for the probe
    try:
        result = _embed(_client("200"))
    finally:
        mmrag._quota_gate_check = orig_gate
    _check("probe succeeded", result is not None)
    _check("gate cleared after success", mmrag._quota_drained_until is None)
    _check("sliding window cleared after success", mmrag._recent_exhausted == [])


def test_4_midnight_auto_release():
    print("\n[test 4/7] gate auto-releases at UTC midnight")
    _reset_gate()
    mmrag._quota_drained_until = mmrag.time.time() - 10  # already in the past
    mmrag._recent_exhausted = [mmrag.time.time() - 20]
    result = _embed(_client("200"))  # gate check sees now >= drained_until → release
    _check("call proceeded after auto-release", result is not None)
    _check("gate cleared on auto-release", mmrag._quota_drained_until is None)


def test_5_gate_shared_across_functions():
    print("\n[test 5/7] gate persists across embed + generate (shared state)")
    _reset_gate()
    trip = _client("429,429,429,429,429,429")
    for _ in range(2):
        try:
            _embed(trip)
        except Exception:
            pass
    _check("gate set via embed", mmrag._quota_drained_until is not None)
    gen_client = _client("200")  # would succeed IF called
    raised = None
    try:
        _generate(gen_client)  # must fail fast via shared gate
    except Exception as e:
        raised = e
    _check("generate failed fast via shared gate", raised is not None)
    _check("generate_content NOT called", gen_client.models._index == 0,
           detail=f"index={gen_client.models._index}")


def test_6_false_positive_10min_apart():
    print("\n[test 6/7] two exhausted 10min apart do NOT trip (window drops first)")
    _reset_gate()
    real_time = mmrag.time.time
    base = real_time()
    fake = {"now": base}
    mmrag.time.time = lambda: fake["now"]
    try:
        try:
            _embed(_client("429,429,429"))
        except Exception:
            pass
        fake["now"] = base + 600  # +10 min
        try:
            _embed(_client("429,429,429"))
        except Exception:
            pass
        _check("gate NOT set (exhausted events 10min apart)",
               mmrag._quota_drained_until is None,
               detail=f"window={mmrag._recent_exhausted}")
    finally:
        mmrag.time.time = real_time


def test_7_telemetry_payload():
    print("\n[test 7/7] telemetry payload for fail_fast_quota")
    _reset_gate()
    with tempfile.TemporaryDirectory() as td:
        tel = Path(td) / "kb-retry-telemetry.jsonl"
        orig_path = mmrag._RETRY_TELEMETRY_PATH
        mmrag._RETRY_TELEMETRY_PATH = tel
        try:
            trip = _client("429,429,429,429,429,429")
            for _ in range(2):
                try:
                    _embed(trip)
                except Exception:
                    pass
            try:
                _embed(_client("200"))  # fail-fast → emits fail_fast_quota
            except Exception:
                pass
            lines = [json.loads(l) for l in tel.read_text().splitlines() if l.strip()]
        finally:
            mmrag._RETRY_TELEMETRY_PATH = orig_path
    ff = [r for r in lines if r.get("outcome") == "fail_fast_quota"]
    _check("exactly one fail_fast_quota event", len(ff) == 1, detail=f"got {len(ff)}")
    if ff:
        r = ff[0]
        _check("http_code 429", r.get("http_code") == 429)
        _check("status RESOURCE_EXHAUSTED", r.get("status") == "RESOURCE_EXHAUSTED")
        _check("attempt 0", r.get("attempt") == 0)
        _check("backoff_s 0", r.get("backoff_s") == 0)


if __name__ == "__main__":
    test_1_single_exhausted_no_gate()
    test_2_two_exhausted_trips_gate()
    test_3_success_clears_gate()
    test_4_midnight_auto_release()
    test_5_gate_shared_across_functions()
    test_6_false_positive_10min_apart()
    test_7_telemetry_payload()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS (7 scenarios)")
    sys.exit(0)
