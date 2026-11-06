# Sound already in the project: synthesis, stems, a synthesizer script

A project written for a synthesized score keeps music, voice and effects in one track file. Real sounds on top of it are
double sound. The task: remove **only** the synthesized effects layer and keep the music and voice as the author mixed
them (levels, the music ducked under the voice).

## What the project has → what the script does

`from_cues.py` looks for the project's audio (`assets/audio/stems`, `audio/stems`, `assets/audio`, `audio`, `assets`; the
root is taken from the list's folder, then from `--video`, or `--project FOLDER`) and classifies files by name: voice
(`voice`, `vo_track`), music (`music`, `bed`), the synthesized layer (`sfx`, `transitions`, `impacts`, `whoosh`...), a
finished mix (`final_mix`, `premix`, `mix_raw`). Then:

| What was found | What happens | What the output looks like |
|---|---|---|
| The synthesized layer as a separate file (`sfx.wav`, `transitions.wav`) | **`unbake`**: the mix minus the stem. Source: the render or, if the project keeps the same mix lossless (`final_mix.wav`), that file. The gain is found by least squares, the delay to the sample (a stem can lag: an AAC render by one codec frame, 21.3 ms). Music and voice stay **with the author's levels and ducking**. A mono stem is taken as is (3 dB used to be lost) | `unbake: mix final_mix.wav minus sfx.wav (+2.2 dB) ... correlation 0.43 -> -0.00` |
| What is left after subtraction is quieter than −60 dBFS | the render was that layer: the base is empty, `keep_audio: no` | `what is left is silent: the render's audio WAS the synthesized layer` |
| The same, but the render lacks this layer (no correlation) or the stem has another length | refused, the reason named (stems from another version) | `unbake: not possible (...)` + `WARN stems ... do NOT belong` and a list of the project's renders the stems fit |
| The mix went through a fast limiter or compressor (the synthesis envelope remains after subtraction) | refused: one multiplier does not follow a limiter; if the render is synthesis only, `keep_audio: no`, otherwise a rebuild from stems or the script | `unbake: not possible (... the mix is limited or compressed ...)` |
| Only voice and music stems (no effects stem) | the base is rebuilt from the stems; levels are fitted by the loudness shape, not taken as one; a stem that is not in the mix (an old `bed.wav`) is dropped | `stems: ... belong to this render`, `levels that fit: {...}` |
| Music and effects are synthesized by **one script** (`audio.cjs`), no separate files | `from_synth.py`: the script runs without writing files, a second run with the effects off gives the music without them (`_synth/bed_only.wav`); the base = that + the voice file, levels fitted in the voice's pauses, the music ducks under the voice (`--duck-music`) | `events from the project's synthesizer script ...`, `rebuilt from that script WITHOUT the effects` |
| **Effects placed inside the music stem** (a riser, a bell, a drone on the music bus: `music.wav` contains them) | the music stem keeps them: real risers would land on top. Make a file with only those effects (run the score twice: once with the effects, once with those calls sent to a "trash" bus, without changing the random number sequence; the difference of the two `music.wav` files) and pass `--extra-synth FILE`: it is subtracted the same way as `sfx.wav` | the correlation of `music.wav` with the riser after unbake stays well above zero; risers are visible in the stem's spectrogram |
| None of this: the render's track is synthesis plus voice, no stems and no script | said honestly; `NOTE: could not hear` or `BAKED`. Ask for a render without effects, the voice and music files (`mix.py --base-audio music.wav:-7 vo.wav --duck-music`) or the script; if the whole track is synthesis: `--drop-original` (in this case `from_cues` writes `keep_audio: no` itself if the render is quiet between events) | `BAKED`, `NOTE: ...` |

After the build the mixer prints what the base became (`base audio rebuilt ... (the synthesized layer was subtracted ...
| rebuilt from the project's script WITHOUT the effects, levels fitted | rebuilt from the project's stems)`) and warns if
the base was raised by more than 1.5 dB "to match the original" (`WARN the rebuilt base was moved ...`): that means voice
and music moved relative to each other; check the levels (`--base-audio FILE:dB`). Even when the list did not come from
`from_cues` (frames, `suggest_cues`), `mix.py` compares the original with the cue times and warns that synthesis sits
under them (`the original audio has a sound at N% of the cue times`).

**What the sheet holds for the base.** `base_audio` is a list of files or objects `{"file", "gain_db", "offset",
"keep_level", "key_only"}`: `keep_level` does not pull the base's loudness to the original (it was subtracted, not
rebuilt), `key_only` means the stem is not heard, it only drives the ducking (`voice_key`). `from_cues` writes these fields
itself; to lay in your own base: `sheet.py top SHEET 'base_audio=[{"file":"D:/p/music.wav","keep_level":true}]'
duck_music=false`. `mix.py --base-audio` knows only `FILE[:dB][@sec]` and loses `key_only`.

## An event list without a list file

If the project does not write `cues.json` but a script makes the sound, the events are in it: calls like
`whoosh(4.2, 1, 0.3, 0.5)`, `click(18.35)`, `key(t, i)` or objects `cues.push({t, type, gain, len})`. Do not extract them
by hand:

```
python scripts/from_synth.py PROJECT_FOLDER --out work/events.json [--bed-only work/bed.wav] [--dry]
python scripts/from_cues.py PROJECT_FOLDER --video RENDER.mp4 --out work/cues.json     # the same in one step
```
The script is found in the `scripts/`, `audio/` folders; functions with time as the first argument (`t`, `time`, `at`,
`start`) and no generator parameter are recorded; helpers (an `add` that every effect calls) and functions that return a
number (a loudness curve) are not events. Numeric arguments `f`/`freq`/`hz` and the `up` flag are recorded too: the
author's frequency intervals become the replacement's pitch steps. File writing and process launching inside the script
are disabled, the project is not changed. An ES module (`.mjs`) does not run; if a list sits next to it
(`scripts/cues.json`), `from_cues` on the folder takes it: a list beats a script. The output names the kinds and counts
(`click x101, whoosh x16`): check them against what you see in the frame. A run of `click` 62 ms apart in a project is
often typing (a comment in the script says so): `from_cues` recognizes such a run itself (`typing:`).

**Time in the list.** A script often converts "author time" to "film time" (`W(t)`, `timing.json`), and the recorded times
are author time. `from_cues` takes the project's map (`assets/timing.json`: `anchors` or `DUR` + `WARP`, pairs
`[film_time, author_time]`, its own monotonic cubic curve) when the script reads it. Otherwise: a map from the stems'
onsets (`references/typed-cues.md`). The time of a whoosh in a script can be its **start, peak or centre**: `from_cues`
moves it to the peak of the synthesized sound only if that is not another sound (a pop, a bell at the same moment) and
there is no loudness dip on the way; a refusal is printed with the reason (`retime: ... NOT moved ...`).

## The loudness of the replaced layer and the author's chain

`from_cues` measures the loudness of the synthesized layer as it sat in the mix (`_draft.layer_lufs`), and `mix.py` raises
the real SFX to it (`SFX layer: ... -> +N dB`): the author mixed "quiet and sparse" (g 0.07–0.3), and without this
everything would sit at −30 dBFS. Only upward. `--no-match-layer` or `--sfx-trim-db X` turn it off. Then `levels.py`
compares event by event (each kind against the author's layer) and writes edits for `sheet.py apply`.

**The author's mix chain.** A rebuild from the script or stems does not know it: `--duck-music` (threshold 0.04, ratio 4,
15/350 ms) does not repeat the `sidechaincompress` and limiter from the project's `scripts/mix.sh`: the music under speech
may sit 1–2 dB differently. If the project has a `mix.sh` or an ffmpeg graph: run `bed_only.wav` and the voice through the
same graph without the effects, put the result into `base_audio` (`keep_level: true`) and remove `duck_music`. The final
loudness of such a base is pulled to the original by itself (the original's peak ceiling is kept).

## Rules

- Stems cannot be trusted by name: length and loudness shape are checked. Stems from a late edit with a render from an
  early one give `do NOT belong`; voice the render they fit (the script names it).
- The project has a voice but this render does not (`listen.py voice RENDER`): another version of the film. Tell the user
  that "keep the voice" has nothing to act on here.
- Tonal music: the pitch steps of uisfx and of the library's tonal sounds turn off by themselves when the render has 30 %
  or more music or there is a score (`bed_only.wav`, a music stem); pitches are tuned to its notes (`tonal fit`).
- Checking that "the synthesis is gone": the critique's `doubling` axis (the correlation of the layer with the original
  and with the new film; about zero) and the `unbake` numbers (before and after). An AAC codec residue around events
  (−15…−25 dB from the synthesis peak) is possible if the source is the render itself (an MP4 has no lossless mix); it
  is not heard under music and voice.
- Start time: a stem from an AAC render lags by 21.3 ms (one codec frame); the new MP4's sound is exactly on the timeline.
