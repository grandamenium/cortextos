# Text on screen

## The text systems

Every word on screen belongs to one of these. Each has its own job, home position and rules. Never stack three at once (for example dense UI, a caption and an overlay line); cut or delay one.

| System | Job | Rules |
|---|---|---|
| On-screen lines | The film's own words: hook, claim, the sentence the script says | One home position per film (the type table in SKILL.md). Plain sentences |
| Labels | Name a thing in the picture | 1-3 words, beside the thing (with a leader line) or in one fixed corner tag. About 4% of frame height. Never a sentence |
| Captions | Reproduce narration faithfully, for access and muted viewing | One caption zone per format, at most two lines, mixed case, medium-weight sans; a compact backing only when contrast fails. Never also print the narration as on-screen lines |
| Product text | The product's own UI words | Never rewritten. Readable only where the viewer must read it (4-5% of frame height or more) |
| Legal text | Required disclaimers | Small, one fixed place, may sit low in the frame |
| Names | Identify a real person | Once per person, 2-3 s; lower-left in recaps, or in the same style as other type in brand films |

## Writing lines

- Plain, complete sentences a person would say aloud.
- Banned: stacked fragments ("Four villains. One draft. Exact lines."), triplets of short parallel lines, "Meet X", "Introducing", "Not just X, it's Y", gradient text, accent words in a second typeface or a random color, a typed headline with a caret.
- Nothing printed inside the picture should read like narration. A sentence inside the frame gets read as script; a name tied to an object (a label) does not.
- In body lines, an emphasis word keeps the size of its line; a title or one deliberate giant word may differ. Pick one marking for the film: brightness or a tint that settles to the line colour, italic of the same face, a colour matched to what the word labels, the house colour, or a drawn mark. No random accent colors.
- One size per text role for the whole film. Mark every element that holds words with `data-text-role` so `scripts/check_render.py` can check it.

## Reading time

How long text stays fully visible after it lands (entrance and exit don't count):

| Text | Time |
|---|---|
| A line the viewer must read, not spoken | 1.0 s + 0.045 s per character (0.6 s base for one to three words). A 40-character line needs about 2.8 s |
| Words that are spoken as they appear | about as long as they are spoken |
| A short claim card that the next shot proves | about 1-2.5 s |
| Typed-on text (a prompt being typed) | the typing time, then the full text held briefly; the meaning also carried by the result or the voice |
| A tooltip or label | about 0.8-1.6 s |
| A title or chapter card | long enough to read (2-6 s in the films studied) |
| A line held across several short beats (shorts, brand films) | check the total time on screen, not time per beat |
| Upper limit | a line shouldn't stay much longer than it needs; the render check flags anything over 2.5x its reading time and over 3 s more than it needs (8.5 s on one sentence is far too slow) |

If a beat has too much text, cut words or split the beat; never speed up the reveal.

## Size and position

- Minimum font size as a share of frame height: lines, openings, cards and claims 3%; captions, labels, names and typed text 2% (real films set these at 1.5-2.5%); everything except legal and UI text 3% in a vertical film. A hook line in a short about 4-5%; UI the viewer must read 4-5%. The render check flags anything under its role's minimum (`small`).
- Type over a picture needs a quiet area, or a pill, outline or soft shadow.
- Each system keeps one home position for the film. Move it only for a real collision, then keep it moved for that whole line.
- A line never covers eyes, a mouth, an icon, a logo, a connecting line or the thing being taught. (Type on a calm, still face in a brand film is an ask-first exception.)

## Safe areas by format

| Format | Keep text, faces and logos inside |
|---|---|
| 16:9 | 5% from each edge; keep the bottom 17% clear of added text unless the type says otherwise |
| 9:16 | about 15% to 65% of the height (Meta publishes 14% top, 35% bottom); 6% from each side, with extra room on the right for the like and share column (the frame kit uses 12%) |
| 1:1 and 4:5 | 5% from each edge; no platform publishes overlay zones, so check the platform's preview |

The frame kit's layout check uses these: it reads `BRAND.size` and, if set, `BRAND.safe = {top, bottom, left, right}` as fractions.

## Captions

- Decide in the brief whether captions are burned in. When the brief doesn't say: burn them in for social shorts and anything posted to a feed (feeds ignore a caption track inside the file, and those films are watched muted); otherwise ship them as `.srt` and `.vtt` files beside the film, plus a captions track the viewer can switch on inside the `.mp4` (`ffmpeg -i cut.mp4 -i cut.srt -map 0 -map 1 -c copy -c:s mov_text cut-captioned.mp4`). If they are burned in, give them their own zone (usually low-center in 16:9, inside the 9:16 safe box) and keep all other text out of it.
- Captions follow the narration and spoken lines word for word. A bleeped word is captioned "[bleep]" ("Oh, [bleep]!"), never with asterisks.
- On-screen lines carry only what the narration doesn't say.
- Never more than two caption lines; break at phrase boundaries.

## Typed product text

Typed text builds up letter by letter or in 1-3 character chunks, never all at once.

Keep typing short: it finishes within about 2 s. In the films studied, 12 of 56 typed anything, and every one finished in under 2 s. Show long text whole, or in blocks. Two exceptions: the writing itself is the feature (an engraving, an answer streaming in, sped up), or a narrated tutorial where the voice reads the prompt as it is typed.

| Context | Characters per second |
|---|---|
| First, deliberate typing the viewer should read like a person | 4-10, with small pauses between words |
| Repeat typing once the viewer knows the action; a typed label | 10-25 |
| Prompt cropped huge as the hero | 14-25 |
| Prompt at real UI size | 20-60 |

Show a text cursor when the field is the subject. Hold 0.5-1.7 s after the last character before it is sent or cut. A status line ("Thinking…") may replace the prompt before the result.

## Text treatments

The choices seen in strong short films. Pick per film; `references/text-treatments.md` has sizes, timings and when each is used.

For script-language candidates, run `python3 <skill>/scripts/scan_script.py script.md --out output/script-language-review.json`. Inspect each phrase in context, including supplied-script ownership; persist actual judgments with `--reviews <project-review.json>` entries `{ "id": "<printed-id>", "sha256": "<printed-current-sha256>", "reason": "<judgment>" }`. Exit 2 means review pending, 1 is input failure, and 0 means no known candidates or all reviewed; none proves prose quality.
