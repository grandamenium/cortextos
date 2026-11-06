# Images, clips and logos

Generated media is raw material for the film, not the film. Realism comes from the image and video models; text, timing, layout, transitions and sound come from the frames and the HyperFrames build.

## Contents

- Who makes what
- Every generated shot needs a job
- Codex stills
- Prompting clips
- Higgsfield clips
- Without Higgsfield
- Without Codex
- Logos
- The cast
- Slowing a clip

## Who makes what

| Need | Tool |
|---|---|
| Still images: portraits, faces, b-roll stills, client stand-ins, handshake or product-in-use photos | Codex image generation, or the user's own photos ("Without Codex" below) |
| Moving footage: living portraits, b-roll clips, a physical metaphor | The clip tool named in the brief, image-to-video from an approved still: Higgsfield, another tool, or none ("Without Higgsfield" below) |
| Text, UI, charts, logos, captions | The frames (frame kit) and the HyperFrames build |

Never generate stills with the clip tool, and never put text, UI or logos inside generated images or clips.

## Every generated shot needs a job

Name the job before generating: human stakes, the work environment, the before-state, collaboration, a consequence, scale, an explanation, the payoff. "The screen feels quiet" is not a job. Keep a non-generated fallback (a designed frame) for each generated shot that has no person acting in it, and label a conceptual shot in frame if it could be mistaken for the real product.

Never generate a real, named or famous person, and never describe a living filmmaker as the style; translate a style into camera, light, color and texture.

## Codex stills

1. Write a brief from `assets/codex-image-brief.md` into the image folder (`assets/images/BRIEF-<set>.md`). One brief can hold several images.
2. Run Codex from that folder, in the background, logging to a file:

```bash
cd <project>/assets/images && nohup codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" --skip-git-repo-check "Follow the instructions in BRIEF-<set>.md in the current directory exactly." > codex-<set>.log 2>&1 &
```

3. Wait for the files named in the brief to appear (or for the process to end), then look at every image before using it.
4. Keep the brief next to the images; it records how each was made.

Run stills on GPT 6.1 Sol at high effort, as above. If the user's Codex plan doesn't offer that model, drop `-m` and the effort setting so Codex uses its own default, and say so. Do not pass a `-s` sandbox flag. Codex saves under `~/.codex/generated_images/` and copies to the paths the brief names.

**Brief rules**
- Editorial, natural skin texture, soft window light, shallow depth of field, calm natural color, not stock photography.
- A neutral seamless backdrop for people who will be cut out or framed; a real setting for b-roll.
- State each person's age, gender, ethnicity, role, clothing and expression. Cast deliberately diverse people across the film.
- For the same person in several images, give the first image as the reference and say "THE SAME person (same face, hair, clothing)".
- Put the palette's hex values in the brief so plates match the frames, and say where to leave empty space for type.
- No text, no logos, no watermarks, no props that read as brands.
- Avoid stock tropes: boardrooms, hands typing beside a coffee cup, silhouettes at windows, a generic frustrated person at a laptop. A specific character in a specific situation (a live-action story ad's setup) is not a trope.
- Portrait 4:5 for people, landscape 16:9 for b-roll.

## Prompting clips

- **Director's formula**: cinematography (shot size, lens, camera move), subject, action, context, style and ambiance. Dialogue in quotes, effects with an `SFX:` prefix, ambient noise named.
- **One style descriptor, pasted word for word into every clip prompt** (medium, palette with hex values, line and material, texture, lighting, realism), plus a style-key image: an abstract swatch for faceless films, a character sheet for a recurring character.
- **One clip holds one location and one action.** Replace mood words ("cinematic", "stunning") with their visual causes.
- **Continuity across clips**: repeat the same 3-6 visual attributes of each person and place verbatim in every prompt; use reference images ("ingredients") of each character, place and prop.
- **First-and-last-frame** generation gives a controlled move between two approved stills; use it when a generated clip must join a designed scene, with the last frame matching the next scene so the join is a match cut. For a person's action, prefer a start frame only: on one film, clips given both a start and an end frame made the person jump to another place mid-clip, and start-frame-only clips were clean.
- **A reference image shows the clip's target look.** A frame from before a change (the earlier outfit, a door still open) pulls the clip back to that state; references of the approved outfit, the face or a prop are fine.
- **Timestamp prompting** puts 2-4 shots in one 8-second generation.
- Known limits: glasses and hands change between frames, on-screen text from the video model is unusable, characters drift across separate clips. Treat first generations as rehearsals.

## Higgsfield clips

Set `--aspect_ratio` to the film's format (16:9 for a wide film) unless the shot is cropped into a frame. Estimate cost first with `higgsfield generate cost` and the same flags, and check the balance before starting a batch with `higgsfield account status` (it prints to stderr, so don't discard stderr when reading it).

Living portrait from an approved still:

```bash
cd <project>/assets/video && higgsfield generate create seedance_2_0 --start-image ../images/<still>.png \
  --aspect_ratio 3:4 --duration 4 --resolution 1080p --generate_audio false --mode std \
  --prompt "Subtle living portrait. Locked-off camera, no camera movement, no zoom, framing stays exactly the same. <the person> stays in the same pose. <one small action: a slow breath, one natural blink, a slight nod, a small adjustment of what they hold>. Everything else unchanged."
```

Action clip (a person doing something, as in a live-action story ad), with the character's approved reference stills:

