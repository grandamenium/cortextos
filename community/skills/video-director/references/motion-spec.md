# Motion spec

The motion spec decides how every change moves before anything is animated. A storyboard shows start and end frames; the spec says how one becomes the other. Without it, the build falls back to the same fade or blur everywhere, which is exactly what makes a film feel like slides.

## Contents
1. Read the library first
2. What the spec must cover
3. Scene length comes first
4. House settings
5. Inside a scene
6. Between scenes
7. Named moves
8. Spec format
9. Positions to choose per film

## 1. Read the library first

Before writing a single move, read `motion-library.md` in full (the proven shot shapes and transition families), then the HyperFrames tool's own docs (`npx hyperframes docs compositions`, `npx hyperframes docs gsap`, `npx hyperframes docs examples`) so every move you name can be built.

Then check the storyboard's motion notes against the library and write down every conflict before writing any rules. Storyboard notes written from instinct usually conflict with the library in several places (scenes too short for their shape, drifting holds, a different transition for every scene, exits before cuts). Finding these first is cheaper than finding them in the render.

For each scene, find the closest shot shape, then adapt it. Name the shape next to every move.

## 2. What the spec must cover

- **Scene lengths**, checked against each shape's typical length and each line's reading time (section 3).
- **House settings** stated once: lines, cursor, lifts, depth of field, eases, holds, photos (section 4).
- **Every change inside a scene**: a timed table from the first frame to the last (section 5).
- **Every change between scenes** (section 6).
- **Conflicts**: each place the storyboard goes against the library, what the library says, what to do instead.
- **Pacing**: total running time against the target.

## 3. Scene length comes first

A scene that is too short forces every piece on screen in its first second, and a frozen picture follows. That front-loading is the main cause of the slides feeling. Fix length before choosing moves.

- Scene length follows the type's unit: see the "Scene or unit length" row of the table in SKILL.md and `types/<type>.md`. In a continuous product film, 3 s is too short for more than two steps.
- Every line stays readable long enough after it lands; the times by kind of text are in `text-and-captions.md` (1.0 s + 0.045 s per character for a line the viewer must read and nobody speaks). The builder prints a NOTE when a scene looks too short for its lines; set `"narrated": true` in the storyboard JSON when the lines are spoken.
- Add up the new lengths and compare with the target. A film storyboarded at 40 seconds commonly needs 55-65 once every scene has room. If it runs long, trim holds and gaps, never the line windows or the one deliberate stop.
- Tell the user the new total before changing any scene lengths.

## 4. House settings

**Lines of text**
- At a hard cut, the line cuts with the picture and the new line fades up 0.2-0.25 s later.
- Lines stay in their home position. Two lines never cross over each other.

**Cursor**
- Enters from off-frame, travels 0.7-0.8 s on `power3.out` (never constant speed, never over 1.0 s), settles 0.15 s, presses (cursor and target shrink slightly over 0.08 s, back over 0.15 s `power3.out`), the target shows its own press feedback (a ripple ring only if the user wants one), the screen responds on release, then the cursor slides off the text and fades.

**Lift** (a surface rising toward the camera as it becomes relevant): translateZ +40-80 px, scale 1.02-1.04, shadow growing from tight to soft, 0.45 s `power3.out`. Settle back in about 70% of the time, `power2.in`. Set each slab's 3D pose once and don't let later tweens reset it.

**Covers**: anything that closes over another element during a move (a panel sliding over a card, a shape scaling through the frame) is fully opaque for the whole move. A half-transparent cover over a light element reads as a white flash.

**Depth of field**: blur only small or far layers, 3-6 px per depth step, 8-12 px at most, dimmed to about 0.55 opacity; the thing in focus stays sharp. Clear all blur from an element before it hands off.

**Eases**

| Job | Ease |
|---|---|
| Camera glide or reposition | `power2.inOut` |
| Camera zoom to a target | `power3.inOut` |
| Camera landing, reveal pull-back | `power4.out` or `expo.out` |
| Card turning into another card | `power2.inOut` |
| Slab, tile, panel arriving | `power3.out` |
| Fast arrival (chips, logos, faces) | `expo.out` |
| Small fades and labels | `power2.out` or `power1.out` |
| Converging into something at a cut | `power3.in` / `power4.in` |
| Photo push | `sine.inOut` |
| Constant-speed stream | `none` |

