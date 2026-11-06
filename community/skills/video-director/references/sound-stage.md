# The Sound stage: making the sound

How to make a film's sound, step by step, chosen by the kind of film. The rules for what the sound should be (narration, music shape, which effects are allowed, silence, levels) are in `sound-and-voice.md`; this file is how to get there. Claude can't hear: every claim about a sound comes from the user, a measurement or a speech-to-text pass, and each report says which.

## Contents

- When it runs
- Choose the path
- The sound plan
- Path A: live action
- Path B: motion design and app screens
- Sound engineering: placing effects with real-sfx
- Music, for every film with music
- Where sounds come from, and their licences
- `assets/audio/SOURCES.md`
- What to report

## When it runs

The Sound stage runs beside stages 7-9, not after them:

1. **Stage 7 (motion spec):** plan the sound with the picture (`sound-and-voice.md`). Choose the path below and write the sound plan (below). Once scene lengths are approved, write the music time map and the Suno prompts and send them to the user, so the tracks are back before the animated test. If the user supplies their own track instead, add its row to `SOURCES.md` with its licence and fit it the same way (Music, step 4 on). If no track is ready by the animated test, render the test without music, say so first, and fit the music for the next render.
2. **Stage 8 (animated test):** the test carries real sound, made the way its path says: clip sound for live action, effects placed by Sound engineering (below) for the test's scenes, and the fitted music. Ask the user to listen for the sound as well as the movement.
3. **Stage 9 (full build):** Sound engineering for the whole film, then the mix from stems and `sound_balance.py` (`build-and-qa.md`, Sound balance). Each polish round that moves the picture runs Sound engineering again from step 2, so every sound follows its event.

**Gate: the user listens and says the sound works.** A passing `sound_balance.py` is numbers, not a listen.

## Choose the path

| The film | Path | Where the sound comes from |
|---|---|---|
| Live-action story ad, or any film whose brief says its people's own sound and voices are heard | A: live action | the video model makes each clip's sound and the characters' lines; library effects only where that fails |
| Product launch, explainer, demo or tutorial, showcase, social short, event or data film built from motion graphics and app screens | B: motion design | music, narration when the brief has it, and a few real recorded effects from a library |
| A film of generated clips where nobody speaks (a brand film, b-roll) | A for each clip's own sound, kept low; B for the rest | the clips' natural sound as a quiet bed, music on top, effects rarely |
| A film cut from supplied footage (a recap, a brand film from a shoot) | B, with the footage's own sound | keep the footage's own sound where it matters (a speech, a crowd), music under it, library effects rarely |

A film can mix paths: a product launch with one live-action scene uses path A for that scene's clips and path B for the rest. Music, below, applies to every path.

## The sound plan

At stage 7, write `build/audio/sound-plan.json` from the motion spec: one entry for every moment that makes a sound, in any path, and nothing else. It is what the effects are made from and checked against, so a sound that isn't in it doesn't go in the film.

```json
[{"t": 7.25, "label": "calendar ding", "type": "chime", "hear": "must-hear"},
 {"t": 21.15, "label": "click: Best Light in the Dock", "type": "click", "hear": "must-hear"},
 {"t": 15.1, "label": "shirt flick and rustle", "type": "cloth", "hear": "texture", "source": "clip", "len": 4.5}]
```

