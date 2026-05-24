---
name: vignette
description: "You need to generate, update, or troubleshoot the Estate App daily vignette (still image + optional MP4 video loop) at ob1.revopsglobal.com. The vignette is the hero card on the Estate App home page. Use this skill when asked to ship a vignette, fix vignette copy, debug missing/broken state, or coordinate the daily generation pipeline."
triggers: ["vignette", "daily vignette", "flow video", "vignette mp4", "vignette copy", "estate hero", "vignette pipeline", "generate-daily-vignette"]
external_calls: ["nano-banana-generate.py (Gemini 3 Pro Image / Nano Banana Pro)", "Google Flow (labs.google/fx/tools/flow via mac-codex)", "Open-Meteo weather API", "Supabase (estate_insights, maintenance_tasks, egg_production, harvests, etc.)"]
---

# Vignette

The daily vignette is the Estate App home hero — a generated stop-motion still + warm prose driven by real weather signals and live estate context from Supabase.

---

## Engine: Primary — generate-daily-vignette.mjs

`ob1-app/scripts/generate-daily-vignette.mjs` is the canonical daily generator.

**Pipeline:**
1. Fetches weather from Open-Meteo (Estate lat/lon)
2. Fetches estate context from Supabase: top `estate_insights` row, priority tasks, egg count, harvests, hive inspections, orchard events, mushroom batches, cottage stays
3. `pickCharacter(signals)` selects chunk / petunia / chunkita via weather + weekday fallback
4. `composeBeat()` + `composeTitle()` generate prose from character + signals + estate context
5. `composePrompt()` assembles the Wes Anderson Isle of Dogs stop-motion prompt — **this owns all style constraints**; no external STYLE LOCK competes with it
6. Calls `nano-banana-generate.py` via `uv run` with `-i reference/<character>-canonical.png` as character lock
7. Output: `public/vignettes/YYYY-MM-DD-{character}.jpg` + `YYYY-MM-DD.json` sidecar

**Character refs** (canonical PNGs — identity locked):

| Key | File |
|-----|------|
| chunk | `reference/chunk-canonical.png` |
| petunia | `reference/petunia-canonical.png` |
| chunkita | `reference/chunkita-canonical.png` |

Additional canonical PNGs at `/home/cortextos/ob1-app/reference/`: greg, tiffany, dad, mom, alejandro, winston, maple, littlebit, minbit, percy, ducks, chickens.

**Env required**: `GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_OB1_USER_ID`

---

## Engine: Secondary — mac-codex Flow path (video)

Uses Greg's 20K Vertex/AI Studio browser credits via labs.google/flow on Greg's Mac.

**2-step video generation:**
1. **Step 1 — Still**: Use primary-engine JPG, OR generate via Flow with the character's Flow Characters library entry (`-p <character>`, same canonical PNG) + composePrompt-style scene description
2. **Step 2 — Video**: Flow stitch mode with Step 1 still as **both start frame and end frame** + short motion-only prompt. Character and environment are pinned by the still.

Result: `public/vignettes/YYYY-MM-DD-<scene>.mp4` committed with `git add -f`; `"video"` field added to JSON sidecar.

---

## Character Continuity Rule (Greg directive 2026-05-23)

- Animals and people **MUST** come from canonical PNG: `-i` flag for nano-banana, `-p` (Flow Characters) for Flow
- Poses, activities, and context vary daily — **identity never varies**
- No fresh generic characters without the canonical reference — this is what caused the "generic chicken" incident 2026-05-23

---

## Coordination

| Task | Agent |
|------|-------|
| Run primary engine (still) | family-agent (local) or codex dispatch |
| Flow video generation | mac-codex on Greg's Mac |
| Copy/title rewrite | family-agent |
| Supabase row cleanup (Path B) | dev (Supabase MCP) |
| UI integration + ob1-app port | family-agent |

---

## JSON Schema

```json
{
  "version": 1,
  "date": "YYYY-MM-DD",
  "character": "chunk",
  "image": "YYYY-MM-DD-chunk.jpg",
  "video": "YYYY-MM-DD-scene.mp4",
  "title": "Clean Title Case Here",
  "beat": "Clean beat prose. No pronoun prefix.",
  "signals": { "season": "spring", "time_of_day": "day", "condition": "clear", "temp_f": 52, "weekday": "SAT" }
}
```

`video` is optional. When present, `DailyVignette` renders `<video autoPlay muted loop playsInline>` with `image` as poster. Both JSON and MP4 need `git add -f` (directory is gitignored).

---

## Runbooks

### "Ship today's vignette (still)"
```bash
cd /home/cortextos/ob1-app
node scripts/generate-daily-vignette.mjs
git add -f public/vignettes/$(date +%Y-%m-%d)*.jpg public/vignettes/$(date +%Y-%m-%d).json
git commit -m "feat(vignette): $(date +%Y-%m-%d) daily scene"
```

### "Fix broken title/beat"
1. `git show HEAD:public/vignettes/YYYY-MM-DD.json` — see committed values
2. Apply 8-check rules below; rewrite clean copy
3. `git add -f public/vignettes/YYYY-MM-DD.json && git commit && git push`
4. Verify: `curl https://ob1.revopsglobal.com/vignettes/YYYY-MM-DD.json`

### "Debug missing vignette"
1. Check if JPG exists: `ls /home/cortextos/ob1-app/public/vignettes/$(date +%Y-%m-%d)*`
2. Check Vercel deploy state
3. Trace logs: Supabase function logs + Vercel runtime logs on ob1-app

---

## 8-Check Rules

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

Run against `hubauzvpxuparrvqjytt`. Rollback: `UPDATE estate_insights SET dismissed=false WHERE id IN (...)`.

---

## Contamination Risk

Generator uses live `estate_insights` primary as narrative context. Broken row at generation time (~02:00 PT) → contaminated title/beat. Path A critic gate (PR #135) prevents new broken rows; Path B cleanup dismisses legacy rows.

---

## Lessons Learned

1. **artisan-stopmotion SKILL.md is NOT the vignette style contract** — that skill is for cinematic stop-motion video production (Nano Banana 2, overhead birds-eye, ochre hands). Vignette style is embedded in `composePrompt()` in the mjs generator.
2. **Character continuity**: `-i reference/<character>-canonical.png` is the lock. Omitting it causes generic off-brand animals (the "generic chicken" incident 2026-05-23).
3. **git add -f required**: `public/vignettes/` is gitignored. Both JSON and MP4 need force-add or Vercel won't serve them.
4. **2026-05-23 title fix**: "Chunk and Lettuce Bolt Risk At 80f Thursday" came from legacy estate_insights row baked into JSON at 12:39Z, before Path B cleanup. Not a generator regression.
