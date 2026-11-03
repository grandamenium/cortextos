# Options rounds

Every visual decision is made by choosing between 2-3 real options drawn as frames. People react far better to "A or B" than to a description, and seeing two versions side by side shows what each choice actually changes.

## The order of decisions

1. **Direction** (stage 4). 2-3 concepts that differ in their central idea (each type file says which kind of difference matters), each with its whole visual plan in the option's `plan` field and checked with the five checks in `visual-ideas.md`. Examples of genuinely different ideas for a product film:
   - one person at the center, with the work arriving around them at different depths
   - one product surface the camera glides across, edges running off the frame
   - a map of people and work that tangles, then untangles into clean branches
   - one object that keeps changing form through the whole film
   Three color versions of the same layout are not three directions.
2. **How the product is shown** (product launch, demo and live-action story films). 2-3 of: recordings of the real screen, the real interface rebuilt to match it, or people and illustration with little interface. Draw the same scene each way and say what each costs; the type file lists them.
3. **Color treatment.** 2-3 treatments on the chosen direction's frames, built from the brand's own colors. Use the page's variant switch so one click changes every frame. Designed backgrounds are flat: black, white, or one brand color per scene or chapter. Good starting set: the brand's main color, a dark or light neutral with the brand color only on what matters, and a change of brand color at each chapter. Offer a gradient or glow only if the brand already uses one; edge darkening is an option, not a default.
4. **The signature scene.** If one scene carries the film (the shape forming, the product acting), give it 2-3 layouts.
5. **Line placement.** Show the same 4-6 frames with lines in each candidate position, side by side. Measure the reference you are following, or use the type's numbers for a film built from scratch (for example, line starts about 9% down, visual starts about 27-30% down, bottom 17% empty; or for a brand film, type at 42-52% over the picture) and say the numbers.
6. Smaller choices as they come up (a tool tile style, how a person appears), each with 2 options.

One decision per page. Don't stack color, layout and placement into one round; the answer gets muddy.

## What each option needs

- A short name the user can say back ("Brand red", "Glide", "Top line").
- One or two sentences on what it is, its style, and the reference technique it comes from when references were studied.
- For a direction: the `plan` rows (idea, product at the turn, media, drawing style, recurring element, moving between ideas, end line).
- Frames: the start and end of the scenes it affects. For a direction, the first one or two scenes. Add an in-between frame when the change is the point.
- When the decision changes something already drawn or built, the current frame beside the options, labeled "Now". Build nothing until the user picks.
- `"recommended": true` on the one you would pick, and one sentence on why in your reply.

## Making the page

Write `storyboard/options-<decision>-v0.N.json` (format in `storyboard-format.md`), render the frames, build:

```bash
python3 <skill>/scripts/render_frames.py storyboard/frames.html --ids 01a,01b --variant warm --out storyboard/options-color-v0.1
python3 <skill>/scripts/render_frames.py storyboard/frames.html --ids 01a,01b --variant cool --out storyboard/options-color-v0.1
python3 <skill>/scripts/build_storyboard.py storyboard/options-color-v0.1.json storyboard/options-color-v0.1.html
```

In `frames.html`, a frame reads the variant from its argument: `"01a": (p) => \`${GROUND(p.variant || "warm")}...\``.

## Reading the answer

- If the user names an option by number or letter and the page uses the other scheme, say which one you took it to mean.
- "I like 1 and 3 but it feels too X": keep 1 and 3, fix X on both, show them again. Don't fold them into one.
- When the user points at the source of a problem ("it's the background"), fix that and leave the rest alone. A bonus idea they call "interesting" is not the main ask.
- When the user says they don't like any of the options, find what all of them share that caused it (for example, every option blended the brand colors) and name it before making new ones.
- Write the pick and its exact values into `direction-notes.md` the moment it's made.
