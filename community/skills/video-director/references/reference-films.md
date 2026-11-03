# Studying reference films

Use this file only when the user chose to draw inspiration from reference videos. When they chose to build from scratch, skip it; the type files and the house rules already carry what earlier films taught.

## Choosing the three

If the user named a film, it is one of the three. If they named a style, find at least one strong film in that style (`animation-styles.md` lists examples for each); the rest are of this type, from the type file's list. The user agreed to downloads in the brief; ask again only for a film they haven't seen named.

A film chosen for its style is studied for its look only (texture, color, drawing, framing). Don't measure its shot lengths, text positions or close as numbers for this film, and never use it as the comparison film unless it is of this type; those come from the films of this type. For a style whose only example is a Showcase moment, ask the user for a clip in that style or study the moment for its look.

Strong films of every type show something happening and carry something across every change. The easiest examples to find are usually the generic ones (feature tours with cards, stock montages); look past them. Each type file (`types/<type>.md`) names films worth studying and what to look for.

## Access before study

Use accessible films or files the user is authorized to supply. If a starting link fails, try another suitable film; record only what was inspected. If fewer than three can be inspected, report the missing input and pause before drawing; ask for accessible files or a specific user-approved reduction in reference coverage. Record that decision in `references/notes.md`. A title, transcript or thumbnail cannot prove motion. Later blind comparison requires an accessible reference file; if unavailable, report the comparison as pending and request the file or an explicit waiver. Never fabricate viewing or comparison scores.

## How to study one

1. Get the film (`yt-dlp -f "bv*[height<=480]+ba/b[height<=480]" <url>`, or the user's file) into the project's `references/` folder.
2. Make contact sheets and find the cuts:

```bash
ffmpeg -v error -i film.mp4 -vf "fps=1,scale=320:-1,tile=6x5" references/<film>/sheet-%02d.png
ffmpeg -i film.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep pts_time
ffmpeg -v error -ss 12.0 -t 1.0 -i film.mp4 -vf fps=10 references/<film>/cut-12-%02d.png
```

3. For each technique, write down the mechanism, not the look: what carries across the cut, where text sits (as a percentage of frame height), how big it is, how the camera moves, how activity is shown, how people appear, how the close is built.
4. Measure: length, number of cuts, shot lengths (median and range), share of still seconds, how long numbers or lines hold, how long the close runs. Measure rather than imitate.
5. Keep notes in `references/notes.md` with timestamps, and cite the film and timestamp when a technique goes into the storyboard's techniques table.
6. Delete the video files afterwards and keep the contact sheets, except the one strongest film of the type: keep its file in `references/` until the film is final (stages 8 and 9 compare against it). In `references/notes.md`, write which film that is and why, in one line.

Borrow mechanisms. Never copy a film's layout, logo, footage or brand look, and don't name a direction after another company ("Apple-style"). Don't build a gallery of other companies' films into a project's deliverables.

## Techniques that worked across types

| Technique | Mechanism | Types |
|---|---|---|
| One persistent actor | A photo, cursor, character, badge or shape keeps its identity across shots; unrelated reveals in a row feel like a slideshow | all |
| Foreground becomes the transition | A shape or part of the picture scales through the camera while the next scene is already behind it | launch, explainer, opener |
| Words carried across a cut | A line stays still while the picture changes under it; the words are what survives | brand, social |
| A system on every clip | A typed line, a name bar, a badge or a chapter color rides every clip, so many clips read as one film | recap, year in review, social |
| One repeated unit | Fixed crop, type position and transition; only the content changes | brand, social |
| Slow, then fast, then the longest hold | Shots shorten through the last quarter, then release into a hold for the claim | brand, recap |
| The form before the number | A chart or object builds, then the number lands, then holds still | data, explainer |
| The idea's shape as the picture | Draw the shape of the idea (a ring with a hole), not an icon | explainer |
| Whole, then close, then whole | Show the full object, move in for the detail, move back out | demo, launch |
| A cursor or hand causes every change | Each change is approached, pressed and answered, so it reads as done by someone | launch, demo, explainer |
| Close on the opening ground | The last card reuses the first card's ground or the first person returns | launch, brand, recap |

## Default versus better (any type)

| The default | The better decision |
|---|---|
| A new layout for each point, the same blur between them | One space or one repeated unit; something carries into each next shot |
| Everything on screen in the first second, then a frozen picture | Pieces arrive one after another, then the result holds still |
| A logo on a glow at the start | The logo once, at the end, on the film's own surface, or formed by the film |
| Stock opening (boardroom, hands on laptop, city time-lapse) | A specific person or thing doing something specific |
| A number in a card | A number that is felt: built from a form, compared to a plain object, or pinned to people |
| Narration repeated as on-screen text | The voice carries the claim; the picture carries the thing |
| Even pacing throughout | A rhythm with a turn: fast and slow next to each other, one quiet moment |
