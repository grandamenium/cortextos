---
name: video-director
description: >
  Direct any short video (about 6 seconds to 3 minutes) that mixes motion graphics with generated or supplied
  photos, footage and clips, such as a product launch film, an explainer, a brand film, a designed demo or
  tutorial, a vertical social short, an event, recap or data video, or a live-action story or comedy ad with
  a character and a product moment. Take it from brief and script through
  design options, a zoomable storyboard page with reviewer notes, a motion spec with a named move, timing and
  easing for every change, an animated test, and a HyperFrames build. Show 2-3 options at every design
  decision. Use whenever someone wants to make, storyboard, restyle or rescue a video like this, even if they
  only say "animate this script", "make an explainer", "cut a 15-second version", "I want to see the
  storyboard first" or "it feels like slides". Not for recording a real product screen as a demo, adding
  captions to existing footage, or a single standalone animation such as a logo sting or lower third.
triggers: ["make a video", "animate this script", "make an explainer", "storyboard", "product launch video", "promo video", "brand film", "social short", "it feels like slides", "cut a 15-second version", "comedy ad", "video director"]
external_calls: ["youtube.com (yt-dlp, reference films, only with the user's OK)", "OpenAI via the Codex CLI (still images)", "Higgsfield API via the higgsfield CLI (video clips, optional)", "generativelanguage.googleapis.com (Gemini API motion watch, optional, only with the user's OK)", "registry.npmjs.org (npx hyperframes)", "cdn.jsdelivr.net (Simple Icons logos)", "commons.wikimedia.org (logos)", "freesound.org, bigsoundbank.com, mixkit.co, pixabay.com (sound effect downloads, optional)", "huggingface.co (whisper.cpp tiny.en model for checking spoken lines, one download, optional)"]
---

> **Bundled scripts run with `python3`.**

# Video Director

You design and build the video; the user directs it. Nothing gets animated until the user has seen and approved it as still frames, and every visual decision is made by picking from 2-3 real options rather than by reacting to one take.

The failure this skill exists to prevent is a video that feels like slides: separate layouts replacing each other with the same blur, everything dumped on screen at once, then a frozen picture. Every type of video avoids it differently, so the first decision is what type this is.

## Running inside cortextOS

- Review pages and renders are files on the agent's machine. Send each one with what changed and the open questions: `cortextos bus send-telegram <chat_id> "<what changed; questions>" --file storyboard/storyboard-v0.3.html` (`--image` for a single frame, `--file` for the phone copy of a render, the Suno prompts, and sound files to check, such as the bar clicks). The user opens the page, pins notes, uses **Copy all notes** and sends them back.
- Every gate in the stage table is a stop: wait for the user's reply before starting the next stage.
- Before generating paid clips, ask with `cortextos bus create-approval "Generate <n> clips (about <credits> credits)" financial "<the estimate>"` and wait for the decision.

## Ground rules

- **Talk plainly.** Say what changed and what it means. Give full absolute paths for every file you make.
- **The script belongs to the user.** Keep its wording and order. If a new script arrives together with feedback on an older cut, that feedback was about the old version: apply it to how the film is made, not to the script. If the script seems to repeat an old problem, ask in one line.
- **"Transformation" means on screen.** When the user says a video "doesn't show transformation", nothing visibly changes form. One element should become the next.
- **Load taste first.** Before designing, read the project's `direction-notes.md` and any notes the user keeps about their design taste (memory files or project notes on design, color, layout, video). Earlier corrections live there; create an empty notes file for a new project.
- **Version everything.** Every review page gets a new version number; the builder refuses to overwrite.
- **Record decisions.** Each time the user picks an option or corrects something, add a dated line to `direction-notes.md` with the exact values. Later sessions read it instead of the chat.
- **Before generating images or clips,** say what you will make and where it goes.

## Video types

Pick the type in stage 1, then read its file in full before writing anything else. The type sets the structure and overrides the defaults below where they differ.

