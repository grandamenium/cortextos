# Sound and voice

Sound is planned with the picture in the motion spec, not added at the end; how to make it, by kind of film, is in `sound-stage.md`. One coherent sound system per film: a score language, an emotional arc, an ambient bed, effects only where a real thing on screen makes a sound, and a voice direction.

## Narration

- Narration on or off is the user's explicit decision in the brief.
- About 2.5 words per second for promos and explainers (about 150 words a minute for tutorials). The script is shorter than the video.
- About 20-24 words per 10-second block, one thought per sentence. Write numbers as they are spoken.
- Narration adds context and judgment; it doesn't read the interface aloud or repeat the on-screen line.
- Picture changes land at phrase boundaries; a piece is revealed when the voice names it.
- In tutorials, the camera starts moving about 0.7 s before the sentence naming the target, and about 1 s of pause comes before a new idea.
- Keep narration separate from any generated clip's audio. Clip prompts ask only for the natural sound of what is on screen, no speech or music, unless the type file says otherwise.
- Clean studio voice by default. Describe the voice (age, pace, warmth) rather than naming a real person.
- Voices of on-screen characters in live-action films: `types/live-action-story.md` (Sound and voices from the clips).

## Music

- Music, or a bed under the voice, carries the whole film. Quiet only on purpose: a held product shot, a live-sound opening, a joke beat, the end card.
- Shape the music to the edit: build, thin out under the proof, hit the turn, end cleanly. One loop at one level is "sound as wallpaper".
- Build by adding layers or cut density, not by getting louder.
- Plan at least one quiet moment tied to something on screen (the music stops for a claim, or drops to silence at a limit).
- Dip the music under spoken lines (about 8 dB) rather than stopping it.
- **Fit the track to the picture on its bar lines.** Find the track's own lifts, builds and ending, and cut it into pieces on bar lines so each lift lands on a big moment of the picture (a shove, the product's turn, the call opening) and its own ending lands on the logo. Stretch each piece 3% or less, so the tempo change can't be heard. On one film this was the first music the user said fit the action; three tracks fitted only by their start, one stop and their ending had not.
  - Measure the bar lines with a beat tracker (`aubio beat`, or librosa's `beat_track`; `tools.md`) and find the lifts by where the loudness changes. A Gemini map of the track's sections helps you find your way, but its times are approximate (its "brass hit at 43.1 s" was really at 47.7 s): check every time it gives against the measurement.
  - When the user makes the music in Suno from your prompts: instrumental, on a paid plan for ads, and tracks longer than the film (over about 70 s for a 50 s film) so there is room to stitch. Prompts, bar lines and `fit_music.py`: `sound-stage.md`, Music.
- Motion-graphics films with a strong beat can lock chapter changes to 8-beat blocks; footage films cut on speech and action over a steady bed.
- No copyrighted songs or "trending audio". Use an original or licensed track and record its source, licence and the seconds used in `assets/audio/SOURCES.md` (`sound-stage.md`).

Starting points by tone:

| Tone | Tempo | Instruments |
|---|---|---|
| Matter-of-fact | 88-100 BPM | soft piano |
| Technical | 90-105 | analog pulse |
| Warm | 92-108 | felt piano, acoustic guitar |
| Energetic | 110-128 | synth bass, tight kit |
| Premium | 84-100 | strings, piano, sparse percussion |
| Playful | 105-120 | marimba, pizzicato |
| High-stakes | 80-96, or none | |

Corporate ukulele, claps and whistling only when they truly fit the brand.

## Effects

- No effects by default.
- Use real recordings with a reusable licence (sources and what each licence allows: `sound-stage.md`), placed with Sound engineering there, a different one each time: real trackpad clicks (BigSoundBank, CC0) replaced synthetic interface clicks the user called weird choices.
- If used, an effect is the sound of a real thing on screen (a machine, a game, a phone receiving a message), or a click on the one press that matters in a UI film. It lands on the frame of the event, never before. Its level is set by measurement (Measuring the balance, below), not kept under the music by rule.
- Never a sound on text, a line arriving, or the logo. When the music has its own ending, that ending carries the logo: a chime added on top was rejected.
- A sound the story needs (a calendar ding, the one click that matters) is checked against the music at that moment (Measuring the balance, below). On one film a ding was 4-5 dB under the music and inaudible; it needed +12 dB and a 6 dB dip in the music under it.
- No whoosh on every cut, no game-style UI bleeps.
- Sound never carries the only copy of a fact.

## Silence

Silence is a beat. Common uses: the first 1-3 seconds before the first line; a stop for a limit or a claim; a silent end card in explainers.

## Measuring the balance

Claude can't hear the mix, and the mix table below sets faders, not what is heard: on one film a calendar ding mixed "below the music" was inaudible at 4-5 dB under it, and a shirt rustle sat far above it. Keep the mix as stems and run `scripts/sound_balance.py` (`build-and-qa.md`, Sound balance) on every render with effects or voice: it reports each effect and voice against the music playing at that moment. As starting points, a sound that must be heard measures at or above the music around it; a background sound (a rustle, steps, a room) sits at or below it; a voice sits at least 6 dB above it. Report the numbers to the user and let their ears decide.

## Mix

| Element | Level |
|---|---|
| Music with no narration | 0.30-0.40 (never above 0.50) |
| Music under narration | 0.12-0.18 |
| Effects, when used | set by measurement, not by fader: a must-hear sound at or above the music around it, background sounds at or below it (Measuring the balance, above) |

Deliver at about -14 LUFS integrated, true peak -1 dBTP or lower. Measure with `ffmpeg -i output/cut.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -12`. Reference films range from about -27 to -9 LUFS and many clip, so don't copy their level.

Trim music to its best window; fade in 0.2-0.4 s and out 0.8-1.5 s, unless the track's own ending lands on the logo (then cut only its last ring, as in `sound-stage.md`, Music). Move at most one to three story turns toward strong musical beats, by no more than 0.15 s; product events never move to fit the music.
