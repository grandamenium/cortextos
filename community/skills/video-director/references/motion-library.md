# Motion library: proven shot shapes

A digest of the scene shapes in the HyperFrames animation library (Apache-2.0), rewritten as a lookup table. Each shape is a time-coded pattern with one signature move, drawn from studying many professional product-launch clips. Their lengths are for designed scenes; footage-led types (brand films, recaps, shorts) use the type file's unit instead. For each scene, find the closest shape first, then adapt it. Name the shape in the motion spec's Source column.

| Shape | Signature move | Typical length | Use for |
|---|---|---|---|
| kinetic-type-beats | The words are the motion: a fixed line swaps one word in place on hard cuts, or a statement builds across full-frame beats | 3-13 s | Openings and payoffs where the words carry the shot and there is no set or click |
| typewriter-reveal | A caret types and edits a line the way a person would, then it collapses into the payoff | 3.5-7 s | A relatable typed problem, or a typed closing line under a standing mark |
| spatial-pan-stations | Stations laid out on one large canvas; one camera pans from station to station, landing on the last | 7-10 s | A timeline, a web of problems ending in a knot, a concept strip that pans into the product |
| camera-journey | The camera tells the story: dive in, something fires, travel to where the result appears, landing push | 5.5-11 s | Cause and effect shown by the camera's travel through one world |
| zoom-out-workspace-reveal | Open tight on one detail, then one continuous slowing pull-out reveals the whole it belongs to | 7-11 s | "This small thing lives inside all of this"; scale and breadth payoffs |
| constellation-hub | Icon nodes spring into a ring around a center, then resolve on the core (push in, orbit, or a click that collapses the ring) | 5-8 s | "Connects everything"; the product at the center of a stack |
| grid-card-assemble | Items cascade into a grid or list and hold; optional pull-out reveals the grid inside something bigger | 3-10.5 s | Breadth at once: a logo wall, an accumulating list, a live board filling in |
| logo-assemble-lockup | The brand mark comes to exist from parts (assembling, drawing on, morphing out of the previous phrase) and resolves to a centered lockup | 4.5-11 s | A brand moment or the closing lockup |
| cursor-ui-demo | A visible cursor drives a rebuilt interface through clicks and drags while the camera follows each interaction | 4-13 s | One workflow end to end, cursor-led |
| device-surface-showcase | A device or floating window held as the hero while its screens move through a real flow, camera from still hold to slow 3D push | 5-11 s | A feature shown inside its real interface |
| prompt-type-submit-generate | A request types into the product's input and the machine answers: working state, then a streaming answer or generated result | 5-12 s | "Watch me ask, watch it answer" |
| agent-progress-theater | One trigger hands the frame to the machine: status phrases swap while it works, then results arrive and check off | 4-11.5 s | Multi-step agent work where the change of state is the demo |
| panel-edit-live-sync | A control panel bound to a surface; changing a control updates the surface in the same beat | 5-12 s | Live editing: "change this, watch it change" |
| transcript-scroll-artifact-reveal | Travel down one long surface of generated work as evidence, then one interaction opens the finished deliverable | 5-12 s | "It did a lot of work, and here's the result" |
| dataviz-countup | Numbers and charts are the hero; the camera pushes through them to land on one metric | 4-12 s | When data carries the argument |
| titlecard-reveal | One clean title revealed with exactly one restrained move, then a still hold | 3-5 s | A calm landing beat between busier scenes |
| comparison-split | Two items enter from opposite sides with mirrored 3D tilts, hold side by side | 4-6 s | Two complementary things weighed at once (never more than two) |
| overwhelm-surround | Surfaces and icons accumulate around the viewer and close in from all sides | 6-10 s | The problem as being buried in work |
| ticker-takeover | A line cycles options, then the hero crashes in and shoves the text aside, a collision rather than a fade | 5-7 s | "Could be many things" replaced by "this is it" |
| fixed-anchor-cycle | One element stays pinned while everything around it cycles through states | 6.5-11 s | Breadth around one fixed identity |
| video-text-pivot | A product video holds center, slides aside to hand its weight to a stat, then text fills the space | 6-8 s | "See the feature, then see the impact" |
| cta-morph-press | A resting mark condenses into a call to action, then a cursor lands a click with feedback | 4-7.5 s | A focused sign-off |

## Transitions

Pick one main kind of scene change for about two-thirds of the changes, plus one or two accents. Don't use a different transition for every scene. The main kind for these films is carry (one element turns into the next thing); it can repeat because the camera move under it changes every time.

| Family | Examples | Role |
|---|---|---|
| Carry | object carry, type carry, cursor carry, a card turning into the next card | The main kind |
| Camera (under a carry) | push into, glide, pull back, follow, tilt up, locked while elements shrink into place | Different at every change |
| Hard cut on motion | a cut landed mid-move, speed matched on both sides | Accent, where color or chapter changes |
| Stop | frozen picture and silence | Accent, at most once |
| Mask | unmask along the brand's curve | Accent, for one color turn |
| Material | shatter, flip | One dramatic beat |

Avoid: the same blur between every scene, star or polygon irises, lens flares, page burns and glitch effects unless the brand calls for them.

## Building them

The HyperFrames command-line tool carries its own documentation. Read it before writing composition HTML:

```bash
npx hyperframes docs compositions
npx hyperframes docs data-attributes
npx hyperframes docs gsap
npx hyperframes docs examples
```
