---
name: site-availability-verify
description: "Four-step network-layer verification that a prospect's website is actually up, down, parked, or redirected — before any cold-outreach hook depends on site state. WebFetch alone is insufficient; this skill is its replacement."
triggers: ["site availability verify", "is the site really down", "site state check", "domain verification", "pre-send site verify"]
external_calls: ["getent (DNS)", "curl"]
---

# Site Availability Verify

> Four-step network-layer check that a domain is up, down, parked, or redirected.
> Replacement for WebFetch-only site-state verification in cold outreach.
> Cited by parent skill `cold-outreach-verify` (Category 1: Site state).

---

## Why This Exists

Cold-outreach hooks that reference site state ("your site is down", "your site redirects", "your site has only two pages", "your site is parked-for-sale") MUST match the prospect's actual visitor experience. A false positive — claiming the site is down when it loads cleanly in the prospect's browser — is the worst possible kind of factual error: it makes us look like we never actually visited.

WebFetch is not sufficient. WebFetch has its own timeout, TLS, user-agent, and geo handling that diverges from a real visitor's browser. **Worked example (Beebe Mechanical, 2026-05-11):** WebFetch returned "socket closed" → drafted hook "site won't load" → Aiden browser-verified the site loaded cleanly → draft killed at the gate, trust hit avoided only because Aiden read it.

This skill is the minimum bar before any site-state claim enters a draft.

---

## The Four Steps

For each domain (and the apex AND the `www.` variant — both must be checked when the hook depends on availability):

### Step 1 — DNS resolves

```bash
getent hosts <domain>
getent hosts www.<domain>
```

Verdict mapping:
- Returns one or more IPs → DNS is live, proceed.
- Returns nothing AND `curl` confirms "Could not resolve host" → **NXDOMAIN**. Site is not reachable from any network. This is a strong, network-layer signal — safe to claim "domain offline" / "no longer loads".
- Returns IPs for some variants but not others → flag, check both before drafting.

### Step 2 — HTTPS HEAD

```bash
curl -sk -I -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" --max-time 10 https://<domain>/
```

Capture: HTTP status, `Server:` header, `Location:` (if 3xx).

- 200 → site is live over HTTPS. **Cannot claim "down".**
- 301/302/307/308 → redirect. Record the `Location` target — that's the actual resolved page. Common patterns:
  - Redirect to `www.<same-domain>` → mostly benign.
  - Redirect to `forsale.godaddy.com`, `sedo.com`, `dan.com`, `afternic.com` → **parked-for-sale**. Hook should match.
  - Redirect to a different operating domain → domain change; verify new domain operates the same business before any hook fires.
- 4xx → server reachable, page-not-found / forbidden. Re-check the path.
- 5xx → server error. Save the status code for the draft if claiming "site error".
- TLS failure / connection refused / timeout → record the exact error string. Proceed to Step 3 to see if plain HTTP behaves differently.

### Step 3 — HTTP HEAD (force plain HTTP, no -k bypass needed)

```bash
curl -sI -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" --max-time 10 http://<domain>/
```

- 200 → plain HTTP serves content. Compare against the HTTPS verdict — many small-business sites serve HTTP but lack a working TLS cert. Hook nuance matters: "no HTTPS" is not the same as "site is down".
- 3xx → check `Location`. Often plain HTTP redirects to HTTPS (i.e., the canonical site is HTTPS).
- Connection refused / no route → no plain HTTP either, reinforces "site offline".

### Step 4 — Full GET with redirect follow + body capture

```bash
curl -sk -L -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" --max-time 15 -o /tmp/site_body_<slug>.html -w "FINAL_URL=%{url_effective}\nHTTP_CODE=%{http_code}\nREDIRECT_COUNT=%{num_redirects}\n" https://<domain>/
```