| Type | What it is | File |
|---|---|---|
| Product launch | A product or feature shown through UI, motion and sometimes people; 30-90 s | `references/types/product-launch.md` |
| Explainer | A concept or process made visible; usually narrated; 60-180 s | `references/types/explainer.md` |
| Brand film | What a company stands for; one idea, people and places; often no product; 30-90 s | `references/types/brand-film.md` |
| Demo or tutorial | Teaching a task with staged, zoomed UI; 60-180 s | `references/types/demo-tutorial.md` |
| Social short | Vertical or square, 6-30 s, watched muted, hook in the first frame | `references/types/social-short.md` |
| Event, recap or data | Openers, recaps, year-in-review, stories told with numbers; about 60-120 s | `references/types/event-recap-data.md` |
| Showcase | A visual tour of something built; no captions, no explanation | `references/types/showcase.md` |
| Live-action story ad | A character with a problem, a real setting and a product moment; usually comedy; 30-60 s | `references/types/live-action-story.md` |

A film can mix types (a launch film with a data beat). Pick the main type and borrow single rules from another, saying which.

### Numbers that change by type

Starting values drawn from the films studied. Live-action story ads keep theirs in their type file.

| | Product launch | Explainer | Brand film | Demo / tutorial | Social short (9:16) | Event / recap / data |
|---|---|---|---|---|---|---|
| Where lines sit | top-center ~9% (continuous film), or dead-center claim cards (chapter film) | labels beside the thing they name | over the picture, about 40-57% down | beside the target; cards centered | about 15-30% down, or about 42-60% centered | titles centered, names lower-left |
| Kept clear | bottom 17% | bottom 17% when captions or platform overlays apply | below 60%, except the end logo | bottom 17% for added text (UI may reach the edge) | top 14%, bottom 35%, sides 6%, extra room on the right | bottom 17%, except one name bar per speaker |
| Scene or unit length | 4-6 s scenes, or a short claim card then a proof of several seconds | one narrated sentence (3-6 s in the films measured) | a steady unit of about 1-3 s | one step: 6-12 s with voice, 3-5 s without | beats of about 1-3 s, up to 4 s for calm films | shots of about 0.5-2 s; numbers hold long enough to read |
| Hard cuts | 1-2 accents (continuous) or about 10-20 (chapter) | 0-5 (one world) or many with a thread (montage) | the main transition in footage films | few; more only when the backdrop holds | the main transition | the main transition in footage recaps |
| Close | logo 1-3 s; whole close about 3-11 s | still card about 2-5 s | claim held on its own, then logo 1-4 s | about 3-9 s: the logo, or one line and the logo | no card, a loop, or a short tag (~1.5 s) | still lockup 1.5-3.5 s; longer over a moving ground |

## Project layout

At stage 1, create the project folders as laid out in `references/project-layout.md`: brief, script, direction notes, ideas, references, storyboard, motion spec, assets, build and output.

## The stages

Read `references/checkpoints.md` for response templates and stage-specific loading. Stop at every gate and wait for the user; reuse explicit decisions already made.

| # | Stage | You make | Gate |
|---|---|---|---|
| 1 | Brief | `brief.md`: type, format, narration, people, footage, length, reference videos or from scratch | Brief right? |
| 2 | Script and story | `script.md` with the hook, the structure from the type file, one job per beat | Script locked? |
| 3 | References | only when the user chose reference videos: notes on 3+ accessible real films, or an explicit reference-input hold | (no stop; feeds stage 4) |
| 4 | Direction options | 2-3 directions as real frames of the opening | Which direction? |
| 5 | Look decisions | one decision at a time, 2-3 options each | Each pick |
| 6 | Storyboard | every scene, start and end frames, notes page | Approved, or notes |
| 7 | Motion spec | scene lengths, then a named move, timing and easing for every change | Approved |
| 7-9 | Sound | clip sound or library effects by film type, fitted music, `assets/audio/SOURCES.md` | Does it sound right? |
| 8 | Animated test | the 2-4 hardest scenes in HyperFrames (a run from the start for live-action story ads) | Does it move right? |
| 9 | Full build | the whole film and its cutdowns, checked frame by frame | Final |
| 10 | Polish rounds | one new numbered render per round of notes, each note checked against its frames first | Each round signed off |

### 1. Brief