- **No bounce on text or interface moves; drawn-character squash and overshoot may serve acting.** Many recipes and examples default to `back.out` (and some to `elastic`). For text and interface moves, replace these with `power3.out`, `expo.out`, or a critically damped spring before building.
- No more than two independent moves in a scene share an ease. The parts of one move (scale plus position, a blur riding a move, both halves of a cut) share one ease and count once.

**Holds are still.** Every scene's final state holds still for at least 1.0 s so it can be read. No slow camera drift, no breathing, no floating, no elements drifting on their own. Depth comes from camera moves past layers at different distances, not from idle motion. Exceptions: a character may blink and breathe (acting, not drifting); a live product output may keep moving when its motion is the proof; a carrier may keep moving while a number holds; footage keeps its own camera movement.

**Photos and living portraits**: a 1.00 → 1.04 push on a wrapper around the photo, `sine.inOut`; the clip sits inside the wrapper and never takes the push itself. Small faces stay still images.

**Speed range**: small UI changes 0.25-0.5 s; slabs and tiles 0.5-0.8 s; camera legs 1.0-1.4 s; a reveal pull-back about 1.0 s on `expo.out`; nothing over 2.5 s (under 0.8 s a camera move reads as a jump, over 2.5 s it drags). A group that reads as one thing (a cluster of chips, a ring of logos) arrives within about half a second in total (items × stagger); a group bigger than about nine gets a sweep instead of one by one. A build the viewer reads item by item follows **Build-ups** in section 5.

**Keep the clear band clear**: in 16:9, nothing added (lines, pills, lanes, faces) in the bottom 17% unless the type says otherwise; in 9:16, everything between 15% and 65% of the height. `render_frames.py` warns on anything outside the format's safe box.

## 5. Inside a scene

