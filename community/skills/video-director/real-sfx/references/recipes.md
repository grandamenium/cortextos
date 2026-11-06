# Sound design recipes and what backs them

Source of the numbers: the author's profile of 13 reference films, 308 picture events (`learn_style.py`; the profile
itself is not shipped). It gives few numbers, and they are honest: below it says what was measured and what is taken from
common practice (marked "practice").

## What was measured on the references

| Measure | Value | How to use it |
|---|---|---|
| Mix loudness | on average −18 dB RMS per second, ~10 dB spread between seconds | A reference for balance: SFX should not "shout" over the music. Master the result to −14 LUFS |
| The sound's peak relative to the picture event | median +6…+20 ms, 25–75 % = −60…+80 ms | The loud point of the sound sits on the moment or 10–20 ms later. Peak alignment already takes this into account; for hits on a cut you can use `t + 0.015` |
| Sounds with "air" against lows on an event | on 65–70 % of bursts and onsets the band < 120 Hz (sub) grew, on cuts 41 % | Not every hit is heavy: lows only on significant moments |
| Density of sound events | ~15 per 10 s including music, picture events ~7 per 10 s | No more than one sound per picture event, and not on every one |
| Hook | a sound event in the first 2 s in 100 % of the films | Do not leave the first 2 s quiet |
| Long pause | median between events 0.4 s, the longest 3.2 s | Emptiness longer than 3–4 s without a reason looks like a hole |

## What could not be measured (important not to make it up)

- **Which exact sound sits on an event.** In the references the music covers the SFX; after correcting for chance
  coincidences, "a sound exactly on the event" is distinguishable from noise in only 4 films of 13, ~12 % on average.
  Detailed recipes like "cut = such-and-such sound" cannot be derived from this data.
- **The "riser → dip → hit" rule** looks impressive in one film, but across 13 films it occurred only 13 times (0.3 per
  10 s). It is a device for main moments, not a norm.
- Learning this needs references without music, with a separate SFX track, or the user's manual labels (which sound is
  heard there). `learn_style.py` recomputes the profile in a minute.

## Recipes (practice, use deliberately)

### 1. A cut (the default)
A short `whoosh` of 0.3–0.7 s, peak at `t − 0.06`, and a `hit` at `t + 0.015` if the cut is heavy.
```json
{"t": 2.0, "label": "cut", "pick": {"role": "whoosh", "target_dur": 0.5, "max_dur": 0.9}, "fit_dur": 0.5, "anchor": "peak"},
{"t": 2.015, "label": "cut hit", "pick": {"role": "hit", "punchy": true, "max_dur": 1.2}, "gain_db": -3}
```

### 2. The main accent (a title, a logo, the finale), in layers
`hit` + `sub_drop` (lows, filtered) + a short bit of "air" (`glitch`/`glass`) on top, no more than 3 layers.
**This is a recipe for a cinematic film.** In a product / UI film, a person in blind tests (2026-10-15) called a low hit
"off topic" (the bed and bass boosts in four films, then "not here" for 5 of 9 sub_drops on the final cut), and chose a
music box as the hit on a scene change: there the accent is a `chime` / a short bright `hit`, without a `sub_drop`, until
the person asks for lows. If lows are needed, they are short (about 1.2 s), not a 3 s sub drop.
```json
{"t": 5.0, "label": "title lands", "pick": {"role": "hit", "punchy": true, "max_dur": 1.5},
 "layers": [
   {"dt": 0.0,  "pick": {"role": "sub_drop", "max_dur": 2.0}, "gain_db": -7, "lowpass": 150},
   {"dt": 0.02, "pick": {"role": "glass", "max_dur": 0.8},   "gain_db": -12}
 ]}
```

### 3. Riser → dip → hit (for one or two heroic moments per film)
The riser ends 0.15–0.25 s before the hit, then a short silence, then a hit with a sub layer.
Make the silence by trimming the riser with `max_dur` while the hit stands on `t`.
```json
{"t": 9.8, "label": "build", "pick": {"role": "riser", "target_dur": 1.8}, "fit_dur": 1.8, "anchor": "end"},
{"t": 10.0, "label": "drop", "pick": {"role": "hit", "dark": true, "max_dur": 1.5},
 "layers": [{"dt": 0.0, "pick": {"role": "sub_drop", "max_dur": 2.0}, "gain_db": -6, "lowpass": 150}]}
```
Put the riser with `anchor: end` on `t − 0.2`, not `t`: there must be a pause between them.

### 4. An interface cluster (clicks, panels appearing)
One `click` or uisfx signal per significant appearance, the rest quiet. Three clicks in a row on the same appearance sound
like mush.
```json
{"t": 3.5, "label": "panel", "uisfx": "open", "pitch": 0},
{"t": 3.68, "label": "tick", "pick": {"role": "click", "max_dur": 0.3}, "gain_db": -9}
```

### 5. Music carries the film
If the picture's events sit on the music's beats, do not add your own pulse on top: keep only the hits of significant
moments in the SFX and leave the rest to the music. A heavy low hit under the music's heavy bass is not heard: take a
brighter hit (`--bright`) or cut the layer's lows (`highpass`).

### 6. Voice carries the film (a narrator on top)
The voice leads, the SFX serve it. `mix.py --voice-safe`; no beds; UI ticks and whooshes 6–10 dB quieter (`gain_db`
−6…−10 in the cue); heavy hits only in speech pauses or on phrase changes (look at the original's spectrogram with
`zoom.py`); `masking.py` lists the sounds lying on top of speech: move them into a pause, shorten them (`max_dur`) or cut
them with `highpass: 400`.

### 7. What `suggest_cues.py` does by default
It takes no more than 5 sounds per 10 s, skips weak moments, puts a hit only on the top third of cuts (by `pct`, not by
`strength`: `strength` hits 1.0 for many), a sub layer only under the heaviest, alternates pitch (0, −2, +2, −3, +1, −1),
takes UI from uisfx by a hint (`hint`: button, card, toggle, success…). This is a skeleton; a person then corrects it by
eye.