- `t`: film seconds, the first frame of the event (from the composition's own times where it has them: a press at 0.9 s in a scene starting at 20.25 s is 21.15).
- `label`: what happens on screen. It names the sound in every report and in `SOURCES.md`.
- `type`: real-sfx's kind of event (click, pop, chime, success, hit, thump, whoosh, key, and their synonyms: the real-sfx skill's `references/typed-cues.md`).
- `hear`: `must-hear` (the ding, the click that matters) or `texture` (a rustle, steps, a room).
- `source`: `library` (the default: placed by Sound engineering), `clip` (the clip's own sound, path A) or `none` (a moment kept silent on purpose).
- Once the user has heard and approved a recording for a moment: `file` (its full path), and as needed `role`, `slice`, `gain_db`, `pitch`, `fade_in`, `fade_out` (`scripts/sound_handoff.py` lists them). Every later run then uses that recording at that level.

Show the user the plan with the motion spec, as a list of moments and where each sound comes from.

## Path A: live action

The lessons behind these steps, and what failed, are in `types/live-action-story.md` (Sound and voices from the clips). Read that section first; this is the order of work.

1. **Make every person clip with its sound on.** This is `media.md`'s action-clip command with the sound switched on and a sound line ending the prompt; steps, the chair, the door and clothes then land on the picture because they come from it:

   ```bash
   cd <project>/assets/video && higgsfield generate create seedance_2_0 --start-image ../images/<scene-still>.png \
     --image-references ../images/<character-front>.png --image-references ../images/<character-full>.png \
     --aspect_ratio <the film's shape, e.g. 16:9> --duration 5 --resolution 1080p --generate_audio true --mode std --genre comedy \
     --prompt "<shot size, lens, camera>. <the character description, pasted word for word>. <one action, start to finish, saying who moves each object>. <the place>. <light>. Sound: only the natural sound of what is on screen, no speech, no music."
   ```

   Leave out `--genre comedy` for a film that isn't a comedy. For a clip where the character speaks, put the line in quotes in place of "no speech" (step 2).
2. **Spoken lines come from the video model, on the character's own clip,** not from a text-to-speech service. Put the line in quotes in that clip's prompt, with how it is said ("one short line, said once, relaxed, low-to-medium voice"). ElevenLabs voices were rejected on one film: too high, too eager, and a "[cheerful]" tag made them laugh first. If text-to-speech can't be avoided, use no emotion tags.
3. **To add sound to a clip that is being kept** (made silent, or its sound is wrong), run Seedance 2.5's edit mode on it and keep only the audio:

   ```bash
   higgsfield generate create seedance_2_5 --mode video_edit --video-references assets/video/<clip>.mp4 \
     --duration <clip seconds> --resolution 720p --aspect_ratio <the clip's shape, e.g. 16:9> --generate_audio true --wait \
     --prompt "Keep this video exactly as it is: the same person, the same framing, the same timing and every movement unchanged. Only add sound. <what is heard, from what is on screen>. No music, no other voices."
   ffmpeg -i <edited>.mp4 -vn -c:a pcm_s16le assets/audio/<clip>-sound.wav
   ```

   If the command fails, confirm the edit model's name with `higgsfield model list`. Estimate the cost first (`higgsfield generate cost` with the same flags). Check the sound lines up with the picture by motion (on one film it was within 0-2 frames); if it is off, shift it, don't regenerate blindly.
4. **Check what every generated sound track says** with whisper.cpp, since takes add words nobody asked for (a "Hi", the line said twice):

   ```bash
   ffmpeg -i assets/video/<clip>.mp4 -ar 16000 -ac 1 build/audio/<clip>-16k.wav
   whisper-cli -m <models>/ggml-tiny.en.bin -f build/audio/<clip>-16k.wav -ml 1 -oj -of output/words-<clip>
   ```

   The tiny English model is one download from the whisper.cpp releases (`models/download-ggml-model.sh tiny.en` in its repository). `-ml 1` gives one word per segment with its start and end time, so an extra word can be cut out by time. Report what each clip says. If `whisper-cli` isn't installed, say the words weren't checked.
5. **Library effects only where the clip's own sound fails and the edit pass (step 3) can't fix it,** which in practice means clicks and alerts on the product's screen, and an added sound such as a bleep over a swear. Hand-placed library footsteps and chair sounds never matched a person's movements (`types/live-action-story.md`); remake that clip's sound with step 3 instead. Give those moments `"source": "library"` in the sound plan (the clip moments stay `"clip"`) and place them with Sound engineering, below; the clips' own sound stays in its own stem. Background people stay silent; the music carries them.

## Path B: motion design and app screens

1. **List the moments that make a real sound** in the sound plan (above): usually only the one click or tap that matters, a message arriving on a phone, a machine on screen. No sound on text, lines arriving or the logo (`sound-and-voice.md`, Effects). Most motion-design films need fewer than five effects; many need none.
2. **Make and place them with Sound engineering** (below): real recordings from the user's sound library, each on the frame of its event, on their own stem (`build/audio/effects.wav`) with an events file (`build/audio/events.json`) marking which must be heard. Never synthesize an effect: synthetic clicks were called weird choices on one film and were replaced with real trackpad recordings.
3. **Set levels by measurement** with `sound_balance.py`, then by the user's ears, not by fader.

**Narration**, when the brief has it (any path):

1. **Who voices it** is the user's decision at the brief: the user, a voice actor they hire, or a text-to-speech voice. For text-to-speech, describe the voice (age, pace, warmth), use no emotion tags, and ask for a relaxed, low-to-medium voice (`types/live-action-story.md` has what failed).
2. **Record it before scene lengths are fixed** in films led by narration (explainers, tutorials): each scene lasts as long as its sentence. Save it as `build/audio/voice.wav`, starting at 0:00 of the film.
3. **Get word times** with `whisper-cli -ml 1` (as in path A, step 4) and place picture changes at phrase breaks and each reveal on the word that names it (`sound-and-voice.md`, Narration).
4. **Add its row to `SOURCES.md`**: who voiced it, or the text-to-speech service and plan, and the date.

## Sound engineering: placing effects with real-sfx

Every library effect, in either path, is made here. The work is done by [real-sfx](https://github.com/Clipwing/skills/tree/main/skills/real-sfx) by Alexander Korbanov at Clipwing (MIT), kept as this skill's own copy: `<real-sfx>` below is its folder, `<skill>/real-sfx`. It picks real recordings from the user's own sound library, places each on its frame and writes the effects track. This skill decides which moments get a sound, checks each pick, sets the levels against the music and keeps the sources list; real-sfx's own `SKILL.md` is needed only for options this section doesn't cover.

**Set it up once per machine.** Its settings and what it learns go in `~/.config/real-sfx/`, never in its folder: the plugin installs each version of this skill in a new folder, so anything written there is left behind on the next update.

```bash
mkdir -p ~/.config/real-sfx/styles
cat > ~/.config/real-sfx/env.sh <<'SH'
export REAL_SFX_CONFIG="$HOME/.config/real-sfx/config.json" REAL_SFX_INDEX="$HOME/.config/real-sfx/library_index.json"
export REAL_SFX_TASTE="$HOME/.config/real-sfx/taste.json" REAL_SFX_RATINGS="$HOME/.config/real-sfx/taste_ratings.json"
export REAL_SFX_STEADY="$HOME/.config/real-sfx/ambience_steady.json" REAL_SFX_STYLES="$HOME/.config/real-sfx/styles"
SH
. ~/.config/real-sfx/env.sh
python3 <real-sfx>/scripts/setup.py init --library main="<the user's sound folder>" --index
python3 <real-sfx>/scripts/setup.py check
```

Run `. ~/.config/real-sfx/env.sh` in every shell that runs its scripts, and never use its `--remember` option (it writes into its folder). Ask the user where their sounds are; never point it at a folder they haven't named. The library is a folder of its own outside the project and outside any repository (on one film, `sfx-library/` beside the project folders); only the recordings a film uses are copied into its `assets/audio/effects/` (step 7). With no sound library yet, ask them to download recordings for the planned moments into such a folder first (sources below). The library's own `SOURCES.md` (one row per file with its licence) lets step 7 fill the project's rows. It needs ffmpeg with the `drawtext` and `rubberband` filters (on macOS, Homebrew's `ffmpeg-full`, first in `PATH`), and numpy for some of its scripts.

**The steps,** from the project folder, with real-sfx's working files in `build/audio/sfx/`:

1. **The plan.** `build/audio/sound-plan.json`, written at stage 7 (The sound plan, above).
2. **Hand over the plan:**

   ```bash
   python3 <skill>/scripts/sound_handoff.py events build/audio/sound-plan.json --out build/audio/sfx/events.json --duration <film seconds>
   ```

   It writes the library moments as real-sfx's event list. It flags (exit 2) a sound on text or the logo, a kind real-sfx doesn't know, a named recording for a typing run (name it with `from_cues.py --kind key=slices:<ids>` instead), and more than five library effects. Answer each line: change the plan, or tell the user. The plan's times are final film times: after a retime, move every `t` through the map (`build-and-qa.md`, Retiming) before running this again.
3. **Place them:**

   ```bash
   python3 <real-sfx>/scripts/from_hyperframes.py build/ --out build/audio/sfx/hf-moments.json --video output/cut-v3-silent.mp4
   python3 <real-sfx>/scripts/from_cues.py build/audio/sfx/events.json --video output/cut-v3-silent.mp4 --out build/audio/sfx/cues.json \
     --ui library --no-stems --moments build/audio/sfx/hf-moments.json
   python3 <skill>/scripts/sound_handoff.py pins build/audio/sound-plan.json --cues build/audio/sfx/cues.json --out build/audio/sfx/pins.json
   python3 <real-sfx>/scripts/sheet.py apply build/audio/sfx/cues.json build/audio/sfx/pins.json
   ```

   `output/cut-v3-silent.mp4` is the HyperFrames render before any sound is added; if the render has sound, make a silent copy first (`ffmpeg -i output/cut-v3.mp4 -an -c:v copy output/cut-v3-silent.mp4`). `from_hyperframes.py` reads every scene start and move out of the composition; `from_cues.py` then lists the strong picture moments that have no planned sound. Most are cuts and moves, which stay silent here. If one is a real thing on screen making a sound, ask the user before adding it to the plan. Read its `routes:` line and any "NOT mapped" kinds. `pins` and `sheet.py apply` put the plan's labels back (real-sfx names cues by kind) and pin the recordings the plan names, with the kind's role and the recording's own pitch; a planned moment real-sfx left quiet is reported, not pinned.
4. **Check every pick before anything is rendered:**

   ```bash
   python3 <real-sfx>/scripts/mix.py build/audio/sfx/cues.json --out build/audio/sfx/result/fx.mp4 --plan --no-loudnorm
   ```

   Read the table: each file must fit its moment. Automatic picks can't be trusted with a small library: on one film they put a pop sound on a censor bleep, a censor beep and a 2.5 s bell on people joining a call, and swapped the calendar ding with the call's join chime, because those kinds share one role and real-sfx varies its picks across a film. A library file named only by a number isn't recognized by role (four trackpad clicks were indexed as "misc"), so search by folder or name (`<real-sfx>/scripts/search.py --query <words>`). Where a pick doesn't fit, write the right recording into the plan (`file`, and `role`, `slice` as needed) and go back to step 2. A `WARN slice ... holds two hits` means the piece holds two sounds: shorten it or ask the user.
5. **Render the effects track:** the same `mix.py` command without `--plan`. `--no-loudnorm` keeps each sound at real-sfx's level for its role; the mix sets the film's loudness (step 8).
6. **Check the timing:** `python3 <real-sfx>/scripts/verify.py build/audio/sfx/result/fx_resolved_cues.json build/audio/sfx/result/fx_sfx_track.wav` measures where each sound really lands. Any sound off its moment, or a clipping track, is fixed before going on.
7. **Bring it back:**

   ```bash
   python3 <skill>/scripts/sound_handoff.py collect build/audio/sound-plan.json --resolved build/audio/sfx/result/fx_resolved_cues.json \
     --track build/audio/sfx/result/fx_sfx_track.wav --fps <the film's frame rate>
   python3 <skill>/scripts/check_sources.py assets/audio
   ```

   It copies the effects track to `build/audio/effects.wav` and writes `build/audio/events.json` from the plan's `hear` column, at the times real-sfx placed them. It copies every recording real-sfx used into `assets/audio/effects/` and adds its `SOURCES.md` row, with the source and licence taken from the library's own `SOURCES.md`; a uisfx cue's row reads CC0, any use. It flags (exit 2) a planned moment left quiet, a sound nobody planned (not copied and given no row), a sound more than one frame off its planned time, and a row with no licence. A different recording with the name of one already in `effects/` gets its folder's name in front. Fix each flag, or tell the user.
8. **Mix and measure.** Build the mix from stems and run `sound_balance.py` (`build-and-qa.md`, Sound balance). Put the effects stem's gain in the mix graph (on one film the approved effects sat 12 dB above real-sfx's track) and change one sound's level with `gain_db` in the plan, so the next run keeps it. For clicks and pops (under about 0.3 s), `sound_balance.py`'s 0.4 s window reads far lower than a click sounds: on one film the five trackpad clicks the user approved measured 8-32 dB under the music, flagged "buried" or "missing". Don't raise a short sound just to clear that flag; report its number and ask the user whether they hear it. A short sound flagged as sticking out is real.
9. **The user listens.** Send the render with each planned moment, its time and its number from step 8. real-sfx's own `critique.py` and listening page are extra evidence, never the verdict: on one film its critique scored the first effects pass 9.6-10 on every point but loudness, and the user called it awful (too many sounds, too loud, footsteps that didn't match the steps on screen). When the user approves a sound, write its recording and level into the plan (`file`, `role`, `slice`, `gain_db`, any fades). On that film, a plan carrying the approved picks rebuilt the approved effects track sample for sample.

