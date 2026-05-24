# Vignette Pipeline Skill

Daily stop-motion scene for the Estate App home page hero.

---

## Architecture

- **Source**: `public/vignettes/YYYY-MM-DD.json` committed to RevOps-Global-GIT/ob1-app
- **Component**: `app/components/DailyVignette.tsx` with `variant="hero"` on Estate home
- **Rendered fields**: `title` (hero heading), `beat` (caption), `image` (poster/fallback), `video` (preferred when present)
- **Fallback**: If JSON missing or `title`/`image` absent → renders `DailyVignetteHeroFallback` (standard hero card)

---

## Style Contract

Canonical style is defined in `team-brain/.claude/skills/artisan-stopmotion/SKILL.md`. Read that skill before generating any Flow prompt. The STYLE LOCK from that skill is the mandatory prompt prefix for both Step 1 and Step 2.

```
STYLE LOCK:
"Stop-motion animation film still, Wes Anderson Isle of Dogs aesthetic. Miniature diorama quality.
HANDS: Matte ochre-yellow sculpted resin hands, solid uniform skin tone approximately #C7A446, simplified blocky fingers, no pores no wrinkles, tiny scattered black speckles visible on skin surface, mannequin-like smooth finish — NOT realistic human skin, NOT claymation, NOT marionette.
CAMERA: Overhead 90-degree birds-eye locked flat-lay, no perspective tilt, clean graphic framing.
LIGHTING: Soft flat overhead studio light, even diffused illumination, gentle shadows, controlled like product photography — NOT dramatic side lighting.
SURFACE: Light ash or oak wood, straight prominent vertical grain, warm neutral tone, matte finish — NOT dark walnut, NOT glossy.
CUTTING BOARD (if present): Pale maple or birch, rectangular, slightly worn matte finish, sits on top of main surface.
MATTE EVERYTHING: No specular reflections, no shine, no gloss anywhere except lacquerware props. Every surface is matte.
FOOD/OBJECTS: Stylized and simplified like sculpted models — NOT photorealistic. Graphic, clean forms.
COLOR: Warm neutral palette dominated by ochre, tan, pale wood. One saturated accent color as pop.
SHARPNESS: Ultra-sharp, every frame a perfect photograph, no motion blur, no depth-of-field bokeh."
```

---

## 2-Step Generation Contract (Greg directive 2026-05-23T02:35Z)

Flow generation uses a 2-step character continuity process:

1. **Step 1 — Still (Imagen):** Generate reference still photo via Flow Imagen using STYLE LOCK + scene prompt. Establishes character pose, lighting, environment.
2. **Step 2 — Video (Flow stitch):** Generate MP4 using Flow stitch with Step 1 still as **both start and end frame**. Provide only a motion prompt. Character and environment are pinned by the still — ensures visual continuity day-over-day.
3. **Save both:** `"image"` = JPG filename (still), `"video"` = MP4 filename (video loop).

**Why:** Stitch mode with identical start/end frames = seamless loop + locked character appearance without re-specifying appearance in every video prompt.

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
- `video` (optional): MP4 filename. When present, component renders `<video autoPlay muted loop playsInline>` instead of image. Image becomes poster frame.
- `title` + `image` both required — if either absent, falls back to static hero card.

**iOS Safari**: `playsInline` is required for inline autoplay; without it iOS forces fullscreen. `muted` is required for autoplay without user gesture.

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

The vignette generator uses the live `estate_insights` primary row as narrative context at generation time. If a broken-pattern insight is live during the daily generation window (~02:00 UTC), its copy will appear in the vignette `title` and `beat`. Path A critic gate (PR #135) prevents new broken rows from landing; run Path B cleanup to dismiss any pre-Path-A legacy rows.
