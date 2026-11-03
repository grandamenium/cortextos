# Live-action story ad

A short story with a person in a real setting: a character has a problem, the product fixes it, and a payoff lands. Usually comedy; about 30-65 s. The viewer should recognize the situation, see the product work on the person, and remember the joke.

Live action means the film is footage: generated clips of an AI character, or supplied footage. Motion graphics only carry the captions, the product's screen when it is shown, and the close.

The numbers below come from three films measured for one project (Logitech "An Unfortunate Series of Laptop Catastrophes", 53.6 s; Progressive "WFH", 30 s; Google Pixel "Rough Night", 63.8 s). Where a number is that project's own target rather than a measurement, it says so. Treat all of them as starting values.

## Ask in the brief

- **The situation in one sentence**, with the character, the place and the time pressure ("back from the gym at 9:58 with a call at 10").
- **The character**: age, look, clothes at the start and any change of clothes, and whether they speak (an AI voice, a real voice actor) or think in voiceover.
- **The clip tool and a rough budget.** Generated clips often need two or three tries, so budget two to three generations per person shot. In the brief, give a rough figure from the script's likely shot count; run `higgsfield generate cost` with the action-clip flags in `../media.md` for one typical clip (a 5 s, 1080p Seedance clip estimated 60 credits on 2 November 2026), and check the balance with `higgsfield account status`. After the storyboard is approved (stage 6), count the person shots, give a firm estimate the same way, and get the user's OK before generating. Write both in `brief.md`.
- **The product moment**: what the person does with the product, and the real app or product it shows. A software product needs a screen recording of the real app.
- **The swear, the gag, anything a platform might refuse**: decide bleeps and cuts for paid placements now.

## Structure (share of running time)

| Beat | Share | What it does |
|---|---|---|
| Hook | first 0-10% | The situation in one picture: the character in the place, the pressure visible (a clock, a mess, a reaction). No logo. (Logitech's opening title runs about 9%) |
| The problem felt | to about 70-75% | Shots of the character reacting and trying; the problem gets worse or more specific. Measured shots ran about 1-7 s (Logitech 2-6 s, Pixel 1-7 s); one project aimed for 1-3 s in its rush |
| The product turn | about 75-78% | One close-up action that switches the product on (a hand, a click, a tap), held about 2 s on a calm ground (Logitech 40-42 s of 53.6) |
| Payoff | about 80-92% | The product's result on the person, shown, not said. Then the gag: the part the product didn't fix, or the reaction |
| Close | last 3-19% | One line, then the logo. Measured: Logitech's logo alone about 2.5 s (3%); Pixel's claim cards and logo about 12 s (19%), which runs long because the feature was never shown. One project aimed for about 6 s. A web address only when there is something to do now |

## Rules

1. **Every shot of a person is moving footage**: a generated clip or supplied footage, in every review render and the final film. A still with a slow push never stands in for a person doing something; it reads as a slideshow. A shot whose clip isn't made yet is left out of the render or marked as a placeholder on screen, never faked with a still.
2. **One character, one look, across every clip.**
   - Approve the character as stills first: one front portrait and one full-body shot, in each outfit the film uses. These are the references for every clip.
   - Start each clip from an approved still of that scene (image-to-video), and paste the same character description word for word into every clip prompt: face, hair, build, clothes, and any change (a shirt pulled on in scene 4 stays on after it).
   - Check each clip against the reference stills for identity drift (face, hair, glasses, hands) before using it. Regenerate drifted clips.
   - If the clip tool offers a trained character reference (Higgsfield `soul-id`), check whether the chosen video model accepts it before relying on it.
3. **The product is real.** The product's screen in the film comes from a screen recording of the real app, captured at the size and state the scene needs (`screencapture -v` on a Mac, or the user's own recording), not from a stack of screenshots moved around. A rebuilt interface is allowed only when the user picks it at stage 5 (the "how the product is shown" decision), and it must match the real app.
4. **Screens inside person clips.** A clip model draws fake interfaces and text, so a person's clip never shows a readable screen. Frame the screen away from the camera, off-angle or out of focus, then either cut to an insert of the real recording or lay the recording over the screen in the build, tracked to it.
5. **Show the result on the person.** The turn and the payoff show the product working on the character, not a narrator saying it does. A film that only talks about the feature needs a long claim close to explain it.
6. **The gag needs its setup.** Whatever the payoff reveals (the part left unfixed, the reaction) is planted earlier in the film.
7. **The person does one thing per shot.** One clip holds one location and one action. Use the action-clip command in `../media.md` with the character's reference stills, not the living-portrait command: a locked-off "subtle" prompt returns a near-still clip.

## Look decisions (stage 5)

In order: how the product is shown (a screen recording, or an approved rebuild), the grade (one color treatment over every clip), then where captions sit. Each as 2-3 options on the same frames.

## Text and sound

- Spoken lines and thoughts are captions in one home position, at least 3% of the frame height on a phone-watched film. The measured films set their few lines about 45-50% down over the picture (Logitech) or in a bar about 93% down (Progressive); pick one and keep it. Keep the bottom 17% clear of captions unless the type sits in a bar there on purpose.
- A screen the viewer must read (a clock, an alert) gets its own close-up insert, at least 4% of the frame height for the words that matter. Over the shoulder, a laptop screen is unreadable.
- Music carries the pace. A hard stop in the music for the gag or the swear is one project's choice, not a measured pattern.

## Motion and transitions

Hard cuts on action are the main transition (Pixel: 18 cuts in 63.8 s). Handheld movement or a follow can come from the clip. A push into a screen that carries the real recording, or into a call window, is done in the build so the recording stays locked. No dissolves inside the story; one into the end card is fine.

## The animated test (stage 8)

Test a continuous run from the start of the film: the hook through the product turn, so the test makes sense to someone who hasn't read the script. Generate the clips for that run after the motion spec is approved (stage 7), within the approved budget. If they aren't ready, render the whole film at low quality with placeholders marked on screen instead of polished middle scenes. Never test isolated middle scenes.

## Close

One short line (the headline or the offer), then the logo alone on a flat brand color. Logitech ends inside the story first (a call window of good-looking faces) before its 2.5 s logo; Progressive puts the logo over the last speaker's tile.

## Direction options differ by

Where the camera watches from (the room, the webcam's own view, the screen), and what the gag is.

## Films worth studying

Logitech "An Unfortunate Series of Laptop Catastrophes" (the problem through the webcam's own view, one hand action as the turn, a call window of good-looking faces as the payoff), Progressive "WFH" (the whole film inside a plain call window, so only the person changes), Google Pixel "Rough Night" (what goes wrong when the feature is only talked about: a long claim close).

## Default versus better

| Default | Better |
|---|---|
| Stills with slow pushes for the person's actions | Every person shot is a clip, started from an approved still |
| Screenshots of the app slid around | A screen recording of the real app |
| A narrator saying what the product does | The result visible on the person's face or situation |
| A test of the most complicated middle scenes | A test that runs from the start through the turn |
| A different-looking character in each clip | One reference set, one pasted description, each clip checked against it |
