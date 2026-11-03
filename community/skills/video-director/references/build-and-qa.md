# Build and checks

## Contents

- Building in HyperFrames
- The render check (required)
- Other checks before sending any render
- Blind comparison with a reference
- Check against the type's numbers (films built from scratch)
- Retiming
- When the user still sees choppiness
- Cutdowns and other formats

## Building in HyperFrames

1. Read the HyperFrames tool's docs before writing composition HTML: `npx hyperframes docs compositions`, `docs data-attributes`, `docs gsap`, `docs rendering`. Run `npx hyperframes doctor` once to check Chrome and ffmpeg. Verify the required CLI, Chrome, ffmpeg, Playwright and numpy are available before the animated test. If docs or tools are inaccessible, report exactly which dependency is missing and pause the build for repair; do not install or substitute silently. Earlier approved stills remain reviewable.
2. Set up the project in `build/`. Keep one sub-composition per scene, or per group of scenes that share one continuous camera.
3. Start each scene from its storyboard frames: the frame HTML already has the layout, sizes, depth and type. Move the layout into the composition, then add the timeline from the motion spec (move, timing, easing for every row).
4. Living portraits and b-roll clips go in as video layers; let the framework own their playback. Generated clips that join a designed scene use the match frame from the spec.
5. Lines of text come from the script file so wording can change without rebuilding by hand. Every element that holds words gets a `data-text-role`.
6. Run `npx hyperframes check` after each scene, `npx hyperframes snapshot` to see key frames, and `npx hyperframes preview` before rendering.

**Animated test (stage 8).** Build only the 2-4 hardest scenes, usually the opening, the first color or chapter change, and one scene from the middle, with their scene changes. A type file can replace this (live-action story ads test a run from the start). Before rendering, list which scenes the test covers and every shot that is still a placeholder, and put that list first when you send it. In a film with people shown as footage, a person's action is never a still with a push: make the clip first, or leave the shot out or mark it as a placeholder on screen. In a live-action story ad, the product's screen is a screen recording of the real app (not screenshots moved around) unless a rebuilt interface was approved at stage 5. Render, check it as below, and ask the user to watch for pacing and for anything that still feels like slides. Fix the spec before building the rest.

## The render check (required)

Run `python3 <skill>/scripts/check_render.py build/ --motion --video <render> --out <folder>` on every render before it goes to the user, and open every motion strip and every close-up in `motion-findings/` it writes. Exact structural errors require correction. Motion, reading-window and blankness heuristics surface candidates for visual review; a candidate alone does not prove a defect. Review the strip, narration/beat and approved style, then fix the observed defect or record a disposition with a concrete reason in `build/render-check-exceptions.json` (`[{"check": "long", "match": "#endLine", "sha256": "<printed-current-sha256>", "reason": "held under the music tail"}]`). `match` must equal the finding's selector or role exactly (add `"text": true` to match the line's text instead), and an entry without a reason accepts nothing. For a composition built before roles were set, `--role '.cap2=line'` assigns roles by selector.

Do not call the render checked while required sampling, dependencies or video measurements are unavailable. A zero-candidate run still needs the visual checks below. Review speech captions against the spoken timing, and word arrivals against the chosen voice/beat cadence in `text-treatments.md`; the default silent-reading formula cannot settle those cases.

Exit codes distinguish stages: `0` means completed checks with contextual candidates dispositioned; `1` means exact failure or missing required coverage; `2` means review is still required. The render checker uses `render-check-exceptions.json` as above. The storyboard builder and frame renderer accept `--reviews <project-review.json>`, a JSON list such as `[{"id":"blank:01a","sha256":"<printed-current-sha256>","reason":"Inspected the frame; intentional untextured hold approved in the brief"}]`. Copy the printed candidate ID and current SHA256 exactly and record the actual visual judgment; changed content requires a new review. Example IDs are `motion:01:0:fade`, `transition:01:fade` and `blank:01a`. Reasons never substitute for missing measurements, exact required fields or required text size/role corrections. Review-page output may exist while review remains pending; it is not approval to animate.