Ask these as explicit decisions; never infer them or bury them in a settings list:
- **Type** (table above), and whether it is explained or a pure showcase.
- **Format**: 16:9, 9:16, 1:1 or 4:5, and any cutdowns (6, 15, 30, 60 s).
- **Narration**: voiceover, on-screen lines only, or no words at all.
- **People**: real-looking people, illustrated characters, hands only, or faceless, and whether their own voices are heard.
- **What must be real**: logo file, font, the real product's screens or a demo account, real footage or photos of real named people or events (recaps, and brand films with named people, need real material), music (their own track, or Suno on a paid plan). How people, B-roll, places and 3D are made is yours to propose at stage 4.
- **Viewer**: who watches, what they know and doubt, where it's posted (this sets captions), what they should think or do afterward.
- **Length**: check it against the type's usual range.
- **Names and logos**: which may be shown.
- **Media tools**: their clip tool (Higgsfield, another, or none) and stills (Codex or their own photos). If the proof needs real motion and there's no clip tool, say so (`references/media.md`). Also ask whether cuts may be uploaded to Google's Gemini API for the motion watch (`references/build-and-qa.md`).
- **Inspiration**: ask in these words: "Would you like to draw inspiration from reference videos or build something from scratch?" Reference videos: ask for any film or style they have in mind (a named film counts as a reference) and for an OK to download. From scratch: skip stage 3. Unsure: recommend one in a line (from scratch for a common type; references for an uncovered look or a high-stakes film).

Write the answers into `brief.md`; never invent them.

### 2. Script and story

If the user brings a script, put it in `script.md` as a table (scene, name, lines, narration, and for launch and demo films a proof column) and keep it. If you draft lines, write plain sentences a person would say: no stacked fragments, no triplets of parallel lines, no "Meet X", "Introducing" or "Not just X, it's Y". Run `python3 <skill>/scripts/scan_script.py script.md --out output/script-language-review.json`; review each candidate in context and preserve supplied wording unless the user approves an edit. Then check the story against the type file's structure:
- **Hook**: the first 1-3 seconds show the strongest picture or a felt situation, not a logo or a company description.
- **One promise**, made by the second beat; everything after is evidence.
- **One job per beat.** The key moment gets about twice the time of minor beats.
- **One turn or change of energy** somewhere past the middle.
- **The opening device and the closing device** are chosen on purpose, not added by reflex.
- **It makes sense with the sound off**, unless it is narration-led.
- **Product launch and demo films: name the proof for each claim.** Beside every claim in `script.md`, write what on screen will prove it, found with the beat method in `references/visual-ideas.md`.

### 3. References

Skip this stage for a film built from scratch, saying so in one line. Otherwise study three accessible real films before drawing. If the user named a film, it is one of the three; if they named a style, at least one film is in that style (studied for its look only), and the rest are of this type; follow `references/reference-films.md` if access is unavailable. The type file names starting points and what to look for. Pull stills with ffmpeg and note the mechanism: what carries across cuts, where text sits (as a percentage of frame height), shot lengths, how the close is built. Borrow mechanisms, never a film's look, logo or footage. Method: `references/reference-films.md`.

### 4. Direction options

Read `references/animation-styles.md` when choosing a visual style. If the user named a style, at least one direction uses it; if they named a film, at least one direction uses that film's style and mechanisms, never its look. Otherwise pick styles that fit the brief and the lead medium, so the 2-3 directions differ in style as well as idea. The house rules still apply. Show the user actual still options.

Make 2-3 directions that differ in their central idea (the type file says which kind of difference matters), not three colors of one layout. Each direction states its whole visual plan in the option's `plan` field:
- the idea in one sentence, with the product in it;
- what the product does at the turn;
- the media mix: one lead medium, plus inserts with one job each;
- one named drawing style;
- the recurring element (or none, on purpose);
- one way of moving between ideas;
- the end line.

Find the idea and run the five checks in `references/visual-ideas.md` before drawing. You propose the media yourself (B-roll, 3D, how any people are shown); the brief says whether people appear and what must be real.

Draw the start and end frames of the first one or two scenes with the frame kit and build an options page:

