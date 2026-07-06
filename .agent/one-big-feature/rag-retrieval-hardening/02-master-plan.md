# OBF Master Plan — RAG Retrieval Hardening ("one door, and the dead door screams")

**Slug:** rag-retrieval-hardening
**Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature (single cohesive fix in one repo; no schema/migration/multi-repo)
**Author:** larry · 2026-07-05
**Origin:** Larry queried the KB, hit a stale/empty store, and wrongly told Josh the RAG was broken. Josh: "the fact that you queried the rag wrong means our system is poorly designed because now every agent is going to do that." Fable design pass confirmed a real code bug, not a discipline lapse.

## Root cause (verified in source)
`knowledge-base/scripts/mmrag.py:41`:
```python
MMRAG_DIR = Path(os.environ.get("MMRAG_DIR", str(Path.home() / ".mmrag")))
```
When `MMRAG_DIR` is unset (any *direct* `python mmrag.py query ...` call — i.e. not routed through the TS wrapper), the tool silently opens `~/.mmrag` — a 228K **dead** store — instead of the real 971M store at `~/.cortextos/<instance>/orgs/<org>/knowledge-base/chromadb`. It then returns a *plausible-looking* empty result. The tool has two entrances and one of them lies.

The correct path is only ever set by `buildKBEnv()` (`src/bus/knowledge-base.ts:71-96`), which every `cortextos bus kb-*` command uses. So the canonical door is already correct; the bug is that the *fallback door still exists and is silent.*

## Fix (three parts; ship in this order)
1. **Kill the fallback (codexer — `mmrag.py`).** If `MMRAG_DIR` is unset, `sys.exit()` with a clear message pointing at `cortextos bus kb-query`. Never default to `~/.mmrag`. Derived `CHROMADB_DIR`/`CONFIG_FILE`/`MEDIA_DIR`/`LOG_DIR` then always sit under an explicit store.
2. **Never-claim-empty guard (codexer — `src/bus/knowledge-base.ts:queryKnowledgeBase`).** Before returning the empty terminal result (line 238), distinguish "0 matches against a healthy store" from "store is empty/unreachable" via a lightweight chunk-count probe on the resolved store. Genuine no-match returns empty as today; a 0-chunk / missing store logs a distinct, loud anomaly instead of a silent empty.
3. **Canonical-entrypoint hook (larry — config, not source).** A PreToolUse Bash gate that blocks raw `mmrag.py` / `~/.mmrag` invocations and points to `cortextos bus kb-query`. Written + wired by Larry directly (shell + settings.json); NOT part of the codexer diff.

Ops already done (Larry, 2026-07-05): `mv ~/.mmrag ~/.mmrag-DEAD-2026-07-05` — the specific stale store is neutralized.

## Scope boundary
- **codexer builds:** part 1 (`mmrag.py`) + part 2 (`knowledge-base.ts`) + unit tests. See `03-specs/spec-01-one-door-no-silent-empty.md`.
- **larry builds:** part 3 hook (separate, config).
- **Out of scope:** re-ingest, reranker changes, store migration — the store is healthy (29.6k chunks).

## Done = 
`npm run build` clean; new unit tests prove (a) unset `MMRAG_DIR` → non-zero exit with actionable message, (b) explicit `MMRAG_DIR` still works, (c) empty-vs-healthy-store distinction surfaces distinctly. No new failures in the existing suite. Diff back to Larry for adversarial review → PR (Josh approves merge).