**What this skill changes in real-sfx's defaults,** and why:

| real-sfx on its own | Here |
|---|---|
| Finds the moments itself (from the composition, the picture or a screen recording) and sounds most of them | Only the planned moments; its own list of moments is a check for missed sounds, never a source |
| Interface sounds from its bundled uisfx pack (made by synthesis) | `--ui library`: real recordings first. Use uisfx only when the library has nothing that fits and the user has heard it and agreed |
| A small-sound layer (`texture.py`) and a dark bed (`bed.py`) under an effects-only film | Neither, unless the user asks: music or the clips' sound carries the film |
| The film's loudness set to -14 LUFS | `--no-loudnorm`; loudness is set in the mix with the music and voice |
| A new MP4 with its sound | Only the effects track and the resolved cues are used; the film is mixed from stems |
| Its critique and listening scores | Extra evidence; `sound_balance.py`, `check_sources.py` and the user's ears decide |
| Remembers kinds and taste in its own folder | Its settings, index and taste live in `~/.config/real-sfx/`. A style learned with its `learn_style.py` is still written into its folder: copy it into `~/.config/real-sfx/styles/` |

**What its outputs become:**

| real-sfx writes | Becomes |
|---|---|
| `fx_sfx_track.wav` (effects only, 48 kHz, from 0:00) | `build/audio/effects.wav`, the effects stem |
| `fx_resolved_cues.json` (each sound's file, time and level) | `build/audio/events.json` (with the plan), the timing check, and the `SOURCES.md` rows |
| each recording it used | a copy in `assets/audio/effects/` |
| `fx_cue_report.md` | read at step 4 and kept in `build/audio/sfx/` |

## Music, for every film with music

1. **Write what the film needs from the track,** as a time map from the approved scene lengths: what happens in each stretch and what the music should do there (small and sly, a busy scramble, a clear lift into something bright, settle and end on one clean note), plus every dead stop and every spoken line the music dips under. Stops and the timing to each scene are done in the edit, not in Suno: say so to the user.
2. **Write 3-4 Suno prompts that differ in kind** (instruments and genre, not just mood words). Each one: "instrumental", the instruments, a tempo, the shape the film needs in order, a steady beat throughout, "ends on a single clean note", "no vocals". `../assets/music-prompts-example.md` is a worked example.
3. **Tell the user how to make them:** in Suno, choose Custom, switch Instrumental on, paste one prompt into the Style box, leave the lyrics empty, and make two of each. Tracks must be longer than the film (at least 1.4 times, so over about 70 s for a 50 s film) so there is room to cut. **For an ad or any paid use, the tracks must be made on a paid Suno plan**: songs made on the free plan can't be used commercially. Use the account of whoever owns the film.
4. **Find the bar lines** of each track the user likes: `aubio beat <track>.wav > build/audio/<track>-beats.txt` or librosa's `beat_track` (`tools.md`). These are beats: `fit_music.py` takes every fourth one (`--beats-per-bar 4`; 3 for a waltz) from a bar's first beat (`--first-bar`). You can't hear whether that guess is right, and a wrong one moves every bar line: run `fit_music.py <track> --bars <beats> --beats-per-bar 4 --first-bar <seconds> --clicks build/audio/<track>-bar-clicks.wav`, send the file to the user, ask whether every tick falls on the first beat of a bar all the way through, and write their answer in the build log. Fit only on bar lines the user confirmed. Find the lifts, builds and the ending by where the loudness changes. A Gemini map of the track's sections helps you find your way, but its times are approximate: check every time it gives against the measurement.
5. **Write the plan and fit the track** with `scripts/fit_music.py`: pieces cut on bar lines, each placed at a film time so the track's lifts land on the film's big moments and its own ending lands on the logo, each stretched 3% or less, with dips (about -8 dB) under spoken lines and gaps for dead stops.

   ```bash
   python3 <skill>/scripts/fit_music.py assets/audio/<track>.wav --plan build/audio/music-plan.json \
     --bars build/audio/<track>-beats.txt --beats-per-bar 4 --first-bar <seconds> --out build/audio/music.wav
   ```

   It reports each piece's stretch and any cut off a bar line, and exits 2 when something needs review. Fix the plan rather than accepting an off-bar cut, unless the user heard it and approved it.
6. **Record the track** in `SOURCES.md`: the Suno account and plan, the date, the prompt, and which seconds were used.

## Where sounds come from, and their licences

Download sounds into the user's sound library folder (Sound engineering, above) or the project's own `assets/audio/`, never into a repository. Never commit downloaded sound files to a public repository, and never bundle them with a skill or template: Mixkit's and Pixabay's licences forbid sharing the files on their own, and a repository is sharing them. The uisfx pack inside the real-sfx skill is CC0, which is why it can ship with this plugin.

| Source | What it has | What its licence allows |
|---|---|---|
| [Freesound](https://freesound.org/) | a very large library of real recordings by many people | each sound has its own licence. Filter the search to CC0 (no credit needed, any use). CC BY needs a credit in the film's credits or description. CC BY-NC can't be used in an ad or any paid work |
| [BigSoundBank](https://bigsoundbank.com/) | real recordings by Joseph Sardin (trackpad clicks, doors, household sounds) | CC0: any use, no credit needed |
| [Mixkit](https://mixkit.co/free-sound-effects/) | short effects and interface sounds | Mixkit Sound Effects Free License: commercial use, no credit needed; the files can't be shared or sold on their own |
| [Pixabay](https://pixabay.com/sound-effects/) | effects and everyday recorded sounds from many uploaders | Pixabay Content License: commercial use, no credit needed; the files can't be shared or sold on their own |
| Suno | music made from your prompts | made on a paid plan: commercial use; made on the free plan: no commercial use |

Licences change: read the licence page on the day of download and record what it said.

## `assets/audio/SOURCES.md`

Every project keeps `assets/audio/SOURCES.md`, with one row for every sound and music file in `assets/audio/`, written when the file is downloaded or made. No file goes into a render without its row: `scripts/check_sources.py assets/audio` fails on any file without a row, any row without a file, and any row with an empty licence. Columns:

| File | Source | Page or id | Made by | Licence, and what it allows | Downloaded | Used for |
|---|---|---|---|---|---|---|
| `effects/<file>` | the site | the sound's page or item number | the uploader or recordist | licence name: commercial use? credit needed? may the file be shared? | date | the moment in the film |

Add a line at the top saying the files stay in this project and are never committed to a public repository. List any CC BY credits the film's description must carry.

## What to report

At stage 8 and every render after it: the path used, scene by scene where it differs; where each sound came from (clip, edit pass, library, music); for library effects, the plan against what was placed (`sound_handoff.py collect`: planned, placed, quiet, unplanned, off its frame), which picks were automatic and which the user chose, and `verify.py`'s result; what speech-to-text found in each clip with generated sound; each music piece's stretch and any off-bar cut; `SOURCES.md` complete or what is missing; `check_sources.py`'s result; and `sound_balance.py`'s numbers, with short sounds marked as measured low by its window. Then ask the user to listen, moment by moment.
