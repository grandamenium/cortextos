# Per-file build specs — muse-humanizer-enforcement

Implement exactly. Source of truth for behavior: `../01-spec.md`. Canonical hash: `../01-spec.md` §2a.

## 1. NEW `orgs/clearworksai/agents/muse/scripts/lib_normalize.py`
```python
import unicodedata, hashlib, re, sys
def humanizer_hash(text: str) -> str:
    s = unicodedata.normalize('NFC', text)
    s = re.sub(r'\s+', ' ', s).strip()
    return hashlib.sha256(s.encode('utf-8')).hexdigest()
if __name__ == '__main__':
    print(humanizer_hash(sys.stdin.read()))
```
The ONE implementation. No bash reimplementation anywhere.

## 2. NEW `orgs/clearworksai/agents/muse/.claude/hooks/enforce-humanizer.sh`
PreToolUse hook. I/O contract identical to `larry/.claude/hooks/gate-codexer-planning.sh` (stdin JSON → `.tool_name`/`.tool_input`; block via `{"decision":"block","reason":<jq -Rn>}`; `exit 0`=allow). Logic order (FIXED — §4):
1. Parse `tool_name`, `tool_input`. Classify sink (A telegram / B linkedin-enqueue / C n/a-hook-can't-see / D draft-emit / E brief). Not A–E → `exit 0`.
2. Sink A only: ops-discriminator — `len(msg)<=280 && msg =~ ops-regex` → `exit 0`. Ops regex constant at top: `booting|restart|context window full|approval needed|^OK$|^back |online|heartbeat|^ack|will be back|crash`.
3. Any sink: payload contains `[humanizer]` sentinel → `exit 0` (escape hatch).
4. Content path: ref-precondition (4 files in §6 readable; else block `humanizer_refs_unreachable` error) → ledger check → action.
- Ledger check: `H=$(printf '%s' "$content" | python3 <muse>/scripts/lib_normalize.py)`; grep `"hash":"$H"` in `$CTX_AGENT_DIR/state/humanizer-ledger.jsonl` within 30d. Match → `exit 0`; else block.
- Content extraction MUST go through a parser, never raw command line (§2a): for Bash `send-telegram`, extract the quoted message via jq from `tool_input` where possible / decode; for Write/Edit to queue, `json.load` the `text` field.
- Circuit breaker: track consecutive same-hash blocks in `$CTX_AGENT_DIR/state/humanizer-breaker.json`; N=3 within M=30min → allow + `log-event humanizer_breaker_open error` + `[humanizer]` telegram to Josh. Reset on any allowed ledgered send.
- On block: `cortextos bus log-event content humanizer_block warn --meta {...}`; reason names the 4 ref files + "Invoke the-humanizer skill on this content, then resend."

## 3. EDIT `orgs/clearworksai/agents/muse/.claude/settings.json`
Add `enforce-humanizer.sh` as the FIRST `PreToolUse` hook entry matching `Bash`, `Write`, `Edit`. Preserve the existing `AskUserQuestion` entry. Valid JSON (verify with `python3 -m json.tool`).

## 4. EDIT `orgs/clearworksai/skills/the-humanizer/SKILL.md`
Add **Step 4.5 (after self-check, before surfacing/emit, SAME turn as emit):** compute `humanizer_hash(final_text)` and append to `$CTX_AGENT_DIR/state/humanizer-ledger.jsonl`:
`{"v":1,"hash":"<h>","channel":"<telegram|linkedin|newsletter|blog|brief|email>","ts":"<iso8601>","agent":"<CTX_AGENT_NAME>"}`
Then `cortextos bus log-event content humanizer_pass info --meta '{"hash":"<h>","channel":"<c>","agent":"<a>"}'`. Agent-generic — no muse hardcoding. Keep additive; do not change existing steps' behavior.

## 5. EDIT `orgs/clearworksai/agents/muse/scripts/enqueue-post.py`
`from lib_normalize import humanizer_hash`. In `main()` post dict: add `'humanized': True, 'humanized_hash': humanizer_hash(text)`. (Hash computed here = source of truth for the queue entry; §2b/R1.)

## 6. EDIT `orgs/clearworksai/agents/muse/scripts/process-posts.py`
Before each live LinkedIn post: `if humanizer_hash(post['text']) != post.get('humanized_hash'): skip + log-event humanizer_block warn + continue`. Import from `lib_normalize`. This is the sole sink-C enforcement (hook can't see this cron subprocess).

## 7. TESTS `orgs/clearworksai/agents/muse/tests/test_humanizer_enforcement.py` (or repo tests/ per convention)
Env-clean (scrub CTX_* per `feedback_cortextos_test_env_clean_first`). Cases: (a) ops ping pass; (b) `[humanizer]` escape pass; (c) unledgered content block; (d) ledgered content allow; (e) **unicode regression: skill-side `humanizer_hash('… — em dash 🚀') == hook-side hash of same string read through the parser**; (f) refs-unreachable blocks content but ops still passes; (g) `send-message` agent→agent pass; (h) `enqueue-post.py` stamps matching hash; (i) `process-posts.py` skips on hash mismatch; (j) breaker opens after 3 same-hash blocks in 30min.

## Constraints
No `any`-equivalent loose typing in py (annotate); no `print`-debug left in; atomic writes for ledger/breaker (`os.replace`); no network in tests. Run env-clean before claiming green.
