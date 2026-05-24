# Vignette Pipeline Skill

Daily stop-motion scene for the Estate App home page hero.

---

## Architecture

- **Source**: `public/vignettes/YYYY-MM-DD.json` committed to RevOps-Global-GIT/ob1-app
- **Component**: `app/components/DailyVignette.tsx` with `variant="hero"` on Estate home
- **Rendered fields**: `title` (hero heading), `beat` (caption), `image` (poster/fallback), `video` (preferred when present)
- **Fallback**: If JSON missing or `title`/`image` absent → renders `DailyVignetteHeroFallback` (standard hero card)

---

## Engine: Primary — generate-daily-vignette.mjs

`ob1-app/scripts/generate-daily-vignette.mjs` is the daily image generator. Runs at ~02:00 PT.

**Pipeline:**
1. Fetches weather signals from Open-Meteo for the Estate (lat 45.8153, lon -122.741)
2. Fetches estate context from Supabase: top insight, priority tasks, egg count, harvests, hive inspections, orchard events, mushroom batches, cottage stays
3. `pickCharacter(signals)` selects chunk / petunia / chunkita based on weather + weekday fallback
4. `composeBeat()` + `composeTitle()` write the prose from character + signals + estate context
5. `composePrompt()` assembles the Wes Anderson Isle of Dogs stop-motion prompt (already contains all style constraints — no external STYLE LOCK needed)
6. Calls `nano-banana-generate.py` via `uv run` with `-i reference/<character>-canonical.png` as character lock
7. Output: `public/vignettes/YYYY-MM-DD-{character}.jpg` + `YYYY-MM-DD.json` sidecar

**Character refs** (canonical PNGs — identity locked):

| Key | File |
|-----|------|
| chunk | `reference/chunk-canonical.png` |
| petunia | `reference/petunia-canonical.png` |
| chunkita | `reference/chunkita-canonical.png` |

Additional canonical PNGs in `/home/cortextos/ob1-app/reference/`: greg, tiffany, dad, mom, alejandro, winston, maple, littlebit, minbit, percy, ducks, chickens.

**Usage:**
```bash
node scripts/generate-daily-vignette.mjs            # today
node scripts/generate-daily-vignette.mjs 2026-05-19 # specific date
node scripts/generate-daily-vignette.mjs --force    # rerender even if present
```

**Env required**: `GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_OB1_USER_ID`

---

## Engine: Secondary — mac-codex Flow path (video)

Uses Greg's 20K Vertex/AI Studio browser credits via labs.google/flow on Greg's Mac.

**2-step video generation:**
1. **Step 1 — Still**: Use JPG from primary engine, or generate via Flow with the character's Flow Characters library entry (`-p <character>`, same canonical PNG) + composePrompt-style scene description
2. **Step 2 — Video**: Flow stitch mode with Step 1 still as **both start frame and end frame** + short motion-only prompt. Character and environment are pinned by the still.

Result: `public/vignettes/YYYY-MM-DD-<scene>.mp4` committed with `git add -f`; `"video"` field added to JSON sidecar.

---

## Character Continuity Rule (Greg directive 2026-05-23)

- Animals and people **MUST** come from canonical PNG: `-i` flag for nano-banana, `-p` (Flow Characters) for Flow
- Poses, activities, and estate context vary daily — **identity never varies**
- No fresh generic characters without the canonical reference — this is what caused the "generic chicken" incident

---

## JSON Format

```json
{
  "version": 1,
  "date": "YYYY-MM-DD",
  "character": "chunk",
  "image": "YYYY-MM-DD-chunk.jpg",
  "video": "YYYY-MM-DD-scene.mp4",
  "title": "Clean Title Case Here",
  "beat": "Clean beat prose. No pronoun prefix.",
  "signals": {
    "season": "spring",
    "time_of_day": "day",
    "condition": "clear",
    "temp_f": 52,
    "weekday": "SAT"
  }
}
```

**Fields**:
- `image` (required): JPG filename. Used as `<img>` and as `<video poster>` when video is present.
- `video` (optional): MP4 filename. When present, component renders `<video autoPlay muted loop playsInline>` instead of image.
- `title` + `image` both required — if either absent, falls back to static hero card.

**iOS Safari**: `playsInline` required for inline autoplay; `muted` required for autoplay without user gesture.

**Git note**: `public/vignettes/` is in `.gitignore` but files are tracked. Use `git add -f` for both JSON and MP4 files.

---

## Broken Title Fix Protocol

**Symptoms**: Wrong/broken text appears as the Estate home hero heading.

1. Identify committed JSON:
   ```bash
   cd /home/cortextos/ob1-app && git show HEAD:public/vignettes/YYYY-MM-DD.json
   ```
2. Check for broken patterns (see 8-Check below)
3. Rewrite `title` and `beat` with clean copy
4. Stage + commit + push:
   ```bash
   git checkout -b fix/vignette-title-MMDD
   git add -f public/vignettes/YYYY-MM-DD.json
   git commit -m "fix(vignette): clean broken-pattern title YYYY-MM-DD"
   git push origin fix/vignette-title-MMDD
   gh pr create --base main ...
   ```
5. After deploy, verify production:
   ```bash
   curl https://ob1.revopsglobal.com/vignettes/YYYY-MM-DD.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['title'], '|', d.get('beat',''))"
   ```

---

## 8-Check Rules (applied to title + beat)

| Check | Pattern |
|-------|---------|
| title_case_and | ` and ` between noun phrases (no verb) |
| at_temperature | `at [number]F` or `at [number]C` in title |
| at_day | `at [weekday]` in title |
| pronoun_prefix | beat starts with "He/She/It has/is/was/has been" |
| not_title_case | any word in title not capitalized |
| metadata | emoji, `!`, source/model tags |
| hedging | "might", "could", "may want to consider" |

---

## Detection SQL (estate_insights broken rows)

```sql
SELECT id, title, dismissed, expires_at FROM estate_insights
WHERE dismissed = false AND expires_at > now()
  AND (
    (title ~ ' and ' AND title ~ ' [A-Z][a-z]')
    OR title ~* ' at \d+[fF]'
    OR title ~* ' at (monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
    OR body ~* '^(he|she|it) has '
    OR body ~* '^(he|she|it) (is|was|has been)'
  );
```

Run against `hubauzvpxuparrvqjytt` (ob1-app prod). If count > 0, dismiss + insert replacements via Supabase MCP (generate API is PIN-gated). Rollback: `UPDATE estate_insights SET dismissed=false WHERE id IN (...)`.

---

## Contamination Risk

The generator uses the live `estate_insights` primary row as narrative context. If a broken-pattern row is live at generation time (~02:00 PT), its copy contaminates the vignette `title` and `beat`. Path A critic gate (PR #135) prevents new broken rows; run Path B cleanup to dismiss any pre-Path-A legacy rows.
