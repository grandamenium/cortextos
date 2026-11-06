# Build and checks

## Contents

- Building in HyperFrames
- The render check (required)
- Other checks before sending any render
- Watching in motion
- Action moments inside a shot
- Continuity sheets (generated clips)
- Sound balance
- The fresh read (required)
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
- **Generated clips**: faces keep identity, hands don't warp, framing doesn't drift, and nothing moves by itself (a door swinging open with no hand on it). Props and clothes across shots are checked on the continuity sheets below, not by eye in passing.
- **End card** against the type's close numbers (`types/<type>.md`).
- **Sound**: music or a bed carries the film, quiet only on purpose; any effect lands on the frame of the real thing it belongs to; nothing on text; each effect and voice measured against the music (Sound balance, below); loudness about -14 LUFS, true peak -1 dBTP or lower (`sound-and-voice.md`, Mix).
- **Motion rules**: holds are still (no drift or floating); nothing animates out before a scene change unless the film's style allows it; no bounce on text/interface moves; deliberate drawn-character acting allowed; no camera move repeated under two scene changes.
- **Safe area**: nothing outside the format's safe box (`text-and-captions.md`), except what the type allows (a name bar, product UI, a legal line).
- **The close** against the type's numbers (`types/<type>.md`).
- **Muted watch**: with the sound off, a first-time viewer can say what this is and what to do next (narration-led explainers excepted).

- **Phone copy**: every render the user sees has a phone copy under 30 MB (`polish-rounds.md`, section 3), from the animated test on, not only in polish rounds.
- **Captions**: burned in or shipped as separate files according to where the film is posted (`text-and-captions.md`, Captions); a film posted to both kinds of place gets both versions.

Then get the fresh read (section below).

## Watching in motion

Still frames miss what only shows in motion: a transition that jars, a person who jumps from one place to another between shots, a pointer that lands in the wrong spot and reads as two, a stretch that drags. The cut strips run on every render the user sees, from the animated test on; the motion watch runs when allowed. Neither looks at the middle of a shot closely, so the action strips, continuity sheets and sound balance below run too.

**Frames at every cut** (always). `scripts/cut_frames.py` finds the cuts (or takes `--times` from the motion spec) and writes one strip per cut: 0.2 s and 0.07 s before, 0.07 s and 0.2 s after. Open every strip and look for a jump in where a person or object is, a pop, a doubled element or a flash.

```bash
python3 <skill>/scripts/cut_frames.py output/cut-v3.mp4 --out output/cuts-v3
```

**The motion watch** (on by default when a key is set up and the user allowed uploads in the brief). `scripts/watch_cut.py` uploads the cut to the Gemini API and asks `gemini-3.6-flash` to describe each shot and what moves in it, then list problems with times, including still photos or screenshots standing in for an action. A separate step of its prompt asks only about physical sense: objects moving with nothing moving them, props that become a different prop or change state between shots, clothes or hair that change, things appearing or vanishing inside a shot. It requests 10 frames a second; the API may use its 1 fps default instead (see below). Pass `--upload-allowed` only when the brief allows uploads: without it, nothing leaves the machine. Pass `--notes direction-notes.md` so deliberate holds and pacing aren't reported as faults; the prompt tells the model that continuity, props, clothes and physical sense are checked whatever the notes say.

```bash
python3 <skill>/scripts/watch_cut.py output/cut-v3.mp4 --out output/watch-v3 --upload-allowed --notes direction-notes.md
```