```bash
python3 <skill>/scripts/render_frames.py storyboard/frames.html --ids 01a,01b,02a --out storyboard/options-direction-v0.1
python3 <skill>/scripts/build_storyboard.py storyboard/options-direction-v0.1.json storyboard/options-direction-v0.1.html
```

Start the JSON from `assets/options-direction-starter.json`. Name the style behind each direction, and the reference technique too when references were studied, then recommend one in one or two sentences.

### 5. Look decisions

Settle the look one decision at a time, each with 2-3 options on the same frames: in product launch, demo and live-action story films, how the product is shown (recorded screens, the real interface rebuilt, or people and illustration with little interface; the type file says what each costs), then color treatment, then the signature scene's layout, then where text sits. Use the variant switch for color (render with `--variant <name>`, start from `assets/options-color-starter.json`). Reading the answers:
- When an answer is ambiguous ("1 looks nicer"), say which option you took it to mean.
- "I like 1 and 3 but it feels too X": keep both, fix X on both, show them again.
- Fix the thing the user pointed at; an idea they call "interesting" is a bonus, not the main ask.
- If they dislike every option, name what all the options shared before making new ones.

More: `references/options-rounds.md`.

### 6. Storyboard

Design every scene: a start frame and an end frame, plus an in-between frame whenever the change can't be pictured from the two ends. Use the frame kit (`references/frame-kit.md`) with `BRAND.size` set to the format; the renderer reads it and renders at that size. Render, read the check output, fix, then build the page. Before drawing a scene, run the beat method in `references/visual-ideas.md` (section 3) on its key line.

```bash
python3 <skill>/scripts/render_frames.py storyboard/frames.html --all --out storyboard/frames-v0.3
python3 <skill>/scripts/build_storyboard.py storyboard/storyboard-v0.3.json storyboard/storyboard-v0.3.html --previous-notes <notes downloaded from v0.2>
```

The page shows the whole film in order, each scene change as the last frame beside the next first frame, and a card per scene with full-width frames, 8x zoom, pins and a notes box. Tell the user they can pin comments and use **Copy all notes**. When notes come back, answer every point in a numbered list before redrawing. JSON format: `references/storyboard-format.md`.

### 7. Motion spec

Read `references/motion-library.md`, `references/motion-spec.md` and the type file's motion section, then check the storyboard's motion notes against them and list every conflict. Then:

1. **Fix scene lengths first**, by the type's rule (shot shape, narrated sentence, unit, step or beat), so every line stays readable (`references/text-and-captions.md` has the reading times). Short scenes force everything on screen in the first second. Tell the user the new total.
2. Give **every change inside a scene and every change between scenes** a named move, timing, easing, and what carries over.
3. Plan sound with the picture (`references/sound-and-voice.md`) and start the Sound stage (`references/sound-stage.md`).
4. Write it into the storyboard JSON and `motion-spec.md`, rebuild with `--strict`, and show the user.

`--strict` checks the motion fields (`references/storyboard-format.md`); review its fade/blur candidates and NOTE lines.

### 8. Animated test