- Reveal pieces in order across the middle of the scene, roughly 20-75% of its length, with at least one reveal after the midpoint. Don't dump everything on screen in the first quarter.
- The element carried in from the previous scene moves from frame one; the first new element starts 0.1-0.3 s in.
- Hold the result still for at least 1.0 s.
- Start the hand-off in the last 0.6-1.2 s.
- **By default, nothing animates out before a scene change** (the film's `style.exits` can loosen this; SKILL.md, Style choices made per film). Content leaves because the camera moves away or because it turns into the next thing. End cards may fade; calm text-led exits follow the explicit style exceptions in SKILL.md. (Replacements inside a scene, such as a row settling back or the cursor leaving, are fine.)
- Every animated action produces a visible result. A click that changes nothing reads as decoration.
- **Build-ups.** A build meant to say "too much" speeds up, or lands in one burst; never at a steady rate. A build meant to be read item by item stays steady, about 0.3-1.0 s per item. Two exceptions may run steady: a growth story the viewer should follow stage by stage, and a run of single items that replace each other (client logos, about 0.13 s each). The first item stays sharp and on screen until the build is done (SKILL.md, Continuity).
- A long product section can't be one camera world for 40 seconds. Build it as two or three connected worlds; the element that crosses each boundary is drawn pixel-identical on both sides, so viewers still see one continuous space.

Write each scene as a timed table:

| Time | What happens | Shape or rule | Duration · ease |
|---|---|---|---|
| 0.15 | Hero portrait fades in inside the shape | plain fade | 0.6 · `power2.out` |
| 0.45 | First chip slides in and lands by her phone (no arrival effect) | fast arrival | 0.5 · `expo.out`, x +140 → 0 |

## 6. Between scenes

- **One kind of scene change throughout.** In designed films it is one element turning into the next thing, for about two-thirds of the changes (a chip becomes a tile, a draft becomes a card, a pill unfolds into a presentation). In footage-led films (brand films, recaps, day-in-the-life) the hard cut on action is the one kind, and what carries across is the words, the eye line, or a system on every clip (a name bar, a typed line, a chapter color). The type file says which.
- **Vary the camera move under it every time**: push into a tile, glide down a surface, pull back, follow a moving object, tilt up, stay locked while elements shrink into place. Never the same camera move twice; the builder's `--strict` check compares the `camera` field of every `to_next`.
- **Accents** in designed films: one or two hard cuts landed mid-motion (usually where the color or chapter changes, with the moving thing at full speed on both sides of the cut), and at most one deliberate full stop. Chapter films add a claim card at each chapter (`types/product-launch.md`).
- No more than two real camera moves in one change. Four things happening at once reads as noise.
- No blur-filter or crossfade transitions between scenes unless the storyboard's `style.dissolves` is true. Allowed: a dissolve into the end card, a very short text blur-out, real camera motion blur in footage.

## 7. Named moves

Use these names, or a shot shape's name, so the user and the build talk about the same thing. Each needs a reason at the point it's used.

| Move | What happens | Use when | Avoid when |
|---|---|---|---|
| Carry | One object stays on screen across the change and takes a new role | The default scene change | The object means nothing in the next scene |
| Type carry | A word from one line becomes a title or label in the next scene | A line names the next thing | It would add a label the script didn't ask for |
| Foreground becomes the transition | A shape scales through the camera while the next scene is already behind it | A chapter change or big reveal | More than twice in a film |
| Push into | The camera pushes into one element until it becomes the next scene | Overview to detail | Repeated at another change |
| Pull back reveal | Open tight on a detail; one slowing pull-out shows the whole | A small action inside a bigger system | The close-up isn't part of the wide shot |
| Glide | The camera travels across one surface to the next station | Product moments that share one space | The stations are unrelated |
| Follow | The camera follows an object as it moves to its next place | Something is handed from one step to the next | The object stops before the camera does |
| Gather | Pieces stream to one point and become one thing | A pile becoming a plan | Nothing results from the gathering |
| Fan out | One thing opens into several parts | Showing what is inside | Then folding it straight back |
| Dock | Objects fly in at different depths and lock around a center | Inputs feeding something | It ends as a static ring of icons |
| Stream | Items flow through frame, near ones fast, far ones slow | Volume ("you name it") | A count tile would undersell it |
| Lift | A surface rises toward the camera, shadow growing | Calling attention inside a product scene | Several things lift at once |
| Flip | A card turns over and becomes something else | A clear before and after on one object | As decoration |
| Sweep | A new ground color crosses the frame along a curved edge | The one color turn that should feel smooth | More than once |
| Assemble | Tiles fly in and fill a shape whose ghost is already visible | A group forming the brand shape | The viewer can't see what's forming |
| Cycle in place | A fixed line swaps one word at a time on hard cuts | One repeated idea | In more than one scene |
| Freeze and break | Everything stops, sound too, then the blocking thing breaks apart | One dramatic beat | More than once; no other scatter-out in the film |
| Unfold | A small item opens into the next full scene | An item in a list becoming its content | It repeats another change's dive |
| Hard cut on motion | A plain cut landed mid-move, speed matched on both sides | Color or chapter changes | Cutting on a still frame |

## 8. Spec format

Write `motion-spec.md` in the project, then copy each row into the storyboard JSON (`motion` entries and `to_next` with a `camera` field) and rebuild with `--strict`:

```markdown
# Motion spec v0.1

## Short version
- (scene lengths before and after, the biggest conflicts, what changes)

## Timeline
| # | Scene | Was | Now | Shot shape | Rhythm |

## House settings
- (section 4, with this film's values)

## Inside each scene
### 01 Cold open — 6.5 s
| Time | What happens | Shape or rule | Duration · ease |

## Between scenes
| Change | Kind | Camera move | What carries over | Timing · ease |

## Conflicts with the library
- What the storyboard says / what the library says / what to do

## Pacing
- Total against target; what to trim if long
```

## 9. Positions to choose per film

Good sources disagree on these. Pick one for each film, write it in the house settings, and say why in one line:
- Small corner labels or tracked-capital captions: many strong films ban them; some use them for a premium feel.
- Springs: none, or one visible spring at most.
- Whether a quiet fade is allowed for the opening line of a calm chapter.
