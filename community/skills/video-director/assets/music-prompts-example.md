# Suno prompts for the music (example)

A worked example for a 52-second comedy ad: a person in a rush, a product moment that turns it around, a payoff, then the logo. Copy the shape; write the time map and prompts from your own film's approved scene lengths.

**How to make them:** in Suno, choose Custom, switch Instrumental on, and paste one prompt into the Style box. Leave the lyrics empty. Make two of each and send back the ones you like. Each track should run at least 1 minute 10 seconds so there is room to cut. Dips and the timing to each scene are done in the edit, not in Suno.

**What the film needs from the track (about 52 seconds):**
- 0:00-0:10, the rush begins: small, sly and hurried
- 0:10-0:11, the bleeped word: the music dips under it (done in the edit)
- 0:11-0:20, the scramble: comes back quick and busy
- 0:20-0:36, the product at work: steady, lifting as things come right
- 0:36-0:44, the payoff: a clear lift into something bright and confident (dips under the spoken greeting at 0:40)
- 0:44-0:47, the last gag: drops to a light tap, then lifts again under the headline
- 0:47-0:52, the logo: the track's own ending, settling on one clean note

**What to listen for:** a clear change from sneaky to bright somewhere in the track, a steady beat to cut on, a clean ending, and no singing or humming.

**Rights:** for an ad, make the tracks on a paid Suno plan, in the account of whoever owns the film. Songs made on the free plan can't be used commercially.

---

**1. Sneaky strings, bright lift**
```
instrumental, playful comedic underscore, pizzicato strings, plucked upright bass, light finger snaps, tiptoe rhythm, 108 bpm, sly and hurried at first, a busy scramble section, then a bright lift with glockenspiel and warm brass, sunny and cheeky, steady beat throughout, clean modern mix, ends on a single clean note, no vocals
```

**2. Morning funk**
```
instrumental, upbeat indie funk, clean Rhodes piano, tight muted funk guitar, handclaps, warm bass, 112 bpm, starts small and sly with just guitar and bass, builds steadily, then opens into a confident, feel-good groove with full drums, bright morning energy, steady beat throughout, ends on a single clean note, no vocals
```

**3. Marimba pop**
```
instrumental, quirky light pop, marimba and plucked synth, staccato rhythm, soft kick, 100 bpm, sneaky first section, steady build, then full drums, claps and a warm bass line, cheerful and polished, steady beat throughout, ends on a single clean note, no vocals
```

**4. Retro spy groove**
```
instrumental, cheeky retro spy groove, walking upright bass, brushed drums, muted trumpet stabs, vibraphone, 120 bpm, sly and tense at first, steady groove in the middle, then a big bright horn-section lift, playful not dark, steady beat throughout, ends on a single clean note, no vocals
```

**The plan for `fit_music.py`** once a track is chosen (cuts on its bar lines; each piece stretched 3% or less; a 10 dB dip under the bleep and 8 dB under the greeting; the track's own ending from 47 s, its last ring cut and faded at the film's end):

```json
{"film": 51.8,
 "pieces": [{"track": [0.0, 11.70], "film": [0.0, 11.5]},
            {"track": [11.70, 20.69], "film": [11.5, 20.25]},
            {"track": [27.44, 47.68], "film": [20.25, 40.39]},
            {"track": [47.68, 54.44], "film": [40.39, 47.0]},
            {"track": [91.56, 97.13], "at": 47.0}],
 "dips": [{"from": 9.85, "to": 11.5, "db": -10, "ramp": 0.2},
          {"from": 40.55, "to": 42.45, "db": -8}],
 "fade_out": 0.25}
```