What each motion candidate may indicate and the usual fix after visual confirmation:

| Finding | What the viewer sees | Usual fix |
|---|---|---|
| pop | something jumps instead of moving, or a stroke appears at once | animate a property that actually tweens (for a drawn line, animate a dash length the browser interpolates); check the ease |
| stall | a line of words stops between words | start the words closer together; one smooth reveal per line |
| stepping | a slow drift visibly steps pixel by pixel | move faster or don't drift; holds are still |
| abrupt | a visible element blinks on or off | fade or move it, or hide it behind something before it switches |
| edge-on | a card turns flat to the camera mid-move | keep 3D turns small; never pass 90 degrees while visible |
| flash | two white cards half-faded over each other read as a white flash | let one finish before the other starts, or move instead of fading |
| typing | typed text takes more than about 2 s to finish | type less, or show the long text whole; the two exceptions in `text-and-captions.md` go in the exceptions file |
| flicker | a region changes and changes back on the next frame | look for a crop, clip or mask that was animated partway and then switched off by a later one-off set: render workers that start mid-film can keep it applied. Animate it to its fully open value instead of switching it off; render again |

When the render shows almost no change in that spot, the finding stays open marked "probably hidden". Open its strip: if the element really is hidden, record it as an exception with that reason; if it shows, fix it.

The check also prints a NOTE when the film's lines use more than one capitalization pattern (sentence case, title case, all caps). It doesn't block, because proper nouns need judgment; read the listed lines and make them follow one rule.

## Other checks before sending any render

Pull frames:

```bash
ffmpeg -v error -i output/cut.mp4 -vf fps=1 output/check/s-%03d.png
ffmpeg -v error -ss <t> -t 1 -i output/cut.mp4 -vf fps=10 output/check/move-<t>-%02d.png
```

Make a contact sheet and read it, then check:

- **Overlaps on every frame of every transition**, not only settled frames. Text over text mid-crossfade is the most common miss.
- **Brightness between media**: where footage cuts to UI or a designed ground, compare the frames either side. A large jump (white UI against a warm room) gets a shared ground or a fade through black (`visual-ideas.md`, section 2).
- **Covers are solid**: anything that closes over another element during a move is fully opaque for the whole move, or what is underneath shows through as a white flash.
- **Measured layout**: check spacing with numbers from the composition, not by eye. Items placed around a center sit at the same distance from it; a connecting line touches both of its ends; items in a row share one gap.
- **Lists**: the same-kind rule in SKILL.md (Layout and look).
- **Capitalization**: one rule on every on-screen line.
- **Frozen time**: no stretch over about 0.6 s where nothing moves, except a scene's final hold (at least 1.0 s, still on purpose) or a deliberate stop.
- **Frame 0** is a finished composition, not a blank or half-built frame.
- **Readability**: every line readable at phone width; UI text large enough to read in the time it's on screen.
- **Lines** stay in their home position and inside the title-safe area.
- **Generated clips**: faces keep identity, hands don't warp, props don't change, framing doesn't drift.
- **End card** against the type's close numbers (`types/<type>.md`).
- **Sound**: music or a bed carries the film, quiet only on purpose; any effect lands on the frame of the real thing it belongs to; nothing on text; loudness about -14 LUFS, true peak -1 dBTP or lower (`sound-and-voice.md`, Mix).
- **Motion rules**: holds are still (no drift or floating); nothing animates out before a scene change unless the film's style allows it; no bounce on text/interface moves; deliberate drawn-character acting allowed; no camera move repeated under two scene changes.
- **Safe area**: nothing outside the format's safe box (`text-and-captions.md`), except what the type allows (a name bar, product UI, a legal line).
- **The close** against the type's numbers (`types/<type>.md`).
- **Muted watch**: with the sound off, a first-time viewer can say what this is and what to do next (narration-led explainers excepted).

