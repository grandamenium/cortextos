# Storyboard and options JSON

`scripts/build_storyboard.py` turns one JSON file plus a folder of rendered frames into a self-contained HTML page. Frames are embedded, so the page works when emailed or moved.

## Storyboard

```json
{
  "kind": "storyboard",
  "type": "product-launch",
  "narrated": false,
  "title": "Acme launch film",
  "version": "v0.3",
  "date": "2026-10-28",
  "format": "16:9, 1920×1080",
  "length": "about 55 seconds",
  "frames_dir": "frames-v0.3",
  "style": {"changes": "one kind: hard cut on action", "dissolves": false, "exits": "leave with the camera or on the cut",
            "emphasis": "italic of the same face", "arrival": "lines whole, cut on; typed text letter by letter"},
  "summary": "What is new in this version, in one or two sentences.",
  "scenes": [
    {
      "id": "01", "name": "Cold open", "start": 0, "end": 6, "kind": "Warm",
      "lines": ["There's always another call", "And never enough hours in the day"],
      "frames": [{"id": "01a", "label": "Start"}, {"id": "01b", "label": "End"}],
      "change": "What visibly changes on screen, in plain words.",
      "motion": [
        {"from": "01a", "to": "01b", "move": "Pile-up", "timing": "first chip at 0.3s; from 3.0s one every 0.25s",
         "easing": "fast start, soft landing (expo.out), 0.45s each", "carries": "the hero photo, with a 4% push-in"}
      ],
      "sound": "Music builds as the pile grows; no arrival effects.",
      "to_next": {"move": "Carry: the hero photo becomes the first mosaic tile", "camera": "locked frame; hard color cut on motion",
                  "carries": "the hero photo", "timing": "0.9s across the cut", "easing": "power3.in into the cut, power3.out after"}
    }
  ],
  "rules": [["Rule name", "The film-wide motion rule in one or two sentences."]],
  "people": [["Hero photos come alive", "Which photos become living portraits and how small the motion is."]],
  "techniques": [{"name": "Foreground becomes the transition", "where": "01→02", "what": "...", "source": "Reference film", "url": "https://..."}],
  "questions": ["Open questions for the user, one per line."]
}
```

- `type` names the video type (`product-launch`, `explainer`, `brand-film`, `demo-tutorial`, `social-short`, `event-recap-data`, `showcase`); it is shown on the page. `narrated: true` makes the reading-time notes use spoken length (about 2.5 words per second, plus a short beat) instead of the reading formula; set it per scene to override the film-wide value (for example, a narrated explainer's unspoken labels and evidence cards).
- `frames` can be plain ids (`["03a", "03b"]`); labels then default to Start / Middle / End.
- `motion` is a list with one entry per pair of neighboring frames. A plain string is only for a one-frame scene.
- `to_next` is required on every scene but the last. `camera` names the camera move under the change; no two scene changes share one. Add `"motif": true` to exempt a deliberate repeat.
- Image files are `<frames_dir>/<id>.png`.

## Options page

```json
{
  "kind": "options",
  "title": "Acme launch film",
  "version": "v0.1",
  "decision": "Color treatment",
  "frames_dir": "options-color-v0.1",
  "summary": "Same frames in three treatments. Switch at the top.",
  "variants": {"label": "Color", "items": [{"key": "warm", "name": "Warm"}, {"key": "cool", "name": "Cool"}]},
  "options": [
    {"key": "A", "name": "Person in a color field", "from": "Technique from a reference film",
     "summary": "One or two sentences.", "frames": [{"id": "01a", "label": "Start of 01"}], "recommended": true}
  ],
  "questions": []
}
```

A direction option also carries `"plan"`: an object of labeled rows shown as a table under its summary, for example `{"The idea": "...", "Product at the turn": "...", "Media": "...", "Drawing style": "...", "Recurring element": "...", "Moving between ideas": "...", "End line": "..."}` (`visual-ideas.md`, section 1).

With `variants`, image files are `<frames_dir>/<id>@<variant>.png` (what `render_frames.py --variant` writes). Without it, `<id>.png`. Start a direction round from `assets/options-direction-starter.json` (no variants) and a color round from `assets/options-color-starter.json`.

## Checks the builder runs

- Refuses to overwrite an existing page.
- `style` records the film's per-film style choices (the "Style choices made per film" in SKILL.md). Each value is plain words, except `dissolves`: `true` when the style allows dissolves or blur between scenes, which suppresses lexical fade/blur candidates; the value does not authorize unrelated house-rule exceptions.
- Checks required motion fields and repeated camera values; `--strict` turns exact motion-schema violations into failures from stage 7. Fade/blur words surface review candidates unless `style.dissolves` is true. Inspect the full sentence, type exceptions and approved style before deciding whether a move violates the rules. Record a reasoned disposition using `--reviews <project-review.json>` (a list of `{ "id": "<printed-id>", "sha256": "<printed-current-sha256>", "reason": "<actual judgment>" }` entries); a word match alone is not a design verdict. Options pages require exactly 2–3 alternatives.
- Prints NOTE lines when a scene looks too short for its lines (1.0 s + 0.045 s per character each). These are estimates and never fail the build.
- Fails on a missing frame image or a scene missing `id`, `name`, `start`, `end` or `frames`.

These only check that the fields are filled. Whether a move is right is for you and the user to judge.

## The notes round trip

1. The user reviews the page: a notes box under each scene and each scene change, numbered pins on frames (Add pin, then click the spot), and overall notes. Notes save in their browser.
2. They click **Copy all notes** (Markdown, ready to paste into chat) or **Download notes** (a JSON file).
3. Answer every note in a numbered list before redrawing.
4. Build the next version with the downloaded file so last round's notes show beside each scene:

```bash
python3 <skill>/scripts/build_storyboard.py storyboard/storyboard-v0.4.json storyboard/storyboard-v0.4.html --previous-notes ~/Downloads/notes-acme-launch-film-v0.3.json
```

Notes are keyed by scene id (`s:03`), scene change (`t:03>04`) and option (`o:A`), so keep scene ids stable between versions.
