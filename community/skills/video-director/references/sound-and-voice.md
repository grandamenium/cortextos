# Sound and voice

Sound is planned with the picture in the motion spec, not added at the end. One coherent sound system per film: a score language, an emotional arc, an ambient bed, effects only where a real thing on screen makes a sound, and a voice direction.

## Narration

- Narration on or off is the user's explicit decision in the brief.
- About 2.5 words per second for promos and explainers (about 150 words a minute for tutorials). The script is shorter than the video.
- About 20-24 words per 10-second block, one thought per sentence. Write numbers as they are spoken.
- Narration adds context and judgment; it doesn't read the interface aloud or repeat the on-screen line.
- Picture changes land at phrase boundaries; a piece is revealed when the voice names it.
- In tutorials, the camera starts moving about 0.7 s before the sentence naming the target, and about 1 s of pause comes before a new idea.
- Keep narration separate from any generated clip's audio. Clip prompts ask only for music, ambience or effects.
- Clean studio voice by default. Describe the voice (age, pace, warmth) rather than naming a real person.

## Music

- Music, or a bed under the voice, carries the whole film. Quiet only on purpose: a held product shot, a live-sound opening, a joke beat, the end card.
- Shape the music to the edit: build, thin out under the proof, hit the turn, end cleanly. One loop at one level is "sound as wallpaper".
- Build by adding layers or cut density, not by getting louder.
- Plan at least one quiet moment tied to something on screen (the music stops for a claim, or drops to silence at a limit).
- Motion-graphics films with a strong beat can lock chapter changes to 8-beat blocks; footage films cut on speech and action over a steady bed.
- No copyrighted songs or "trending audio". Use an original or licensed track and record its source, license and trim in `assets/audio/`.

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
- If used, an effect is the sound of a real thing on screen (a machine, a game, a phone receiving a message), or a click on the one press that matters in a UI film. It lands on the frame of the event, never before, quiet and under the music.
- Never a sound on text, a line arriving, or the logo.
- No whoosh on every cut, no game-style UI bleeps.
- Sound never carries the only copy of a fact.

## Silence

Silence is a beat. Common uses: the first 1-3 seconds before the first line; a stop for a limit or a claim; a silent end card in explainers.

## Mix

| Element | Level |
|---|---|
| Music with no narration | 0.30-0.40 (never above 0.50) |
| Music under narration | 0.12-0.18 |
| Effects, when used | below the music: no higher than the music row above |

Deliver at about -14 LUFS integrated, true peak -1 dBTP or lower. Measure with `ffmpeg -i output/cut.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -12`. Reference films range from about -27 to -9 LUFS and many clip, so don't copy their level.

Trim music to its best window; fade in 0.2-0.4 s and out 0.8-1.5 s. Move at most one to three story turns toward strong musical beats, by no more than 0.15 s; product events never move to fit the music.
