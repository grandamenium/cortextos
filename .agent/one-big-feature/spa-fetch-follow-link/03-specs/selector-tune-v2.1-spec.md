# Spec — spa-fetch.py v2.1 host-normalization fix (was: "selector tune")

**Status:** ROOT CAUSE PROVEN by Larry via live DOM + live helper runs 2026-06-20 (bridge :9333). The original task framing ("event_link_selector unpopulated / needs tuning") was a MISDIAGNOSIS. The selectors are correct. The real bug is a `www.` host-lookup miss.

## File to edit
`orgs/personal/agents/scout/scripts/spa-fetch.py` — in place. Git-ignored, NO commit / NO PR. Diff returns to Larry for adversarial review before scout validates.

## Root cause (the actual bug)
Host derivation does NOT strip a leading `www.` before the `HOST_HINTS` lookup:
- `build_browser_script()` L154: `host = urlparse(url).netloc.lower()` → `www.whammyanalog.com`
- `normalize_url()` L121: `host = parsed.netloc.lower()` → same
- `HOST_HINTS` keys are bare apex hosts (`whammyanalog.com`, `americancinematheque.com`).

When scout passes a `www.` URL, `HOST_HINTS.get(host, {})` returns `{}`. The landing still renders (wait_for_text_ready polls regardless), so the failure is SILENT — but `event_link_selector` is `None`, so `collect_event_links()` returns `[]` and `EVENT_DETAILS:` is empty. For americancinematheque the `path_override` AND the L124 special-case (`host == "americancinematheque.com"`) also miss, so the calendar→now-showing rewrite never fires.

**Proof (live, 2026-06-20):**
| Host | URL passed | Before fix | With non-www (= post-fix behavior) |
|------|-----------|-----------|------------------------------------|
| Whammy | `https://www.whammyanalog.com/whammy-events` | 0 EVENT_DETAILS (HINT empty, selrepr=None, but `a.eventcardlink`=4 in DOM) | **4 events, cost $6/$25/$10/$10** |
| AC Los Feliz 3 | `https://www.americancinematheque.com/now-showing/?event_location=102` | 0 | **5 events, FULL fields** (showtime + cost `$10/$15` + ticket_url) |

Dynasty + Heavy Manners always worked because scout passes them BARE (non-www).

## The fix (required)
Normalize the host by stripping a single leading `www.` before every `HOST_HINTS` lookup AND before the americancinematheque special-case. Apply in BOTH places:
- `normalize_url()` (L121)
- `build_browser_script()` (L154)

Suggested helper:
```python
def _hint_host(netloc: str) -> str:
    h = netloc.lower()
    return h[4:] if h.startswith("www.") else h
```
Use `_hint_host(parsed.netloc)` / `_hint_host(urlparse(url).netloc)` for the HINT key and the `== "americancinematheque.com"` comparison. Do NOT mutate the fetched URL itself (keep following the user-supplied/redirected URL); only the LOOKUP KEY changes.

## Regression gates (non-negotiable — adversarial review verifies)
1. **No-flag path byte-identical**: `python3 spa-fetch.py <url>` (no `--follow-events`) output unchanged vs current for a www and a non-www host. (`cmp` a www host before/after — landing text must be identical EXCEPT it now correctly applies HINT waits; if landing text shifts, flag it.)
2. **Bare-host hosts unaffected**: Dynasty + Heavy Manners follow-events output unchanged (they were already non-www → `_hint_host` is a no-op for them).
3. Tab hygiene unchanged (baseline assert + per-event close + drift abort all intact).

## Acceptance (scout validates post-build)
1. `--follow-events https://www.whammyanalog.com/whammy-events` → ≥4 EVENT_DETAILS, cost populated. (PROVEN to work once host strips www.)
2. `--follow-events https://www.americancinematheque.com/now-showing/?event_location=102` → ≥5 EVENT_DETAILS, showtime + cost + ticket_url populated.
3. Dynasty + Heavy Manners follow runs unchanged from prior validated output.
4. No-flag Zebulon run output identical to today.

## OUT OF SCOPE (deferred, NOT part of this fix)
- **Vidiots** (`vidiotsfoundation.org/calendar`): scout already passes it BARE; HINT is found; but the calendar is a **Filmbot-powered widget** — live DOM has NO `/film/` or `/movies/` anchors at all (only a `filmbot.com` footer link). Per-film links are not plain anchors. Needs separate investigation (Filmbot iframe/embed or JS-onclick navigation) — do NOT attempt a selector swap here; it will not match. Logged as v2.2 follow-up.
- **Whammy field selectors**: cost works; `showtime` + `ticket_url` selectors miss (loud WARN fires correctly). Optional secondary field-selector tune — leave for v2.2 unless trivial; the cost field (the hard-rule gate) already works.
- **Zebulon**: cost is on the landing page (`screenshot_first=True`, no `event_link_selector`). Follow-link adds no value by design. No change. Confirmed N/A.
