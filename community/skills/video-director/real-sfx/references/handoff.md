# Handing the result to an editor

The skill's main result: a new MP4 and a separate WAV (`*_sfx_track.wav`, 48 kHz, 24 bit, the track starts at the video's
0:00). The WAV always sits next to it so it can be dropped into any project without re-encoding. Optionally:

- `--stems`: `*_stem_impacts.wav`, `_motion.wav`, `_interface.wav`, `_atmos.wav`, to remix the groups separately without
  rebuilding everything
- `--export-clips DIR`: each sound as its own WAV with the processing and loudness already applied, `sfx_clips.json` with
  timecodes, and `sfx_clips_hyperframes.html` (`<audio>` tags to paste)

Before calling another skill or a paid or installing tool, ask the user: name the skill and why it is needed. Local checks
need no question.

## The source was made in HyperFrames

**First check whether the project has its own event list** (`docs/cues.json`, `scripts/cues.json`): a project written for
a synthesized score usually keeps one, and then the `from_cues.py` path (SKILL.md, step 2) is more precise than anything
else: the event kinds are named, not guessed, and the script handles baked-in synthesis itself.

**No list: the moments come from the composition itself**, with no frame analysis and no render.
```
python scripts/from_hyperframes.py path/to/project --out work/moments.json [--video render.mp4]
python scripts/suggest_cues.py work/moments.json --out work/cues.json
```
`from_hyperframes.py` reads `data-start`/`data-duration` (including relative `intro + 2` and nested sub-compositions with
offsets added up) and the positions of GSAP tweens (numbers, `<`, `>`, `+=0.3`, labels). Scenes give `cut`, elements
appearing `onset`, fast moves `burst`; `hint` carries ids/classes/text, from which a uisfx signal is chosen. What it could
not parse it writes into `warnings` instead of guessing.

Then two options:
1. **Mix over the render** (as with any MP4): render, then `mix.py` with `video` = the render.
2. **Sounds inside the project** (survive a re-render, editable in Studio):
   `mix.py cues.json --out work/x.mp4 --export-clips work/clips`, then copy the `clips/` folder into `assets/sfx/` and
   paste the contents of `sfx_clips_hyperframes.html` into the root composition. The composition rules are kept: every
   `<audio>` has an `id`, identical tracks do not overlap (different `data-track-index`, starting at 20), loudness in
   `data-volume`. The processing (pitch, reverse, filters) is already baked into the files, because HyperFrames does not
   know such operations.
   **Remove the old `<audio ... src="assets/audio/sfx.wav">` (and transition tracks) from `index.html` if the project had a
   synthesized score:** otherwise the real sounds land on top of the synthesis and the doubling moves inside the project.
   Keep the voice and music (`voice.wav`, `music.wav`).
After pasting: `npx hyperframes check`, then `snapshot`, and `render` only with the user's consent. Fine-tuning loudness
and ducking inside the composition: the `hyperframes-audio` skill (ask before calling it).

## After Effects
Import `*_sfx_track.wav` (or the stems) into the project and put it as a layer in the root composition starting at 0.
Through the `after-effects` MCP: `run-script` with `app.project.importFile(new ImportOptions(File(path)))`, then
`comp.layers.add(footageItem)`. To edit sound by sound: `--export-clips` and `sfx_clips.json` (it has each clip's `start`
and `duration`).

## Premiere Pro
First `verify_premiere_connection`. Then use `search_tools` to find the tool for importing and placing on an audio track
(`import_media`, then the clip on A2 with zero offset) and put `*_sfx_track.wav` on a track above the main one. If one
sound per clip is more convenient, take `sfx_clips.json` (`file`, `start`, `duration`) and lay out the clips.

## MP4 only
Nothing is needed: the file is ready. The WAV can be handed over so the client can rebalance it themselves.
