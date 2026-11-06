# The Sound stage: making the sound

How to make a film's sound, step by step, chosen by the kind of film. The rules for what the sound should be (narration, music shape, which effects are allowed, silence, levels) are in `sound-and-voice.md`; this file is how to get there. Claude can't hear: every claim about a sound comes from the user, a measurement or a speech-to-text pass, and each report says which.

## Contents

- When it runs
- Choose the path
- Path A: live action
- Path B: motion design and app screens
- Music, for every film with music
- Where sounds come from, and their licences
- `assets/audio/SOURCES.md`
- What to report

## When it runs

The Sound stage runs beside stages 7-9, not after them:

1. **Stage 7 (motion spec):** plan the sound with the picture (`sound-and-voice.md`). Choose the path below. Once scene lengths are approved, write the music time map and the Suno prompts and send them to the user, so the tracks are back before the animated test. If the user supplies their own track instead, add its row to `SOURCES.md` with its licence and fit it the same way (Music, step 4 on). If no track is ready by the animated test, render the test without music, say so first, and fit the music for the next render.
2. **Stage 8 (animated test):** the test carries real sound, made the way its path says: clip sound for live action, placed effects for motion design, and the fitted music. Ask the user to listen for the sound as well as the movement.
3. **Stage 9 (full build):** the rest of the film's sound, then `sound_balance.py` from the stems (`build-and-qa.md`, Sound balance).

**Gate: the user listens and says the sound works.** A passing `sound_balance.py` is numbers, not a listen.

## Choose the path

| The film | Path | Where the sound comes from |
|---|---|---|
| Live-action story ad, or any film whose brief says its people's own sound and voices are heard | A: live action | the video model makes each clip's sound and the characters' lines; library effects only where that fails |
| Product launch, explainer, demo or tutorial, showcase, social short, event or data film built from motion graphics and app screens | B: motion design | music, narration when the brief has it, and a few real recorded effects from a library |
| A film of generated clips where nobody speaks (a brand film, b-roll) | A for each clip's own sound, kept low; B for the rest | the clips' natural sound as a quiet bed, music on top, effects rarely |
| A film cut from supplied footage (a recap, a brand film from a shoot) | B, with the footage's own sound | keep the footage's own sound where it matters (a speech, a crowd), music under it, library effects rarely |

A film can mix paths: a product launch with one live-action scene uses path A for that scene's clips and path B for the rest. Music, below, applies to every path.

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
5. **Library effects only where the clip's own sound fails and the edit pass (step 3) can't fix it,** which in practice means clicks and alerts on the product's screen. Hand-placed library footsteps and chair sounds never matched a person's movements (`types/live-action-story.md`); remake that clip's sound with step 3 instead. Take effects from the sources below and place each by hand on the frame of its event. Background people stay silent; the music carries them.

## Path B: motion design and app screens

1. **List the moments that make a real sound,** from the motion spec: usually only the one click or tap that matters, a message arriving on a phone, a machine on screen. No sound on text, lines arriving or the logo (`sound-and-voice.md`, Effects). Most motion-design films need fewer than five effects; many need none.
2. **Get real recordings** for those moments from the sources below. Never synthesize an effect: synthetic clicks were called weird choices on one film and were replaced with real trackpad recordings.
3. **Place each one on the frame of its event,** never before it. Trim any silence at the start of a library file first, or the sound lands late by that much. Keep the effects on their own stem (`build/audio/effects.wav`) with an events file (`build/audio/events.json`) marking which must be heard.
4. **Set levels by measurement** with `sound_balance.py`, not by fader.

**Narration**, when the brief has it (any path):

1. **Who voices it** is the user's decision at the brief: the user, a voice actor they hire, or a text-to-speech voice. For text-to-speech, describe the voice (age, pace, warmth), use no emotion tags, and ask for a relaxed, low-to-medium voice (`types/live-action-story.md` has what failed).
2. **Record it before scene lengths are fixed** in films led by narration (explainers, tutorials): each scene lasts as long as its sentence. Save it as `build/audio/voice.wav`, starting at 0:00 of the film.
3. **Get word times** with `whisper-cli -ml 1` (as in path A, step 4) and place picture changes at phrase breaks and each reveal on the word that names it (`sound-and-voice.md`, Narration).
4. **Add its row to `SOURCES.md`**: who voiced it, or the text-to-speech service and plan, and the date.

**Optional companion skill:** [real-sfx](https://github.com/Clipwing/skills/tree/main/skills/real-sfx) by Clipwing finds sound moments in a HyperFrames composition, a screen recording or the picture, picks real recordings from your own sound libraries, and places them on the exact frame. It works well for path B. Install it on its own from its repository if you want it; this skill doesn't include it and works without it. Its sounds come from your libraries, so each file still needs its line in `SOURCES.md`.

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

Download sounds into the project's own `assets/audio/` only. Never commit downloaded sound files to a public repository, and never bundle them with a skill or template: Mixkit's and Pixabay's licences forbid sharing the files on their own, and a repository is sharing them.

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

At stage 8 and every render after it: the path used, scene by scene where it differs; where each sound came from (clip, edit pass, library, music); what speech-to-text found in each clip with generated sound; each music piece's stretch and any off-bar cut; `SOURCES.md` complete or what is missing; `check_sources.py`'s result; and `sound_balance.py`'s numbers. Then ask the user to listen.
