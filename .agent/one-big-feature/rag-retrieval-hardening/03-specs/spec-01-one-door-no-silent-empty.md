# Spec 01 — One door, and the dead door screams

**Repo:** /Users/joshweiss/code/cortextos
**Owner (build):** codexer
**Reviewer:** larry (adversarial) → PR (Josh approves merge)

## Josh's exact intent
"Fix the rag" so that no agent can query the wrong store and wrongly conclude the KB is empty. The retrieval interface must have ONE reliable door; a wrong/empty store must fail loudly, not return a plausible empty result.

## Change 1 — `knowledge-base/scripts/mmrag.py` (line 41 region)
Current:
```python
MMRAG_DIR = Path(os.environ.get("MMRAG_DIR", str(Path.home() / ".mmrag")))
CONFIG_FILE = Path(os.environ.get("MMRAG_CONFIG", str(MMRAG_DIR / "config.json")))
CHROMADB_DIR = Path(os.environ.get("MMRAG_CHROMADB_DIR", str(MMRAG_DIR / "chromadb")))
MEDIA_DIR = MMRAG_DIR / "media"
LOG_DIR = MMRAG_DIR / "logs"
```
Required:
- If `MMRAG_DIR` is **unset or empty**, do NOT fall back to `~/.mmrag`. Instead exit immediately with a clear, actionable error to stderr and a non-zero code:
  ```
  MMRAG_DIR is not set. Do not call mmrag.py directly — use:  cortextos bus kb-query '<question>' --org <org>
  (the wrapper resolves the correct store; a bare call would open a wrong/empty store and lie.)
  ```
- Implement as a small guarded resolution at import/constant time (a helper that reads the env var and `sys.exit(2)` with the message if missing). Keep `MMRAG_CONFIG` / `MMRAG_CHROMADB_DIR` overrides working when explicitly set (they already default off `MMRAG_DIR`, which is now guaranteed present).
- Preserve every other behavior. This is a fail-fast guard, not a refactor.

## Change 2 — `src/bus/knowledge-base.ts` → `queryKnowledgeBase` (returns around line 226-238)
Add a **never-claim-empty guard**. Today, when `allResults.length === 0` the function returns `{ results: [], total: 0, ... }` — indistinguishable from "the store is empty/unreachable." Distinguish the two:
- When the result set is empty, run one lightweight probe of the resolved store's chunk count (reuse the same `pythonPath` + `mmragPath` + `env` already built; call mmrag.py's existing status/count path with `--json` — inspect `mmrag.py` for the correct subcommand, e.g. `status`/`info`; if none exists, add a minimal `--count`/`status` JSON output in Change 1's file as part of this build).
- If the store reports **> 0 chunks**: genuine no-match — return the existing empty response unchanged (optionally set `collection` note "healthy store, 0 matches").
- If the store reports **0 chunks / probe fails**: this is an anomaly. Emit a distinct `console.warn('[kb] ANOMALY: resolved store has 0 chunks / unreachable — do NOT conclude the KB is empty; store=<path>')` and still return empty results (do not throw), but the log line must be unmistakably different from a normal no-match.
- Do not change the configured-check at line 148 (that path is already explicit).

## Constraints
- TypeScript strict; no `any`; no `console.log` (use `console.warn` for the anomaly line, matching existing style at line 149).
- Python: match existing style in mmrag.py; no new deps.
- No behavior change to ingest/reconcile.

## Tests (required — add to existing suite)
- Python (if a python test harness exists under `knowledge-base/`) OR a TS unit test that shells the guard: unset `MMRAG_DIR` → non-zero exit + message contains `cortextos bus kb-query`.
- Explicit `MMRAG_DIR=<tmp>` → runs normally (no exit).
- `knowledge-base.ts`: mock/inject the probe so an empty-result + 0-chunk store produces the ANOMALY warn, and an empty-result + healthy store does NOT. Follow the existing test patterns in `tests/unit/` (see how other bus modules are unit-tested).

## Done =
`npm run build` clean; new tests pass; existing suite shows no NEW failures (the ~18 known pre-existing failures unrelated to KB are acceptable — list them so Larry can confirm they are unchanged). Return the diff + a scope-match report to Larry.