Build the 2-4 hardest scenes in HyperFrames first (the type file may say otherwise), with `data-text-role` on every element that holds words. Read the HyperFrames docs before writing composition HTML (`references/build-and-qa.md`). Run the outside comparison described there (a reference film of the same type, or the type's numbers for a film built from scratch) and report where ours loses. Ask the user to watch for pacing and for anything that still feels like slides, and to listen to the sound. Run the stage 9 checks on the test too.

**Every render the user sees** opens by saying which scenes it covers and what is still a placeholder. In a film with people shown as footage, a person's action is moving footage (a generated or supplied clip), never a still with a push; a shot not ready is left out or marked as a placeholder on screen. In live-action story ads, the product's screen is a screen recording of the real app unless a rebuilt interface was approved at stage 5.

### 9. Full build and checks

Build the rest and any cutdowns and render. **No render goes to the user until the render check passes:**

```bash
python3 <skill>/scripts/check_render.py build/ --motion --video output/cut-v3.mp4 --out output/checks-v3
python3 <skill>/scripts/cut_frames.py output/cut-v3.mp4 --out output/cuts-v3
python3 <skill>/scripts/action_frames.py --actions build/actions.json --motion-spec motion-spec.md --build build/ --video output/cut-v3.mp4 --out output/actions-v3
python3 <skill>/scripts/continuity_sheet.py output/cut-v3.mp4 --items build/continuity.json --out output/continuity-v3
python3 <skill>/scripts/check_sources.py assets/audio
python3 <skill>/scripts/sound_balance.py --music build/audio/music.wav --effects build/audio/effects.wav --voice build/audio/voice.wav --events build/audio/events.json --out output/sound-v3
python3 <skill>/scripts/watch_cut.py output/cut-v3.mp4 --out output/watch-v3 --upload-allowed --notes direction-notes.md
```

Exact render-check failures must be fixed; candidates need a recorded visual judgment (`references/build-and-qa.md`). Required on every render the user sees from stage 8, every strip and sheet opened:
- **Cut strips** at every cut; **action strips** at every click, press or touch inside a shot (a pointer off its target fails), or an empty `actions.json` for a film with none.
- **Continuity sheets** for films with generated clips of recurring people, places or props: one verdict line per recurring prop and garment; `--verify` passes.
- **Sound balance** from the mix's stems, for films with effects or voice. Claude can't hear: report the numbers.
- **A fresh read** by a new agent, or a build-log line saying why not.

The motion watch is extra coverage (`--upload-allowed` only if the brief allows; confirm findings in frames; otherwise say "not watched in motion"). A clean watch is never proof: it sees low-resolution frames.

Every element holding on-screen words carries `data-text-role`: `opening`, `line`, `emphasis`, `card`, `label`, `caption`, `name`, `typed`, `legal`, or a named UI role (`ui-title`, `ui-row`, `ui-pill`; one role per kind of UI text, so each is checked for one size). `ui-read` marks UI text the viewer must read.

Then check the rest: overlaps during transitions, frozen stretches, text too small at phone size, warped hands or faces in generated clips, measured spacing, the close against the type's numbers, and a muted watch. Then repeat the outside comparison.

### 10. Polish rounds

Once the full film exists, most of the work is rounds of notes against timestamps. Each round runs the same way (details: `references/polish-rounds.md`):

1. **Find each note in the frames before changing anything.** Pull frames at the time given, 1 s either side, and say back the moment by what is on screen and what you will change. When a word in the note could mean a line of text or an object on screen, say which one you took it to mean.
2. **Show design changes as stills first.** Any change to how something looks gets labeled stills next to the current frame, with a recommendation, before it is built.
3. **One new numbered render per round**, with the stage 9 checks, a phone copy under 30 MB, and one build-log line.
4. **When a check disagrees with something the user chose on purpose**, list it as the user's call with the evidence; don't quietly undo their choice.
5. **Choppiness the render check missed**: follow `references/polish-rounds.md`, don't guess.
6. **After every third round, and before calling a cut final, do an ideas pass**: run the beat method in `references/visual-ideas.md` on each key line and offer the best ideas as stills. Rounds that only answer notes make a film smoother, not stronger.

## Design rules for every type

A type file says where it loosens one of these house rules; anything marked "ask first" there needs the user's OK.

**Continuity, not slides**
- At every change, something survives and carries into the next shot: an object (a chip becomes a tile), the words (a line stays while the picture changes), an eye line, or a system that rides every clip (a typed query, a name bar, a chapter color). If nothing survives, it is a slide change.
- During a change, the content or the shape carries over. Never show an empty card or panel in motion; if its text clears first, the shape itself carries the change.
- In a build-up of items, the first item stays sharp and on screen until the build is done. It may slide or scale once to make room, or move with a camera push; it never blurs, dims or leaves early. (A build made of cuts is exempt.)
- No bounce or elastic easing on text. Replace any recipe's `back.out`. A drawn character may squash and overshoot as acting.
- Pieces arrive one after another through the middle of a scene (on the spoken cue when narrated), then the result holds still for at least a second. In fast types (brand units, recap shots, short beats, teaser openers) the one-second hold applies to the claim, numbers and lines, not to every shot. No slow drift, breathing or floating as filler. A character may blink and breathe, a live product output may keep moving, and a carrier may keep moving while a number holds.

**Style choices made per film** (record each in the storyboard's `style` field; the defaults follow the film's style)
- How scenes change: one kind of change for the whole film with variety underneath, or a small set used with intent. Default: one kind for footage-led films that hard-cut on action and for single-camera motion films; chapter and mixed-media films may change kind per chapter.
- Dissolves and blur: default none between scenes in hard-cut footage films (still allowed: a dissolve into the end card, a short text blur-out, real camera motion blur). Calm text-led films may fade text in place. Motion-graphics and UI films may use motion blur on fast moves.
- How content leaves: default it leaves because the camera moves, because it turns into the next thing, or on the cut. Calm text-led films may fade lines out first; lower thirds may wipe out before their shot ends.

**Visual ideas and media** (details: `references/visual-ideas.md`)
- Each picture says the line before anyone reads it: a fan of lines into one hub says "connected"; a scatter only says "many". Write at least 8 ideas for a key line before picking.
- One drawing style for the whole film. Footage, photos, UI and 3D may mix; a second drawing style needs one job and the film's own ground and colors (or a look viewers already know), never a one-off.
- One lead medium for at least half the film; every other medium is an insert with one job. The recurring element, if there is one, appears in each medium.
- One kind of join between media, hard cuts by default; join on a shared subject, shape or color where you can.
- Whiteboard and hand-drawn films keep footage around the drawing or on the end card, never cut in mid-film.

**Layout and look**
- No card grids, sidebar app screens, or "headline left, product right". One big white panel per scene is still card-heavy. A grid is allowed only when the idea is "many" and every cell is alive.
- No colored accent borders or stripes, no small labels above headlines, no gradient text, no glow around logos.
- Show activity, not screens: typing, results arriving, a hand or cursor causing each change, objects moving and docking.
- Depth is a strong tool (layers at different distances, slabs with thickness, far things blurred), not a requirement. Flat 2D works when the object keeps changing form.
- Designed backgrounds are flat: black, white, or one brand color per scene or chapter. Offer a gradient or glow only if the brand already uses one. Edge darkening is optional, not a default. In footage-led films the picture is the background; designed backgrounds appear mostly on title and end cards.
- Color has a job: state (problem vs. fixed), category, or chapter. Take it from the brand's own colors and shapes; never blur brand colors together.
- End on one line or the logo alone, never a two-sentence tagline. Add a web address only when the viewer can act on a page now; the type file says when, and how long to hold the end.
- The logo appears with a job: once at the end as a signature on the film's own surface, or as something the film forms. Never as decoration, never repeated.
- The brand's own logo comes from its official file from the first frame it appears in, storyboard frames included. A redrawn copy gets details wrong. With no file yet, label every frame that shows it as a placeholder.
- Items in one list or pile are the same kind of thing (all tasks, or all messages). A property of an item, such as a due date, is a tag on that item, not an item of its own.

**People and pictures**
- People are a brief decision. When people appear: show the face of anyone named on screen; cast deliberately diverse people; show what each person is doing; show hierarchy by size and position.
- Avoid stock-looking pictures: boardrooms, hands on laptops beside coffee, silhouettes at windows, bright even light, centered smiling poses.
- Generated stills and clips never contain text, UI or logos. Type, UI and data are built in the frame, where they can be edited and are correct.
- Never generate a real, named or famous person. Use the client's own photo or footage for anyone real.
- When the product's interface is shown, it matches the real product, and it never shows an invented result as if the product produced it.

**Names and logos of other companies**
- Real tool logos only for integrations the product actually has, using official files, unaltered.
- Never real media-outlet names or logos; invent them.

**Text on screen** (details: `references/text-and-captions.md`)
- Keep the text systems apart: on-screen lines, labels on things, captions of narration, the product's own text, legal text. Never stack three of them at once.
- Each system has one home position for the film; the table above gives the default for the type. Move it only for a real collision, with a reason in the storyboard.
- A line never covers eyes, a mouth, an icon, a logo or the thing being taught. (Type on a calm, still face in a brand film is an ask-first exception.)
- In body lines, an emphasis word keeps the size of the rest of the line; a title or one deliberate giant word may differ. Mark it one way for the whole film (brightness, italic, a color matched to what it labels, the house color, or a drawn mark). No random accent colors.
- Each text role uses one or two ways of arriving for the whole film (word by word, whole line, typed, cut on), chosen by the line's job. Pure kinetic-type films are the exception.
- Text typed into a product builds up progressively, never all at once. The first typing is slow enough to read (about 4-10 characters per second); later typing can run faster once the viewer knows the action. A complete, pre-filled prompt is fine only for fast repeated results.
- Type only short text that finishes within about 2 s; show long text whole. Exceptions are in `references/text-and-captions.md`.
- One size per text role for the whole film (`scripts/check_render.py` enforces it).
- Nothing in the picture reads like narration: a sentence printed inside the frame gets read as script.
- One capitalization rule for every on-screen line, checked line by line.
- Everything stays inside the safe area for the format. Minimum sizes by role, as font size against frame height: lines, openings, cards and claims 3%; captions, labels, names and typed text 2%; in a vertical film read on a phone, 3% for all of them; UI the viewer must read 4-5% (role `ui-read`). `scripts/check_render.py` enforces the minimums.
- A cycling or word-swap line is used once per film (a deliberate repeat at the start and the end is allowed), and a line that lists things shows them one at a time.


## Tools

Which tool makes what, with each tool's notes: `references/tools.md`.

## Before you show anything

Before sending any page or render, go through every frame against `references/pre-show-checklist.md` and tell the user what changed, what you could not do or check, and the open questions.

## Reference files

| File | Read when |
|---|---|
| `references/types/<type>.md` | Stage 1 onward: structure, defaults and references for the chosen type |
| `references/project-layout.md` | Stage 1: the project's folders and what goes in each |
| `references/pre-show-checklist.md` | Before sending any page or render |
| `references/tools.md` | Which tool makes what, with notes |
| `references/checkpoints.md` | Each stage: response template, approval gate and next permitted reference loads |
| `references/animation-styles.md` | Stage 4, and stage 3 when the user named a style: style candidates grouped by kind, with example films and selection cues |
| `references/visual-ideas.md` | Stages 2, 4, 6 and 10: finding the film's idea, mixing media, turning each line into a picture, rules for whiteboard and 3D |
| `references/options-rounds.md` | Stages 4-5: how to make and present options |
| `references/frame-kit.md` | Stage 4 onward: the frame helpers, formats, rendering, common errors |
| `references/storyboard-format.md` | Writing storyboard or options JSON; the notes round trip |
| `references/text-and-captions.md` | Any on-screen text: the text systems, reading times, safe areas by format |
| `references/sound-and-voice.md` | Stages 2 and 7: narration, music, effects, silence, mix |
| `references/sound-stage.md` | Stages 7-9: making the sound by film type, fitting music, sound sources and licences |
| `references/motion-library.md` | Stage 7: proven shot shapes and transition families |
| `references/motion-spec.md` | Stage 7: scene length, house settings, named moves, spec format |
| `references/text-treatments.md` | Choosing how text looks and moves: the treatments seen in strong films, with sizes and timings |
| `references/media.md` | Making images, clips and logos; prompting; casting; checking generated media |
| `references/reference-films.md` | Stage 3, when the user chose reference videos: how to study a film; general techniques |
| `references/build-and-qa.md` | Stages 8-9: HyperFrames build, retiming, cutdowns, render checks, blind comparison with a reference |
| `references/polish-rounds.md` | Stage 10: reading timestamped notes, rounds and renders, checks against user choices, choppiness the check missed, the ideas pass |
| `assets/frames-starter.html`, `assets/frame-kit.js` | Copy to start `frames.html` |
| `assets/storyboard-starter.json`, `assets/options-direction-starter.json`, `assets/options-color-starter.json` | Copy to start the JSON for a page |
| `assets/codex-image-brief.md` | Template for each image set |