Then get a fresh read: give a new agent only the render (or its contact sheets), the script and the design rules from SKILL.md, and ask for the three worst problems with timestamps. Fix those, and repeat until what comes back is minor.

## Blind comparison with a reference

A fresh read finds faults; it doesn't say whether the film is as good as the films it is meant to compete with. At the animated test and again at the full build, compare it with the strongest reference film of the same type from stage 3:

The reference is the film named in `references/notes.md` at stage 3; its file is kept in `references/` for this.

1. In a new folder, save the two films as `A.mp4` and `B.mp4`, choosing at random which is ours. Make them match: the same size and frame rate (`ffmpeg -v error -i in.mp4 -map_metadata -1 -vf scale=-2:480,fps=25 -c:a aac A.mp4`), and cut the end card and logo off both. For the animated test, cut the reference to a similar length.
2. Make the same evidence for both: 1 fps contact sheets, 8 fps strips at each scene change, the loudness measure, and a list of where the music, voice and silence fall (`ffmpeg -i A.mp4 -af silencedetect=n=-40dB:d=0.4 -f null -`).
3. Give a new agent only the two sets of evidence and the brief's viewer line. Don't say which film is ours. Ask it to fill in this table for each film, with timestamps for each reason, and to score sound only from that evidence; write 'can't tell' rather than guess.

   | | A | B | Reasons, with timestamps |
   |---|---|---|---|
   | Clear what this is and what it does (1-10) | | | |
   | Believable (1-10) | | | |
   | Readable at phone size (1-10) | | | |
   | Motion (1-10) | | | |
   | Sound (1-10, or can't tell) | | | |
   | Would rather watch | | | |

4. Write the scores and every place the reference wins to `references/blind-compare-<version>.md`, and tell the user. Those places become candidate notes for the next round; the user decides which to act on.

## Check against the type's numbers (films built from scratch)

With no reference film, compare the film with the type instead. At the animated test and again at the full build, make the same evidence as the blind comparison (1 fps contact sheets, 8 fps strips at each scene change, the loudness measure, the silence list) plus the cut times (`ffmpeg -i film.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep pts_time`). Give a new agent that evidence, the brief's viewer line, the "Numbers that change by type" table from SKILL.md and the type file. Ask it to measure the film against each number (where lines sit, what is kept clear, scene length, cuts, close) and to score the same five rows as the blind comparison, with timestamps for each reason; score sound only from the evidence and write 'can't tell' rather than guess. This check holds the film to the skill's own numbers, not to a stronger film, so it is weaker than the blind comparison; say so. Write the result to `references/type-check-<version>.md` and tell the user that no reference film was used. Places that miss a number become candidate notes; the user decides which to act on.

## Retiming

Changing scene lengths after the build breaks things that were placed by hand (clip windows, sound hits, cues lined up with a move). Keep it in one place:

- Write positions in a design timeline (the times in the motion spec) and map them to final time through one time map: a list of `[design time, final time]` points with straight lines between them.
- To retime, change the map, not the individual tweens. A clip window or sound hit placed in the old final time is moved by mapping it back to design time through the old map, then forward through the new one.
- Keep anything that must play at real speed outside the map: typing, a pile-up, a cursor's travel, sound effects' own lengths. Place its start through the map and time the rest in real seconds.
- After retiming, run the render check again; line windows are the usual casualty.

## When the user still sees choppiness

The render check can pass while the user still sees something wrong. The steps for that case are in `polish-rounds.md` (section 5).

## Cutdowns and other formats

- Build the long cut from units (hook, situation, beats, payoff, tag) so shorter cuts can be made by dropping beats from the end, never the hook or the payoff (`types/social-short.md`).
- A different aspect ratio is a rebuild of each scene in the new frame, not a crop or letterbox: one subject, the line in the format's home position, the hero below it.
- Check every cutdown against its own format's safe box and reading times; shorten words rather than shrinking type.