```bash
cd <project>/assets/video && higgsfield generate create seedance_2_0 --start-image ../images/<scene-still>.png \
  --image-references ../images/<character-front>.png --image-references ../images/<character-full>.png \
  --aspect_ratio 16:9 --duration 5 --resolution 1080p --generate_audio true --mode std --genre comedy \
  --prompt "<shot size, lens, camera>. <the character description, pasted word for word>. <one action, start to finish, saying who moves each object>. <the place>. <light>. Sound: only the natural sound of what is on screen, no speech, no music."
```

Download the result URL it prints into `assets/video/`. Check model names with `higgsfield model list` if the command fails. Keep a generation record in `assets/video/LEDGER.md`: model, prompt, start image, job id, and which seconds were used.

**Clip rules**
- 3-8 seconds, one simple action. Do camera pushes in the build, not in the clip, so overlays stay locked; in a live-action story ad, handheld movement or a follow may come from the clip (`types/live-action-story.md`).
- When a clip must join a designed scene, generate it with first and last frames so the join is a match cut.
- Each hero clip only needs 1-2 seconds on screen; trim in the build.

**Check every clip before using it,** and its start still against `build/continuity.json` before generating it (`build-and-qa.md`, Continuity sheets). Pull frames (one per 0.25 s) and look for: the face changing identity, hands or fingers warping or multiplying, props changing size or disappearing, objects passing through each other, framing drift, anything appearing before its cause, an object moving with nothing moving it. Video models also add their own camera cuts inside long clips: find them as spikes in the difference between one frame and the next (`ffmpeg -i clip.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep pts_time`), and use only takes, or parts of takes, without them. Regenerate rather than send a flawed clip with a note. Look at stills and clips full size, in motion, as a skeptical stranger would. If a shot comes back "looks fake" twice, recommend a different approach (a designed frame, a different shot) instead of a third try.

## Without Higgsfield

The prompting rules above and the clip checks below apply to any video model. What changes is who runs it.

- **Another clip tool with a command line** (the user names it in the brief): ask the user for the exact command or the tool's own help output; never guess flags. Run it from `assets/video/` and keep `LEDGER.md` the same way.
- **Another clip tool without a command line** (a web app): write each clip's prompt, start image and length into `assets/video/PROMPTS.md`, one block per clip, ready to paste. The user makes the clips and saves them into `assets/video/` under the names given. Then check every clip as below.
- **No clip tool**: the film moves through the build, not the footage.
  - Cut approved stills into two to four layers (subject, middle ground, background, made as separate images or separate generations) and move the camera through them in HyperFrames: a slow push, a short pan, parallax between layers.
  - Supplied or licensed footage fills shots that need real action.
  - A living-portrait moment without real action (a face holding, a look) becomes a still with a slow push, or a designed frame. A person doing something is never a still with a push: it reads as a slideshow.
  - Choose directions at stage 4 that work this way, and say which shots lose real motion.
- **When the proof needs real motion** (a product acting on a moving face, a physical process, a person doing the action the film is about, or any live-action story ad) and there is no clip tool, tell the user in the brief that the film can't show it as planned, and offer: supplied footage, a different proof, or getting a clip tool.

## Without Codex

Use the user's own photos, or images from another image tool the user runs: write each image's prompt into `assets/images/PROMPTS.md` from the brief rules above, and the user saves the files under the names given. Licensed stock is a last choice; avoid the stock tropes listed in the brief rules. Check every image full size before using it.

**Disclosure**: video models add invisible provenance marks, and some add visible ones. Tell the user, so clients aren't surprised.

## Logos

- **The brand's own logo**: the rule is in SKILL.md (Layout and look). Get the file from the client's SVG, or their site or press page; with no file yet, list it as an open question.
- **Tool logos** (integrations the product really has): official marks from Simple Icons (pin a version, for example `https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/<name>.svg`), the company's own brand or press page, or Wikimedia Commons (`https://commons.wikimedia.org/wiki/Special:FilePath/<File>.svg`). Some brands aren't in Simple Icons; get those from the company's site. Check that a name match is the right company.
- After downloading, confirm each file is really an image (some URLs return a web page) and search each SVG for `<script`, `onload=` and external `href`s before use.
- Don't recolor, stretch or crop official marks. Note the source of each in `assets/logos/SOURCES.md`.
- Before final, the user confirms each shown logo is a live integration and that each brand's rules are followed.
- **Media outlets**: never real names or logos. Invent outlets ("The Morning Pour", "Field & Table") and reporters, with Codex faces.
- **Model or vendor logos** (for example AI models a product offers): only those the product really provides, in their official color (some are black only).

## The cast

People are a brief decision: real-looking people, illustrated characters, hands only, or faceless. When people appear, keep a cast list in `direction-notes.md`: name, role, how they look, image files. Use the same face for the same name everywhere. Describe faces by what is visible (hair, clothing, expression, age range), not by naming features. Names on screen come from the script or the user's demo data; ask before using any real client name.

For full-frame generated portraits in brand films, see `types/brand-film.md` (one set, locked crop, short holds). Recaps of real events need real footage.

## Slowing a clip

Slow a clip only as far as its source frames allow. A 24 fps generated clip slowed to 0.5x shows each frame twice and looks choppy; a high-frame-rate camera clip does not. Before slowing, check the frame rate (`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate <clip>`): keep generated or 24-30 fps clips at 0.8x or faster, or generate the motion slower instead. After slowing, open the motion strip and look for repeated frames.
