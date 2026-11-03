# Frame kit

Storyboard frames are HTML pages drawn at the film's size (1920x1080 by default) and rendered to PNG with headless Chrome. One file, `frames.html`, holds every frame as a function; the URL hash picks which one to draw. Designing in HTML means frames use real type, real depth (CSS 3D) and the same layout the HyperFrames build will use later.

## Setup

```bash
cp <skill>/assets/frame-kit.js <skill>/assets/frames-starter.html <project>/storyboard/
mv <project>/storyboard/frames-starter.html <project>/storyboard/frames.html
```

Edit `BRAND` and `FRAMES` in `frames.html`. Images are referenced by relative path from `storyboard/` (for example `../assets/images/face-ava.png`).

## BRAND

```js
const BRAND = {
  size: [1920, 1080],                 // [1080, 1920] for vertical, [1080, 1080] for square
  font: '"Brand Sans", -apple-system, sans-serif',
  grounds: { main: "#c8103e", dark: "#14141a" },
  mark: { viewBox: [400, 220], mask: '<circle cx="108" cy="110" r="100" fill="white"/>...' },
  caption: { mode: "top", size: 58, weight: 520 },
  css: ""                              // extra CSS for brand UI pieces
};
```

- **size**: `[1920, 1080]` for 16:9, `[1080, 1920]` for 9:16, `[1080, 1080]` for 1:1, `[1080, 1350]` for 4:5. The caption defaults and the layout check follow the format.
- **grounds**: flat brand colors (black, white, or one brand color per scene or chapter). A gradient only when the brand itself uses one, and then one gradient per ground, never a blend of several brand colors.
- **mark**: the brand shape as an SVG mask, white inside, in its own viewBox. Draw it from the official logo file: open the SVG, copy the shape paths, set `fill="white"`. Shapes cut out of the mark are drawn in black.

## Helpers (all on `KIT`)

| Helper | What it draws |
|---|---|
| `GROUND(name, {vignette})` | full-frame background from `BRAND.grounds`; `{vignette: true}` adds faint edge darkening (off by default) |
| `SWEEP(from, to, progress)` | one ground sweeping over another along a curved edge; progress 0-1 |
| `STAGE(rx, rz, inner, {perspective, origin})` | a 3D space; put slabs inside it |
| `SLAB(x, y, z, w, inner, extra)` | a surface with real thickness at depth `z` |
| `far(level)` | CSS for depth of field on distant things (1 or 2) |
| `PHOTO(src, x, y, w, h, {pos, radius})` | a photo |
| `FACE(src, size, ring)` | a round face; use wherever a person is named |
| `CHIP(x, y, lead, title, sub, {scale, rot, extra})` | a solid glass chip (face or icon, title, line) |
| `SHAPE_MOSAIC(x, y, w, {photos, ghost, keep, single, cols, rows})` | photos filling the brand shape; `ghost` draws the faint outline, `keep(r, c)` picks which tiles are filled for in-between frames |
| `CAPTION(text, {mode, size, x, y, w, role})` (sets `data-text-role`, carried into the build) | the on-screen line; modes `top` (about 9% down in 16:9, 20% in 9:16), `mid` (brand films: 47% down, over the picture), `center`, `side` |
| `LABEL(text, x, y, {size})` | a 1-3 word label beside a thing; checked against the safe area, not for overlapping the thing it names |
| `VISUAL_TOP()` | the y where the main visual should start when lines sit at the top (27% in 16:9, 32% in 9:16) |
| `CURSOR(x, y)` | a pointer, for clicks a person makes |
| `LOGO(src, size)` | an official logo image |
| `NOTE(text, pos)` | a dashed note for the reviewer, removed in rendered stills |

Give any visual element you write by hand `class="k"` so the overlap check can see it.

## Frame ids

Name frames by scene and state: `01a`, `01b`, `02a`, `02b2`. Never reuse an id for a different design; when a frame is redesigned, give it a new id (`02c` → `02c2`) so older storyboard versions still render as they were.

## Rendering

```bash
python3 <skill>/scripts/render_frames.py storyboard/frames.html --all --out storyboard/frames-v0.3
python3 <skill>/scripts/render_frames.py storyboard/frames.html --ids 03a,03b --out storyboard/frames-v0.3
```

Frames render at the size `BRAND.size` declares (`--size WxH` overrides it, and the check fails if the two disagree). Each frame is drawn without its reviewer notes (`&clean`). Add `--with-notes` to keep them. Results:

- **FAIL**: the frame threw an error, drew nothing, or came out a flat color. Fix before going on.
- **WARN**: a line of text touches a visual element or sits outside the title-safe area, or something sits outside the format's safe box (16:9: bottom 17% kept clear; 9:16: content between 15% and 65% of the height, 6% left, 12% right). Override with `BRAND.safe = {top, bottom, left, right}` (fractions) or `BRAND.clearBottom`. Open the PNG and decide. A real overlap gets moved; a deliberate one gets a reason in the storyboard.

Then look at the frames yourself as a contact sheet before building the page: the check finds overlaps, not ugliness.

## Common errors

- **Every frame renders blank or the list is empty.** A JavaScript syntax error stops the whole file. The usual cause is a stray comma left between frame entries when frames are pasted in (`},\n,` or a backtick followed by `,,`). Run `node --check` on the script, or open the file in a browser and read the console.
- **One frame shows "Frame error".** That frame's function threw; the message names the problem.
- **Images missing.** Paths are relative to `storyboard/`. Chrome needs `--allow-file-access-from-files`, which the renderer passes.
- **3D looks flat.** Increase depth differences (`z` of 80-200 px between layers), tilt the stage 12-22 degrees, add thickness with `SLAB`, and blur the farthest layer.
