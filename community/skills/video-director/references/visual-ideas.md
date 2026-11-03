# Visual ideas

How to come up with what the film shows, at two levels: the film as a whole (stage 4) and each beat (stages 2 and 6, and the ideas pass in polish rounds). Followed by how to mix media, and the rules each style plays by.

## Contents
1. The film as a whole
2. Media and consistency
3. Each beat
4. Moves that carry a meaning
5. Style rules: whiteboard and hand-drawn, 3D, rebuilt UI
6. Worked examples

## 1. The film as a whole

Each direction option (stage 4) states its whole visual plan, in the option's `plan` field (`storyboard-format.md`), above its frames:

| Part | What it says |
|---|---|
| The idea | One sentence with the product in it: "A robot dog runs out of power, and the car brings it back" (Kia "Robo Dog"). |
| Product at the turn | What the product does that the story needs. The turn depends on the product; swap in a competitor and the story breaks. |
| Media | One lead medium for at least half the film, plus short inserts with one job each. Name each insert's job. |
| Drawing style | One style for everything drawn, named exactly ("flat UI cards on black, 1 px lines, brand color only on what matters"), not "clean and modern". |
| Recurring element | What runs through the film, how it changes state, and where it shows up in each medium. Or "none", on purpose. |
| Moving between ideas | One way for the whole film: one board or space the camera moves across, fresh pages, cuts, or one thing turning into the next. |
| End line | Restates the idea; not a generic slogan. |