- **Read its shot list too** (`watch.md`): a shot it calls a still picture is a finding even if it didn't list it.
- **Every finding is a candidate.** Pull frames at its time (8-10 fps, 1 s either side) and confirm it before changing anything; say which ones you confirmed and which you dismissed, and why.
- **Check the frame rate it reports.** The script compares the token count with what each frame rate would cost and reports 10, 1 or unknown. At 1 or unknown, fast cuts and short pops may have been missed: lean on the cut strips and say so.
- **Quota errors**: Gemini quotas can run out mid-session. When `gemini-3.6-flash` returns 429 after its retries, another model on the same key often still works (`--model gemini-3-flash-preview` handled video and audio on one project). Say which model watched, or that the watch couldn't run; never skip it silently.
- **Key**: `GEMINI_API_KEY` in the environment, or a `GEMINI_API_KEY=` line in a file passed with `--env-file`. The user makes the key in Google AI Studio.
- **Upload permission**: the cut leaves the machine. Google keeps uploads up to 48 hours; the script deletes its upload whatever happens and records whether that worked (`upload_deleted`). On Google's free tier, content may be used to improve Google's products; on a paid tier it is not. For client work, ask in the brief whether this is allowed.
- **Model**: `gemini-3.6-flash` by default. In calibration on renders with known problems it caught three still photos standing in for a person's actions and a jumping cursor, and reported nothing in a clean cut; `gemini-3.5-flash-lite` caught one of the three stills, so don't use it to save money. `--model gemini-3.8-flash` is newer at the same price but untested here. Busy-model errors are retried three times.
- **Cost**: $0.75 per million input tokens and $3.75 per million output tokens for 3.6 Flash until 31 December 2026, then double (Google's pricing page, November 2026). At 10 fps a minute of video is about 43,000 tokens, roughly 3-4 cents a watch (6-8 cents from 2027); free-tier use costs nothing.
- **No key, no permission, or an error**: the script exits 3 (or 1) and writes `status: not_watched` with the reason. Say "not watched in motion" and why in the report; never imply the cut was checked in motion.
- **It is extra coverage, not a hold.** A render without the watch can go to the user with that line in the report. The render check, cut strips and the fresh read are required, and so are action strips, continuity sheets and sound balance for the films that need them (see each section).
- **A clean watch is never proof.** The model sees each frame at low resolution (about 70 tokens a frame), so it can't see small UI mistakes: a pointer stopping 70 px below the item it should click, in a 1080p frame, is invisible to it. On one film's v3 the default watch found none of the eight problems the user then found by eye (a calibrated director's checklist found three). Report what it found and what it can't see; never "the watch found nothing, so the cut is clean".

## Action moments inside a shot

Cut strips show the frames around cuts. The moment a click, a press, a hand on a knob or a pointer landing happens is usually in the middle of a shot, and nothing else looks at it closely. On one film the pointer on a join screen stopped 45 px below the camera menu and 70 px below the camera item it was meant to click; the cut strips, the render check and the motion watch all passed it, and the user found it by eye.

From the motion spec, list every action moment in `build/actions.json`. A film with no click, press or touch inside a shot (most films with no pointer and no hand on a control) writes `[]`; the script then records that there were none and passes. Pass `--motion-spec motion-spec.md` as well: with an empty list it flags any line of the spec that mentions a click, tap, press, touch or pointer. Otherwise give each moment: time, a label saying what should happen, and either a target box in video pixels or, in a HyperFrames UI scene, the composition, the pointer's selector and the target's selector:

```json
[{"time": 36.94, "label": "picks the app's camera in the camera menu", "composition": "compositions/join.html", "pointer": "#ptr", "target": "#opt"},
 {"time": 2.1, "label": "her hand turns the door knob", "box": [610, 380, 160, 160]}]
```

```bash
python3 <skill>/scripts/action_frames.py --actions build/actions.json --motion-spec motion-spec.md --build build/ --video output/cut-v3.mp4 --out output/actions-v3
```

- Each action gets a strip: the whole frame, then zoomed crops at -0.2 s, -0.07 s, the action and +0.07 s, with the target boxed in red and the pointer's tip marked in yellow.
- **The pointer check** loads the composition in headless Chrome, seeks it to the click (film time minus the clip's `data-start`, or `local_time`) and reads the pointer's and the target's boxes from the page. It fails when the tip is outside the target, or the pointer or target isn't visible (a menu item clicked before the menu opens). The tip is 3 px in from the pointer element's top-left by default; set `tip` when the pointer's SVG draws its point elsewhere. Sub-compositions are assumed to fill the frame.
- A failed pointer check (exit 2) is an exact failure: fix the move's end point, render again. Exit 1 is the script failing, not the pointer. A composition loaded twice in the film needs `local_time` on each action.
- For footage, look at each strip for the hand actually touching what it acts on (a door opened by its knob, not swinging by itself) and for anything appearing or vanishing.

## Continuity sheets (generated clips)

Required for films with generated clips of recurring people, places or props: separate generations drift. A film cut from real supplied footage (a recap, a shoot) or with no recurring person, place or prop needs none; say so in the report.

Generated clips change props and clothes between shots, and the change is often several shots apart, so neither the cut strips nor a quick watch shows it. On one film the water bottle was a different bottle in three shots, the front door was open in later shots after she had shut it, and her top changed between a sports bra and a crop top. Each was found by the user.

At stage 6, list in `build/continuity.json` every recurring prop and garment named in the brief, script or storyboard (and any door, window or screen whose state matters), with one moment from every shot it appears in and, where it helps, a box around it:

```json
{"items": [{"name": "water bottle", "note": "big bottle with a straw",
            "shots": [{"time": 3.1, "label": "hallway", "box": [820, 400, 260, 420]}, {"time": 12.4, "label": "desk", "box": [1300, 520, 200, 330]}]}]}
```

```bash
python3 <skill>/scripts/continuity_sheet.py output/cut-v3.mp4 --items build/continuity.json --out output/continuity-v3
python3 <skill>/scripts/continuity_sheet.py --verify output/continuity-v3
```

Open every sheet and write one line per item in `output/continuity-v3/continuity.json`: `same:` (what you compared), `changed:` (where; fix it before the user sees the render) or `accepted:` (the user said it's fine; quote them with the date). `--verify` fails on an empty or `changed:` verdict. Update the items list whenever a shot is added or remade. Before generating a clip, check its start still against the same items, since the clip inherits them. At the animated test, list only items seen in two or more of its shots; the rest wait for the full build. A verdict carries over to a new run only when the video file is unchanged; a re-render needs new verdicts.

## Sound balance

Claude can't hear the mix. A film's overall loudness says nothing about whether one effect is buried or jumps out, and those were the user's notes on one film round after round: a shirt rustle far too loud, a calendar ding inaudible at 4-5 dB under the music. Keep the mix as stems (music, effects, voice), each exported from 0:00 to the end at the level it has in the mix (after every gain, dip and compressor, before the final loudness step). The simplest way is to build the mix in one ffmpeg graph and write each stem from the same graph just before the mix step:

```bash
ffmpeg -i music.wav -i fx.wav -i voice.wav -filter_complex "[0]<gains and dips>,asplit[m][mo];[1]<gains>,asplit[e][eo];[2]<gains>,asplit[v][vo];[m][e][v]amix=inputs=3:normalize=0[mix]" \
  -map "[mix]" build/audio/mix.wav -map "[mo]" build/audio/music.wav -map "[eo]" build/audio/effects.wav -map "[vo]" build/audio/voice.wav
```

List the sounds that matter in `build/audio/events.json` as `must-hear` (a ding, a click on the press that matters, a door bang) or `texture` (a rustle, steps, a room):

```bash
python3 <skill>/scripts/sound_balance.py --music build/audio/music.wav --effects build/audio/effects.wav --voice build/audio/voice.wav --events build/audio/events.json --out output/sound-v3
```

It measures every stem's momentary loudness (EBU R128, 0.4 s window) and flags effects sticking out above the music, must-hear events under it, texture sounds above it and voices too close to it. Give `--effects`, `--voice` or both. Its thresholds are starting values, not tested against listeners, and its 0.4 s window reads clicks and pops (under about 0.3 s) far lower than they sound: approved trackpad clicks measured 8-32 dB under the music, so report those numbers and ask, don't raise the sound; a must-hear sound the user already approved can sit higher (one approved ding measured about +13 dB): report it, don't lower it. Exit 2 means flagged: change the mix or tell the user the numbers and ask. Report every labeled event's difference against the music with the render, so the user knows what to listen for. A clean report doesn't mean the mix sounds right; the user's ears decide. How to make the sounds, and where `effects.wav` and `events.json` come from: `sound-stage.md`, Sound engineering.

## The fresh read (required)

Before any render goes to the user, give a new agent only the render (or its contact sheets), the script, the design rules from SKILL.md, and the action strips and continuity sheets, and ask for the three worst problems with timestamps. It has not seen the build, so it doesn't excuse what you meant to do. Fix those, and repeat until what comes back is minor. If you skip it (no agent available, a timing-only fix), write that and why in the build log line for that render and say so to the user.

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
