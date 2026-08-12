# KB Retry — Fail-Fast on Daily-Quota Exhaustion

**Status:** Design — not yet implemented
**Priority:** Medium (silent waste; ~6.5min/day per today's telemetry)
**Owner:** develop (implementation), analyst (design)
**Last updated:** 2026-08-12
**Related:** theta 48 (retry wrapper ship), theta 62, `reference_kb_embed_retry`

---

## Problem

`_retry_embed_content` and `_retry_generate_content` in `knowledge-base/scripts/mmrag.py` treat every 429 / `RESOURCE_EXHAUSTED` as transient and burn the full backoff sequence (5s + 15s + 45s ≈ 65s per call) before giving up. This is the correct policy for **per-minute rate limits** — those clear in seconds and the wait helps.

For **daily quota exhaustion**, the wait is dead time. Gemini free-tier caps at ~1000 `embed_content` calls/day; once drained, no amount of backoff within the same UTC day recovers. Every subsequent call still runs the full 65-second retry sequence before failing.

Today's telemetry (2026-08-12 06:36–06:40Z, kb-retry-telemetry.jsonl):
- 6 exhausted outcomes, all `RESOURCE_EXHAUSTED` from Gemini `embed_content`
- All within 4 minutes
- ~6.5 min wall-clock burned on futile backoff waits
- Retry ratio dropped from stable 1.0 to 0.33 on the day

## Root cause

`mmrag.py:365-393` `_retry_embed_content`:

```python
for attempt, backoff in enumerate(backoffs, start=1):
    try:
        result = client.models.embed_content(...)
        return result
    except _genai_errors.APIError as e:
        is_transient = (e.code in TRANSIENT_HTTP_CODES) or (e.status in TRANSIENT_STATUS_NAMES)
        if not is_transient:
            raise
        if attempt < total:
            time.sleep(backoff)  # <-- always waits, even if quota is daily
        else:
            # exhausted
```

`TRANSIENT_STATUS_NAMES = {"UNAVAILABLE", "RESOURCE_EXHAUSTED"}` conflates two failure modes that need different responses:
- **`UNAVAILABLE`** → transient, retry works
- **`RESOURCE_EXHAUSTED` (per-minute rate limit)** → transient, backoff helps
- **`RESOURCE_EXHAUSTED` (daily quota)** → structural, backoff is dead time

The wrapper can't tell (2) from (3) at a single call site — the API response body varies but not consistently.

## Proposed fix

Introduce a **sliding-window quota-drained detector** at module level. When we see enough recent exhausted outcomes to conclude the daily quota (not per-minute burst) is drained, gate subsequent calls to fail-fast until UTC midnight or a probe succeeds.

### State (module-level)

```python
# Sliding window of exhausted timestamps (ISO strings) — most recent K entries.
_RECENT_EXHAUSTED_MAX = 5  # keep last 5
_recent_exhausted: list[float] = []       # epoch seconds

# When set (epoch s), reject embed/generate calls with fail-fast until this time.
_quota_drained_until: float | None = None
```

### Detection (called after each exhausted outcome)

```python
def _record_exhausted(status: str, code: int, now: float) -> None:
    global _quota_drained_until, _recent_exhausted
    if status != "RESOURCE_EXHAUSTED":
        return
    _recent_exhausted.append(now)
    # Keep only entries within last 5 minutes
    cutoff = now - 300
    _recent_exhausted = [t for t in _recent_exhausted if t >= cutoff][-_RECENT_EXHAUSTED_MAX:]
    # If 2+ exhausted within 5 minutes, treat as daily-quota drained
    if len(_recent_exhausted) >= 2:
        _quota_drained_until = _next_utc_midnight(now)
        print(f"    [kb-retry] daily quota detected drained — fail-fast until {time.strftime('%H:%MZ', time.gmtime(_quota_drained_until))}")
```

### Gate (called at start of each retry function)

```python
def _quota_gate_check(func: str, model: str) -> None:
    """Raise a synthetic exhausted APIError if daily quota is known drained."""
    global _quota_drained_until
    if _quota_drained_until is None:
        return
    now = time.time()
    if now >= _quota_drained_until:
        # Reset — new day (UTC), quota may refill. Clear state and probe normally.
        _quota_drained_until = None
        _recent_exhausted.clear()
        return
    _log_retry_event(func, model, attempt=0, total_attempts=0, backoff_s=0, outcome="fail_fast_quota", http_code=429, status="RESOURCE_EXHAUSTED")
    raise _genai_errors.APIError(429, "daily quota drained (fail-fast; retry after UTC midnight)")
```

### Reset (on any successful embed/generate)

```python
# In the success branch of _retry_embed_content / _retry_generate_content:
_log_retry_event(func, model, attempt, total, backoff, "success")
if _quota_drained_until is not None:
    _quota_drained_until = None
    _recent_exhausted.clear()
return result
```

### Wire into both retry wrappers

At the top of `_retry_embed_content` and `_retry_generate_content`, before the loop:
```python
_quota_gate_check("embed_content" or "generate_content", model)
```

Inside the exhausted branch, add:
```python
_record_exhausted(e.status, e.code, time.time())
```

### New telemetry outcome

Add a new outcome value `"fail_fast_quota"` alongside `success | transient | exhausted | non_transient`. Makes the fail-fast rate observable in `analytics/kb-retry-telemetry.jsonl` and downstream `KBRetryMetrics.ratio` computation stays unchanged (fail_fast_quota is neither retry-that-saved nor exhausted-that-wasted-backoff — it's the fix's own telemetry).

## Blast radius

- **Saves:** ~65s per call once the gate trips. Today's incident: 6 exhausted × 65s = ~6.5 min. Over a month with same pattern: ~3 hours cumulative.
- **False-positive risk:** a per-minute burst produces >=2 exhausted within 5min. This would gate the rest of the day incorrectly.
  - Mitigation: threshold "2 within 5min" is conservative — per-minute limits typically clear within one or two backoff waits. Two consecutive full 3-attempt exhaustions within a 5-minute window is strong evidence of daily-quota exhaustion, not per-minute burst. If false-positives observed, tighten to "3 exhausted within 10min".
  - Mitigation 2: the gate auto-releases at UTC midnight; a false-positive costs at most the rest of one day, and any successful call in the interim also clears state.
- **Cost:** ~30 lines of Python, no external deps, no change to public API.
- **Backwards compat:** telemetry consumers see a new `outcome` value; downstream `KBRetryMetrics` in `src/bus/metrics.ts` needs to know about it (add to switch or default-ignore).

---

## Test spec (for develop)

New tests in `tests/kb/mmrag-retry.test.py` (or matching test file). Use a fake `APIError` client that lets each test control the sequence.

### Test 1: single exhausted does NOT trigger gate

```
given: fake client returns 3 RESOURCE_EXHAUSTED then normal success on next call
when:  _retry_embed_content is called once (exhausts), then called again
then:  second call proceeds normally (no gate) — attempt 1 succeeds
       telemetry: exhausted → success (no fail_fast_quota event)
```

### Test 2: two exhausted within 5min triggers gate

```
given: fake client returns 3 RESOURCE_EXHAUSTED consecutively
when:  _retry_embed_content called twice within 5 min, both exhaust
       _retry_embed_content called a third time
then:  third call raises immediately (fail-fast), NO backoff sleeps
       telemetry: fail_fast_quota event emitted
       gate persists until UTC midnight
```

### Test 3: successful call clears gate

```
given: gate is set (drained_until = future)
when:  fake client succeeds on next _retry_embed_content call
       (simulate by mocking _quota_gate_check to bypass once, or advance time past midnight)
then:  _quota_drained_until is None after success
       _recent_exhausted is cleared
```

### Test 4: gate auto-releases at UTC midnight

```
given: _quota_drained_until = fixed epoch (e.g. midnight yesterday)
when:  _retry_embed_content called with now > that time
then:  gate is cleared, call proceeds normally
       new exhausted events start a fresh sliding window
```

### Test 5: gate persists across BOTH retry functions

```
given: exhausted trips in _retry_embed_content
when:  _retry_generate_content called next
then:  fail-fast immediately (shared module state)
```

### Test 6: false-positive edge — 2 exhausted separated by 10min

```
given: 2 exhausted events, 10 minutes apart
when:  _retry_embed_content called a third time within 5min of the 2nd
then:  gate NOT triggered (sliding window drops the first entry)
       call proceeds normally
```

### Test 7: telemetry payload for fail_fast_quota

```
given: gate active
when:  _retry_embed_content is called and fails fast
then:  kb-retry-telemetry.jsonl contains one entry with outcome="fail_fast_quota",
       http_code=429, status="RESOURCE_EXHAUSTED", attempt=0, backoff_s=0
```

---

## Rollout

1. develop implements + tests, fork+PR (like #889/#890/#896 pattern)
2. capitan reviews, merges
3. No config changes; deployment is a `git pull` on fleet
4. Also update `src/bus/metrics.ts` `KBRetryMetrics` if it enumerates outcomes explicitly (verify + append `fail_fast_quota` to whitelist, or ensure default handles unknown outcomes gracefully)
5. Retro after next quota exhaustion cycle: check telemetry for `fail_fast_quota` events; expect wall-clock savings vs pre-fix baseline (roughly N × 65s where N = post-gate calls). Compare against today's 6 × 65s = 390s baseline.

## Out of scope

- Distinguishing daily vs per-minute quota from API response body (unreliable, undocumented)
- Adding an explicit "quota status" endpoint check (Gemini doesn't expose one, would require probing)
- Auto-failover to OpenAI (theta 53 track — still blocked on Ilya billing)
- Retrospective telemetry backfill

## Non-goals

- Perfect quota tracking. This is a heuristic — 2-strikes rule optimizes for cheap detection over precision. False positives are self-healing (release at midnight or on first success).