**Where the idea comes from.** Look in these before drawing anything:
- **A plain truth about the product, and the situation where it decides the ending.** An electric car can power other things, so a robot dog runs down and the car revives it (Kia). Google Assistant remembers things, so a man afraid of forgetting his late wife (Google "Loretta").
- **A format the viewer already knows, which the product then changes.** Every ad shows clean clothes, so every ad is a Tide ad (Tide); a famous film's time loop, broken by the car (Jeep "Groundhog Day"). When the format is the surprise, it can land in the first third.
- **The brand's own world or character** (Budweiser's Clydesdales, Sam Adams' cousin).
- **A real person or story**, found by going to the people who make or use the product (Loretta, Lay's "The Little Farmer").

**Five checks before showing a direction:**
1. Can it be said in one sentence that includes the product?
2. Does the turn need this product?
3. Does the end line say the same thing as the turn?
4. Does it read with the sound off?
5. Is there one thing to follow from start to end?

A direction that fails one gets fixed or replaced before the page is built. Say in the option's summary which check was hardest.

**The recurring element.** Choose an element the viewer can follow. The best ones change state as the story moves: Kia's battery light, Jeep's alarm clock, a list that grows. It is a decision, not a requirement; if a direction has none, say why.

## 2. Media and consistency

The director proposes the media in each direction. Whether people appear, and in what form, is still a brief question (SKILL.md stage 1). How they and everything else are made (generated B-roll, hands and places with Higgsfield or Codex, HyperFrames graphics) is yours to propose. Only what can't be made or mustn't be faked comes from the user: real named people, real events, the real product, the brand's files.

**When each medium fits:**

| Medium | Use it for | Avoid it for |
|---|---|---|
| Rebuilt or recorded UI | What the product does | A benefit that happens off screen |
| Generated B-roll or supplied footage | People and human stakes, hands, a product in use, places | UI, data or results (never generated) |
| Real footage only | Real named people, real events | |
| 2D illustration or whiteboard | Abstract ideas, arguments, processes; a diverse cast without uncanny faces | Grave topics, unless asked |
| 3D | A product's form or material, an inside that can't be filmed, a system spread across places, a huge number | Software UI the viewer must read; a short list of claims with nothing spatial to show |
| Lines and charts drawn on footage | Measurement and proof (Dyson CameraJet, FT "Charts that Count") | |
| Type-led | One sharp claim, a manifesto | Explaining a process |

**Rules for mixing:**
- **One drawing style.** Footage, photos, UI and 3D mix freely; drawing styles don't. A second drawing style needs one job and must either sit on the film's own ground and colors or be a look viewers already know (emoji reactions in a social short, clips from a film the brand references). Never a one-off style for one scene.
- **One lead medium, inserts with one job each.** Apple Watch: live action 61%, UI inserts of 0.75-2.4 s. WWF Living Planet: illustration 68%, one 6 s footage block.
- **The recurring element crosses the media.** Dyson's grid wall appears in the 3D product stage, behind the sketches and in the real lab; Airbnb's "Up" house appears in animation, live action and the app.
- **One kind of join between media**, hard cuts by default. A dissolve suits a slow narrated film; a dip through black hides a big brightness jump.
- **Join on something shared where you can**: the same subject, shape or color on both sides of the cut.
- **Put two media in one frame**, not only one after the other: lines drawn on footage (Dyson), a presenter cut out over the UI (Canva), footage behind illustrated shapes (WWF). This is the main way different media read as one film.
- **Whiteboard and hand-drawn films don't cut away to footage partway through**. Hands, a presenter or photos frame the drawing or sit on the end card.
- **Check brightness between media at storyboard time.** White UI cut against a warm room jumps a long way in brightness (about 100-120 levels at every join in the Canva short). Use a shared ground or a fade through black when the jump is large (`build-and-qa.md`).

## 3. Each beat

For each claim or key moment (the proof named at stage 2, each storyboard scene, and the ideas pass in `polish-rounds.md` section 6):

1. **Look in four places for ideas:**
   - what the content does (connects, piles up, runs out, comes back, turns into);
   - what it is about (the real objects, people and places);
   - a look the audience already knows (a fuel gauge, an inbox, a search page);
   - a way of drawing borrowed from another field (a subway map, a wiring diagram).
2. **Write at least 8 one-line ideas before picking**, inside the film's chosen style and media. The first three are usually one idea three times. Write them in `ideas.md` under the line.
3. **First check, on every idea: what does the picture say before anyone reads the line?** A scatter says "many". A fan of lines into one point says "everything comes through here". A pile-up says "too much". If that message is wrong for the line, drop the idea. Also drop:
   - a picture that would fit any topic with only the labels changed;
   - a picture taken from a noun in the line rather than from what happens (a rocket for "launch", a lightbulb for "idea").

   A phrase that describes an action can be drawn literally when the picture adds meaning: "undermines" drawn as a jackhammer under the word LIFE on a ledge (RSA Animate "Basic Income", 0:00-0:04). 5 of 8 hand-drawn films do this.
4. **Second check, on the shortlist: does it make sense, and does it say the right thing for this line?**
5. Show the best one to three as stills (`options-rounds.md`) with one sentence each on what the picture says.

**Prefer one object whose state changes** for claims about change: a battery light that dies and comes back (Kia), a counter running down to 0, a clock, a list that grows.

**Timing.** The picture arrives first, 0.5-2 s before the spoken word it shows, and its label lands on that word, within about 1 s. Pictures lead or land on the word in 7 of 8 hand-drawn films; labels land on time in 8 of 8.

## 4. Moves that carry a meaning

| Meaning | Move | Seen in |
|---|---|---|
| This becomes that | One thing turns into the next | hand-drawn and 3D (AirPods Pro 3: "Hola" passes into the bud and comes out as "Hello"; Bontic: the phone and cart turn into the logo) |
| Many | Repeat the item | hand-drawn |
| Rejected | Cross it out or break it | hand-drawn |
| Everything comes through here | Lines running from each item into one hub | 3D (Lucy Electric's grid lines into the product) |
| It's all in here; scale | Pull the camera back to show the whole | 3D (Bontic marketplace, charity: water) |
| Runs out, comes back, grows | One object whose state changes | ads |
| Too much | A build that speeds up or lands in a burst | `motion-spec.md` section 5 |

## 5. Style rules

### Whiteboard and hand-drawn

- **Picture first, label on the word** (section 3).
- **One way between ideas:** one big board the camera moves across (RSA Animate), a fresh page every 4-7 s for a 60-90 s film (minutephysics, Common Craft), or cuts. Choose at stage 4.
- **Draw fast, then hold.** One object takes 0.5-1.75 s; lettering runs at about 8 letters a second. New lines appear in only about a third of the seconds; the rest is holding.
- **Main words large and short**, 8-25% of frame height (8 of 8). A dense single board with 2% labels can't be read on a phone; use fresh pages for social cuts.
- **Each accent color has one job**: the good side, the narrator's comment, or the thing's real color.
- **A visible hand is optional** (3 of 8). Drawing without a hand reads as whiteboard just as well, so no generated hand is needed. Marker on glass is the same build on a dark ground with bright line colors; it needs no presenter.
- **The recurring drawing changes state at the turn**: a cloud becomes a heart (RSA Shorts "Empathy"), a man gets a crown (Story of Stuff "Microbeads").
- Narration in the films studied ran 2.1-3.5 words a second (median 2.9).

### 3D

- **Use 3D only when it shows something flat graphics can't** (7 of 8): a product's form or material (AirPods Pro 3, Nike Air Max), an inside (the mRNA vaccine film, Coca-Cola "Happiness Factory"), a system spread across places (Lucy Electric's power grid, Bontic's marketplace), or a huge number as a field to fly over (charity: water).
- **Ease every camera move**; never constant speed (100 of 109 moves). Slow moves for looking cover about 0.1-0.4 of the frame width a second. Fast, blurred moves are for travelling between places, 0.25-1.6 s. No orbits were seen; product films turn the product, not the camera.
- **Stop or slow the camera for each claim** (6 of 6 films that make claims in 3D): stop dead for a product claim; slow to a drift in a continuous journey.
- **Text the viewer must read sits flat and still**, beside the object or on its own card, about 3.5-4% of frame height (7 of 8). Text on a 3D surface needs about 9% and a close camera.
- **One continuous camera journey with few cuts** explains a system (Bontic: 1 cut in 83 s). Brand pieces cut fast instead.
- **One 3D look from start to finish** (8 of 8).
- **Low-cost forms that build well in HyperFrames**: plain white models with one accent color for the subject (Lucy Electric), or flat drawings with a tilting camera saved for one idea (charity: water's "sea of faces"). The frame kit's `STAGE` and `SLAB` cover both.

### Rebuilt UI

The product launch and demo type files hold the main rules. Two more from the 3D sample (Microsoft "Meet Copilot"):
- Enter the UI by pushing into a screen, and leave the same way.
- A ground color per app or chapter tells the viewer where they are.

## 6. Worked examples

**"Acme connects to the tools your team uses."**
- *Weak:* about 27 tool tiles scattered around a client card on blue, some blurred. The picture says "lots of tools", and the card adds a second idea to the same screen.
- *Strong:* the Acme mark at the bottom as a hub, the tools on two arcs above it, a thin line from each into the mark, small dots travelling along the lines toward it. The picture says "everything comes through here" before the line is read. It builds in order: the mark, then the lines, then the tools on their ends.

**"Other tools stop working when the limit runs out."**
- *Weak:* a row of document cards moving past. It goes alongside the line but proves nothing.
- *Strong:* a counter running down to 0, turning red at 0, while the music drops out. One object whose state changes; the picture is the claim.