Then inspect:
- `FINAL_URL` — where the visitor actually lands. If different domain → flag immediately.
- `HTTP_CODE` — final status after all redirects.
- `/tmp/site_body_<slug>.html` — visually scan for:
  - Parked-page markers ("Buy this domain", "This domain is for sale", "Click here to inquire", godaddy/sedo branding).
  - JS-based redirects: `<script>window.location.href = "..."</script>` (HEAD won't catch these — only GET reveals them).
  - Empty body / `<html></html>` → likely SPA or broken server-side render; this is one of the few cases where a real browser load is needed before drafting a "no content" hook.

---

## Verdict Matrix

| Step 1 (DNS) | Step 2 (HTTPS) | Step 3 (HTTP) | Step 4 (GET body) | Verdict | Safe hook |
|---|---|---|---|---|---|
| Resolves | 200 | 200 / 3xx-to-HTTPS | Real content | **LIVE** | No "down" claim. Use content-based hooks only. |
| NXDOMAIN | Cannot connect | Cannot connect | — | **OFFLINE** | "Site no longer loads" / "domain offline". |
| Resolves | 3xx → parked-page | 3xx → parked-page | Parked-page markers | **PARKED-FOR-SALE** | "Domain is parked for sale" — categorical fact-pattern, not a "redirect with no content". |
| Resolves | 200 / 3xx | 200 / 3xx | JS-redirect body | **JS-REDIRECT** | Record where it redirects to before drafting. |
| Resolves | TLS fail | 200 | Content via HTTP | **NO-HTTPS** | "No working HTTPS" is the hook, not "site is down". |
| Resolves | 5xx | 5xx | Error body | **SERVER-ERROR** | "Site returns HTTP X" — only with the exact status code. |
| Mixed | — | — | — | **FLAG** | Hold and re-verify; do not draft until both variants align. |

---

## Failure Modes to Watch

1. **WebFetch-says-down-but-site-loads.** Default to this 4-step layer; WebFetch is informational only, never authoritative.
2. **`www.` variant differs from apex.** Always check both. If one resolves and the other does not, that is the actual visitor story — do not pick the convenient one.
3. **Geo / IP blocking.** If your egress IP is captcha-walled or geo-blocked (e.g., SiteGround WAF), the verdict reflects your perspective, not the prospect's. Flag and route to Aiden-side verify.
4. **Stale cache.** Two checks more than ~6h apart are not the same check. If the draft is going out today, the verify must be from today.
5. **Carrier-grade NAT / split-horizon DNS.** Rare, but a domain that resolves on one path and not another is a flag, not a verdict.

---

## What This Skill Does NOT Verify

- **Visual / rendered content.** JS-rendered widgets (Google Reviews, Wix testimonials, Squarespace carousels) require a real browser. If the hook depends on the rendered DOM, that is out-of-scope here — escalate to a Playwright-equivalent gate.
- **Review counts, traffic numbers, brand-operating status, owner identity.** Those have their own categories in parent `cold-outreach-verify`.
- **Whether the operating business has changed hands.** Domain still resolving + still serving doesn't prove the same people are running it.

---

## Integration

Parent skill `cold-outreach-verify` invokes this skill as Category 1 (Site state). The Source-Fact Ledger entry for any site-state claim must cite the verdict from this skill and link the four step outputs (`getent` result, HEAD codes, GET final URL) in the evidence trail.

---

## Worked Examples (from 2026-05-11 batch-1 rebuild)

| Prospect | Step 1 | Step 2 | Step 3 | Step 4 | Verdict | Drafted hook | Status |
|---|---|---|---|---|---|---|---|
| Beebe Mechanical | Resolves (216.211.21.215) | 301 IIS | 301 | 200 final | **LIVE** | "site won't load" | **FALSE — KILLED** |
| Ben's Plumbing & Heating | NXDOMAIN | Cannot connect | Cannot connect | — | **OFFLINE** | "every directory links to a domain that no longer loads" | **HOLDS** |
| Robert's Plumbing | Resolves (AWS IPs) | 200 + JS redirect | 200 | 307 → forsale.godaddy.com | **PARKED-FOR-SALE** | "redirect, no indexable content" | **FACT-PATTERN SHIFT — KILLED, rehook needed** |
| Adept Plumbing | Resolves | 301 → Squarespace | 301 | 200 (2 pages only) | **LIVE** | content-claim, not site-state | (out of scope here) |
| Priest Plumbing | Resolves | 200 | 301 → HTTPS | 200 | **LIVE** | content-claim, not site-state | (out of scope here) |

Net result: 2 of 5 site-state hooks would have shipped wrong under the old (WebFetch + ledger) stack. This 4-step layer catches both at the gate.

---

## Quick One-Shot Helper (optional)

If a single domain needs a fast read, this one-liner produces all four step outputs:

```bash
D=<domain>; SLUG=$(echo "$D" | tr -c 'a-zA-Z0-9' '_')
echo "=== getent ==="; getent hosts "$D"; getent hosts "www.$D"
echo "=== HTTPS HEAD ==="; curl -sk -I --max-time 10 "https://$D/"
echo "=== HTTP HEAD ==="; curl -sI --max-time 10 "http://$D/"
echo "=== GET (follow + body) ==="
curl -sk -L --max-time 15 -o "/tmp/site_body_${SLUG}.html" \
  -w "FINAL_URL=%{url_effective}\nHTTP_CODE=%{http_code}\nREDIRECT_COUNT=%{num_redirects}\n" \
  "https://$D/"
echo "Body saved to /tmp/site_body_${SLUG}.html"
```

Read the body file before drafting. Cite the FINAL_URL in the ledger.
