---
name: real-sfx
description: Sound design for motion videos with REAL recorded sounds from the user's own libraries (a sorted main pack of whooshes, hits, risers, pops, chimes, keystrokes, foley, ambiences plus fallback libraries) and UI cues from uisfx, never synthesized. Finds the moments from the project's own cue list or from the synthesizer script that makes its sound, from a HyperFrames composition, from a screen recording (regions: typing, toasts, scrolls, clicks) or from the picture itself, picks and processes the sounds, places them on the exact frame at the level the author's own sounds had, keeps the music and voice, takes a synthesized layer baked into the render OUT instead of doubling it, and returns a new MP4, a separate SFX WAV track, a cue report and a self-critique scoreboard. Use whenever the user asks to add sound effects or SFX, sound-design, "озвучь", "добавь звуки", "сфх", whoosh/hit/riser/click/typing sounds, UI sounds, to replace synthesized or generated sounds with real ones, or to make a motion graphic, promo, explainer, UI animation, screencast, HyperFrames render, After Effects or Premiere project sound better, or complains the sound is synthetic, generic or out of sync, even if they do not say "skill" or name a library.
---

# real-sfx: real sounds for a motion video

The goal: the film sounds as if a person with a good library had cut it. So:

- **Sound is never synthesized.** Sources: the user's libraries (`config.json`) and uisfx (a ready CC0 pack of
  interface sounds, itself synthesized: the one exception, only for interface moments; "no synthesis" turns it off:
  `--ui library`). No fitting sound: the moment stays quiet and goes into the report. This overrides
  "no track: synthesize" from motion-standards.
- **You cannot hear.** Sound is read as numbers, words and pictures (`references/listening.md`). Do not present a pick
  as listened to: say what was checked by eye and by measurement, and what the user should listen to.
- **Keep the music and voice** when they carry the film. The result is always a new MP4 **and a separate WAV track**.
- **Do not double.** Synthesis baked into the render's audio is replaced by the real sounds, not layered under them
  (step 1). The critique measures this as a number (the `doubling` axis).
- **Do not change the project or the skill folder.** Put all working files in your own folder (`work/`, `result/`).

## Quick path

First `python scripts/setup.py check` (ffmpeg, main/extra libraries, index, uisfx) and
`python scripts/look.py FILM.mp4 --out work/look` (frames with time + the original sound under them). Then, by what you have:

```
# 1. the project has an event list (docs/cues.json, scripts/cues.json) OR a script that synthesizes its sound (audio.cjs)
python scripts/from_cues.py PROJECT_FOLDER|docs/cues.json --video RENDER.mp4 --out work/cues.json
# 2. screen recording without a list: ui_events.py ... (references/screencast.md), then from_cues.py work/ui/events.json
# 3. picture only:                    find_moments.py FILM.mp4 --out work/moments; suggest_cues.py work/moments/moments.json --out work/cues.json
# 3b. SOFT COLOURED ANIMATION without a list (UI preview, illustration, motion graphics): automation sees 5-6 moves of 40.
#     step 2, "Silent animation without a list": find_moments.py FILM --out work/moments --fine; look.py FILM --at T --span 2.4
#     --step 0.1 --out work/at.png; YOUR OWN event list from the frames (references/typed-cues.md) -> from_cues.py - --ui library
python scripts/mix.py work/cues.json --out result/film_sfx.mp4 --plan     # what goes where; then without --plan
python scripts/critique.py result/film_sfx_resolved_cues.json result/film_sfx_sfx_track.wav
python scripts/levels.py   result/film_sfx_resolved_cues.json result/film_sfx_sfx_track.wav --json work/edits.json
# a film whose sound is ONLY SFX (no music or voice of its own): small sounds in the holes, then mix.py again (step 4, "Small-sound layer")
python scripts/texture.py work/cues.json --moments work/moments/moments.json
# the same film: a bed (one long dark real recording under the whole film; step 4, "Bed"), then mix.py again
python scripts/bed.py work/cues.json [--list]
# numbers against nine finished SFX reels (step 6, "Against the reference"): no scores, does not affect the verdict
python scripts/critique.py RESOLVED.json WAV --style clean-sfx-refs
# human ears made cheap (step 6): a page with the critique's questions and a one-tap verdict; the masking model
python scripts/listen_page.py build work/listen --moments result/film_sfx.mp4 --critique RESOLVED.json WAV
python scripts/listen_page.py serve work/listen [--lan]        # then: listen_page.py results work/listen --log
python scripts/mix.py work/cues.json --out result/film_sfx.mp4 --masking        # which sounds the rest hides (needs the venv)
```
A project folder finds its own event list (`docs/`, `scripts/`, `assets/`); the synthesizer script is read only when
there is no list. **Choose all `from_cues.py` flags before editing the sheet**: running it again wipes manual edits
(then `sheet.py apply`).
Voice in the film: `mix.py ... --voice-safe` (depth `normal`; `--voice-depth light` when there are many quiet textures,
`deep` only for rare sounds in pauses: it takes the interface out of the mix entirely). Music carries the film: `--duck`.
Loudness: a rebuilt base matches the original by default; your own: `--target-lufs NUMBER`.
No index, or the libraries moved: `python scripts/build_index.py`, then `python scripts/listen.py tag-index`.
No uisfx: `setup.py init --uisfx`. Another machine: `setup.py scan FOLDER`, `setup.py add-library NAME PATH [--tier
main|extra] --index`. Run scripts from the skill folder; quote paths with spaces or non-Latin characters; your own Python
with non-Latin paths on Windows: `PYTHONUTF8=1`. In PowerShell, quotes break JSON arguments: put them in a file.

## Where the sounds come from

| What is needed | Where from |
|---|---|
| The base: whooshes, hits, risers, pops, chimes, keys, paper, foley, ambience | **the main library** (`tier: main`, path in `config.json`). A sorted pack with `catalog.json` / `catalog.csv` gives every sound its type and source recording, which beats guessing from file names |
| What the main library lacks: low drops, coins, short glitches | fallback libraries (`tier: extra`, marked `~` in results): only when the main library has fewer than three fitting sounds |
| Designed packs with their own roles | roles `granular`, `atmosphere`, `power`, `music_transition`, `voice` are never requested by auto-picking: take them explicitly (`--role`, `"pick": {"role": ...}`) |
| An interface moment: click, tick, window, notification | uisfx (`--ui auto`) when the list itself names interface kinds (click, chime...): `from_cues` says why and where (`routes: key -> library:click, pop -> uisfx:select`) |
| Typing | always the library's real keyboard, even with `--ui auto`; a run of 8+ `click` events 35–170 ms apart is recognized as typing by `from_cues` itself (`--no-typing-detect`) |
| Physical contact: ball, step, bead, object | always the library: a ball on the floor is a dull thud, not `select` (recipe below) |

No library yet: `setup.py init --uisfx` alone gives 78 CC0 UI cues. Free real-recording sources worth checking (read each
licence): Freesound (CC0 filter), Sonniss GDC bundles, Mixkit, Pixabay sound effects.

"From my library", "no synthesis" or "sounds synthetic": **`--ui library`**. An accent on the logo or a "cha-ching" in a
project with uisfx interface sounds: `--from-library pop,bell` (**kind names from the list**); for one sound:
`sheet.py set --at T --label bell id=65`. Under tonal music:
- the pitch steps of uisfx repeats and of the library's tonal sounds (chime, pop, glass, coin) turn off by themselves when
  the project has a score (`--ui-pitch off|cycle`);
- **the pitch of a real sound is tuned to the notes of the music**: `mix.py` takes the sheet's `music_ref` (the bed
  without effects, the music stem) or `--music-ref FILE` and shifts a tonal sound by whole semitones up to 2 plus the cents
  that put it on a note (2.5 in total), if that puts it on a note; noise is left alone (`--no-tonal-fit`;
  `scripts/tonal.py SOUND --music FILE --at T` shows the notes);
- the intervals of the author's own frequencies (`tick(t, 1800 * 2 ** (4 * i / 12))`) become the pitch steps of the
  replacement (`melody:`).

## Workflow

### 1. What is already in the sound
`look.py` shows the spectrogram of the native sound (voice is bands of phrases, music a carpet with a beat, silence is
black); `listen.py voice FILM.mp4` gives the share of speech and music. Three cases:
- **The author's music or voice**: they stay, SFX go on top (`--duck` / `--voice-safe`).
  **Exception (a person's answer on a real film, 2026-10-19)**: the film was sent "to be sound-designed", its native
  sound is music only (`listen.py voice`: speech 0 %), and the person wants it **without** the music, like their own clean
  SFX reels. Make a version without music (`from_cues.py ... --ui library --drop-original`, then `bed.py --id ... --level
  -46` with a favourite atmosphere), and a version with music if useful, and say which is which. In a blind choice of
  three (original / effects over music / effects only) the person chose the last one without a single complaint.
  `from_cues` prints `BAKED:` on such a film although there is no baked synthesis (speech 0 %, music 84 %, the attacks do
  not match the events: 7 % against 9 % by chance): this is a false alarm.
- **Synthesis baked into the track** (the project was written for a synthesized score): real sounds on top of it are
  doubling. `from_cues.py` checks this itself (`BAKED:`, `unbake:`) and removes the synthesis from the base without
  touching music and voice; how exactly, and what to do if the script fails or the synthesis sits inside the music stem
  (`--extra-synth`): **`references/project-audio.md`** (read it as soon as the output has `BAKED`, `WARN stems`,
  `unbake: not possible`, or the project synthesizes its sound with a script). After the build `critique.py` prints the
  `doubling` axis: the correlation of the layer with the original and with the new film (should be about 0).
- **The sound of clips playing inside a screen recording's window**: native, stays; events inside those windows are
  dropped.

### 2. Find the moments (from the best source to the worst)
- **The project's event list or synthesizer script** → `from_cues.py` (below). In detail: `references/typed-cues.md`.
- **A screen recording** → `references/screencast.md` (`ui_events.py` regions, matching keystrokes to characters, clip sound).
- **HyperFrames with `data-start`** and no list: `from_hyperframes.py PROJECT --out work/moments.json`.
  "1 moments" with 18 elements means the motion does not follow `data-start`: look for a synthesizer script.
- **Video only**: `find_moments.py FILM --out work/moments [--roi x,y,w,h] [--from A --to B] [--fine]`; kinds
  `cut`, `burst`, `onset`, `settle` (`settle` also fires on an empty frame or a loop at rest: look at the frame);
  `look.py --moments ...` draws the frames of the moments. Skeleton: `suggest_cues.py` (`references/recipes.md`); a draft
  is a start, not an answer. **`--fine`** for soft coloured animation (gradients, glows, pastel shapes that change colour
  rather than brightness): it also reads chroma changes, moments get `src=chroma|luma`; on three such films it finds
  33–69 % of the events an agent wrote down from the frames (within 80 ms), against 13–25 % from brightness alone; 3–4
  times more candidates (15–25 per 10 s). These are candidates: the frames decide.
- **Under music**: `beats.py FILM --out work/beats.json --plot work/beats.png`; with `usable: true`, `mix.py --snap-beats`
  (±50 ms). The grid **is checked against the kick** (the low band < 125 Hz separately): it prints how many beats landed
  on a kick within 40 ms. A grid next to the kick (the tracker sat on the hats, "0.22 s off") is moved onto it; a grid
  that lands on nothing gets `usable: false`, and `--snap-beats` ignores it. `--plot` draws the band, the kicks (green
  marks) and the grid (red lines): the marks sit on the lines, or do not trust the grid. If the music is yours and can be
  fitted to the picture: `beats.py FILM --suggest-offset work/moments.json` says how far to shift the music so cuts and
  hits land on beats (advice only; the music is not touched).

**`from_cues.py`**: `python scripts/from_cues.py LIST|PROJECT_FOLDER|SCRIPT.cjs|- --video RENDER.mp4 --out work/cues.json`
(`-` reads the list from stdin; a BOM from PowerShell is understood). What it does and says by itself:
- **is it the right render**: the list misses the picture (`VERDICT`); **a design-time list against a render timed to
  the voice**: a time map from the project's anchors (`timing.json` with `anchors` or `WARP`, `src/timing.js`) or from
  the onsets of the synthesized stems, each event lands on its own onset (`time map`); `--time-map FILE`,
  `--warp off|stems|audio`;
- **synthesis under the list**: a whoosh lands on the peak of the synthesized sound, its length is measured from it
  (`retime:`); no move if the peak belongs to another sound (pop, bell) or the list time is already the centre of the
  whoosh: named with the reason; synthesis onsets with no event in the list are listed (`--add-unlisted tick` turns them
  into events);
- **timbre**: the brightness of the whooshes being replaced (centroid of the synthesized layer) feeds the pick
  (`timbre:`); `--tone airy|dark` sets it by hand;
- **an unknown kind** (`bead`, `soft`): it shows how the project defines it. Say it in one line, no file needed:
  `--kind bead=click`, `--kind soft=pop`, a role with limits `--kind bead=role:click,max_dur=0.3,onsets_max=1`,
  `--kind bead=slices:740,763` (single sounds from these recordings; the quietest ones, 12 dB down, are not taken),
  `--map '{"glass":{"ids":[65,54],"role":"chime"}}'` (`ids` in turn; an element `{"id":800,"slice":[0.78,0.12]}`);
  `--remember` keeps it. Summary: `declared N events: M voiced, K silent`; the critique counts silent kinds as a hole;
- **clusters**: events of one kind closer than 25 ms are one sound (`--fuse`), runs faster than 14/s are thinned
  (`--max-rate`), the output says how many of each (`thinned: key 23, tick 11`);
- **a typing stretch** (`{"t":19.99,"type":"typing","len":0.36,"n":99}`) unfolds into keystrokes (`--type-rate`).

**Silent animation without a list** (UI preview, illustration, motion graphics; all four blind tests on 2026-10-15 were
like this). Automation reads brightness and sees 5–6 moves of ~40 in soft coloured animation, and `suggest_cues` draws
only whooshes from them: the draft here is a skeleton, not an answer. The path on which four agents out of four finished
the film:
1. `look.py FILM --out work/look`, then `find_moments.py FILM --out work/moments --fine`.
2. **Close-up frames in 2–3 s windows**: `look.py FILM --at T --span 2.4 --step 0.1 --out work/at.png` (24 frames with
   time, 8 per row; `--span 1 --step 0.125` for a fast stretch). Write down **what moves and when**: an element
   entering, a morph, a landing, a cursor press (visible by colour), digits counting, appearing and disappearing, a scene
   change.
3. **Write the event list from the frames** (format and kinds: `references/typed-cues.md`, section "No project list"):
   `[{"t":0.80,"type":"pop"},{"t":2.19,"type":"key","len":1.4,"n":17},{"t":5.53,"type":"wipe"}]`, and
   `from_cues.py - --video FILM --out work/cues.json --ui library --moments work/moments/moments.json` (the list via
   stdin or a file). **`--ui library`** if the sound must not be synthesis: `--ui auto` sends click/chime/tick to uisfx.
4. Then the usual loop. `sync` on such a picture can be n/a: check with `zoom.py` and `look.py --at` by eye. After a
   dense list `texture.py` will usually add nothing: that is fine.

**One physical object** (a ball, steps, drops, knocks): `--one-source thump,pop` (any kind, including one named with
`--kind`: ONE family of recordings is taken, takes in turn). `thump` and `hit` are taken from **clean single hits** of
foley recordings (`listen.py onsets ID` shows them; bodies and scatters are cut into pieces), as one family; under music
a hit gets a 150 Hz highpass (`--thump-hp`, `--no-bank` turns it off). Variety is not judged for such an object. A
smaller hit's level goes up with pitch automatically. The decay of hits (a ball) follows the author's `g`; the levels of
the pieces are matched by perceived loudness. What your library lacks (a rubber ball, rolling, plastic): do not invent
it, leave it quiet. Motion across the picture: `"pan": -1..1` in a cue (`sheet.py set --at T pan=-0.6`).

### 3. Editing the cue sheet without an editor
`python scripts/sheet.py show SHEET` (indexes are always in time order and work for any next edit);
`set --at 2.0 --label thump gain_db=-3 id=800` (a time alone names a layer; if there are two, add `--label`/`--index`;
`id=`, `file=`, `uisfx=` replace `pick`), `set ... --unset slice`, `drop`, `shift --by 0.12 --role whoosh`,
`gain --db -3` (`--role` knows the role of a cue with `id` too), `move`, `add SHEET '{...}'` / `add SHEET --from cues.json` /
**`add SHEET --event key@89.37 --event bell@40.7:0.8`** (a moment by kind and time: routed like `from_cues`),
`top SHEET keep_audio=no 'base_audio=[{"file":"D:/p/music.wav","keep_level":true},{"file":"D:/p/vo.wav","key_only":true,"gain_db":1.1}]'`
(`keep_level` do not pull the base's loudness, `key_only` the stem only drives the ducking), in a batch:
`apply SHEET edits.json` (`[{"at":2.0,"label":"pop","set":{"gain_db":-6}}, {"label":"bead","drop":true}]`),
`freeze SHEET RESOLVED.json` (pins the chosen files: **do it after the first round**, otherwise picks drift).

### 4. Choosing sounds for the main moments: look, do not guess
```
python scripts/search.py --role hit --says "thunk|thump" --max-dur 1.3 --sheet work/hits.png --paths
python scripts/search.py --role whoosh --like 412 --target-dur 0.7 --sheet work/w.png
python scripts/search.py --query "lego|bodyfalls" --role foley        # substring of name and folder; a|b = either
python scripts/listen.py onsets 800                                   # single sounds of a recording and the CLEAN hits among them
```
PNG: the waveform and spectrogram of each candidate with its id (`references/listening.md`). **Three kinds of search
words**: `--query` a substring of the name and folder (non-English too); `--says` plain words for the sound, YAMNet tags,
English words for non-English names; `--tag thunk,thump` a model tag. Length in the results is **audible**: `0.36*`
means the file is longer and the rest is silence. `--paths` prints the path, tags and source recording. Write the chosen
number as `"id": 412`.
Choose by what moves and what it hits: paper is paper, a bead on a string is a plastic click.
**Library names lie**: a pack's "Wrap Elements" is Crackle/Fire to YAMNet, "Game Select" is Pig/Oink, UI swipes are
Camera/Ratchet. Before taking an `id` from a fallback library, look at its tags: `search.py --paths`.

**Small-sound layer (`texture.py`): only for a film whose sound is one thing, SFX and nothing else.** In nine finished
SFX reels the pause between gestures is 0.5–1.2 s (median 0.7), the longest hole 1.4–5.8 s (median 2.5). Six films voiced
by the skill, measured the same way, had pauses of 0.7–1.5 s and holes up to 1.3–6.5 s (four of them with music, which
fills the holes there): small moves (a settle, a small appearance, a tremble) were left quiet on purpose, and in a film
without music nothing but sound can fill them. `texture.py SHEET --moments M.json` voices such moves of the PICTURE that
have no cue and lie in holes (longest hole first) with a short real drop or bubble from the main library (`water`, `pop`,
otherwise `click`; at most 0.3 s; never synthesis), 2–6 dB under the role's level, and only up to the pace of the
references, **in gestures per 10 s** (`--target`, default 9.0: the low edge of the middle of the nine references; no more
than 4 sounds per 10 s). What it does NOT do: it never touches your cues (it only adds `"texture": true`; running it again
replaces the layer, `--remove` removes it); it does not put a sound on a strong move or a cut without sound (that is a
hole, it lists them: voice them for real); it does not work under the film's own music or voice (`--even-with-audio`
overrides the refusal); it does not put a sound on a still picture. `--dry` only shows. Run `mix.py` again after it; the
critique counts such sounds as half an event and does not judge variety or balance against the author by them, nor put
them on the listen list. **Listen to the film with the layer and without it** (`--remove`): the script cannot hear
whether the small stuff gets in the way. Running `from_cues.py` again wipes the layer: run `texture.py` after it.

**Bed (`bed.py`): also only for a film whose sound is SFX and nothing else.** In finished SFX reels the sound never
drops out between events: the quietest tenth of the film sits on average 24 dB under the loudest 250 ms (median of nine;
middle −26…−21), there is 0 % digital silence (250 ms windows quieter than −70 dBFS) in seven of nine (2 % and 15 % in
two); films voiced by the skill had 4–67 %.
A person hears a room, a hum, wind, a pad; a film with clean silence between sounds sounds bare. `bed.py SHEET` takes ONE
long, dark (centroid up to 900 Hz), steady real recording from the library (`role: ambience`; voice, animals, songs,
water, fire, steps are dropped by tags and by name; steadiness is measured: `ripple`, the spread of 50 ms levels over a
second, at most 4 dB, and `swing` at most 12; `--list` shows the candidates with numbers, `--id N` or `--query` choose by
hand) and lays it under the whole film in pieces with an even overlap (`fade_curve: qsin`, no loop seam; three DIFFERENT
recordings in turn if the film is longer than one). **The level is absolute: −54 dBFS** (`--level`, the median of 250 ms
windows in the finished master; `mix.py` renders the film without the bed itself and runs it through the limiter and the
master, the `bed:` line in the output). This is a person's answer, not the references': three blind ladders of one
recording at −56 / −50 / −44 / −36 dBFS, −56 chosen every time, −50 called "all good", −44 and louder "loud", the version
without a bed called "empty" (so a bed is needed, but at the edge of hearing); the old rule of −24 dB under the loudest
place of a dense film gave about −34 and was "the hum gets in the way". `--floor DB` is the old relative rule (that many
dB under the loudest). The recording the person called an "all good" bed (wind, grass) passes the tag and brightness
filters and wins the ranking. What it does NOT do: it never touches your cues (it adds `"bed": true`; running it again
replaces it, `--remove` removes it); the critique does not count the bed as an event (no gesture, hook, variety or
hierarchy), and `verify.py` and `critique.py` judge the sounds on the track **without the bed**
(`*_sfx_track_nobed.wav`, written by `mix.py`): a bed fills any window, and a sound lost by the render would otherwise go
unnoticed; under the film's own music or voice it refuses (`--even-with-audio`). The `--style` table shows its effect in
the rows `the quietest tenth under the loudest` and `digital silence`. The bed does not touch the film's sounds: the track
without it equals the render without a bed to the sample, including when matching the loudness of the replaced layer
(measured without the bed). Running `from_cues.py` again wipes the bed: run `bed.py` after it. **Listen to the film with
the bed and without it** (`--remove`): the script cannot hear whether the hum gets in the way or sounds like "noise".
Human ears already corrected the choice once: on four films the "Ambient Noise" recording (clean lows up to 400–600 Hz,
the level moving by 5–8 dB about twice a second) was called "the hum gets in the way" in three of four, while steady
recordings measure 2–3 dB. So `bed.py` does not take moving recordings, and `bed.py --scan` measures the whole library
once (cache `ambience_steady.json`; the picker reads it too for `role: ambience`, and a moving recording drops in rank).
A bed is optional: if the person hears the film better without it, there is none (`--remove`).

### 5. Build
```
python scripts/mix.py cues.json --out result/film_sfx.mp4 [--plan] [--duck | --voice-safe [--voice-depth light|normal|deep]]
     [--base-audio FILE[:dB][@sec] ... [--duck-music]] [--drop-original] [--snap-beats] [--stems] [--export-clips DIR]
     [--target-lufs -14 | --no-loudnorm] [--sfx-trim-db X] [--no-match-layer] [--no-level-roles] [--ceiling-db -1]
     [--music-ref FILE ...] [--no-tonal-fit] [--no-mono-fix]
```
The cue sheet schema is in the header of `mix.py`: `fit_dur`, `pitch`, `reverse`, `lowpass`/`highpass`, `pan`, `mono`,
`layers`, `loop_to`, `anchor`, `slice` (`[start, length]`; `"first"` the first SIGNIFICANT sound of the recording,
`"loudest"` the loudest, `{"onset": k}`). A mouse click in a recording is two clicks: `"slice": "first"` keeps the press.
A named `id`/`file` beats `pick`. A sound with a quiet lead-in (a breath, 85 ms of silence before a pop) is placed by its
audible start.
**The moment of a sound** (round 9, the sync test). For roles placed by their peak (hit, whoosh, riser, chime, error,
glitch, foley, paper ...), `mix.py` chooses the point from the sound itself: a sound that gets loud fast (a hit with a
body, a beep, a texture) is placed by its **arrival** (`anchor: arrive`: the first 60 ms within 6 dB of the loudest), a
sound that builds to a climax (a riser, a swell, a lift before a drop) by its peak. The loudest 20 ms of a noisy sound lie
somewhere inside it, and placed by the peak such a sound came 0.15–3 s before the picture (in round 8 the mark "missed
the picture": 46 % against 9 %). Arrival is used when the sound gains strength (from −20 to −3 dB) faster than 0.45 s and
arrives at least 0.10 s before the peak; otherwise the peak. In the blind test of round 9 (17 cards, 10 decided) arrival
won 5 cards with sounds that gain strength fast, the peak won 5 (4 control risers and lifts, and a paper crunch),
"start" won none. An explicit `"anchor": "peak"` or `"arrive"` is taken as is (`arrive` skips both thresholds);
`verify.py` judges a sound with arrival by its arrival.
**Mono.** A stereo sound with its channels in antiphase (about 2 % of a typical library) sums to zero in mono: on a phone
speaker, in one earbud, in a platform's mono mix it is gone. `mix.py` plays such a sound from its single louder channel
on both sides (`mono:` in the output; `--no-mono-fix` keeps it as recorded, `"mono": false` on a cue keeps one sound,
`"mono": true|"left"|"right"` does it by hand) and **measures it by that channel** (by the sum it is "silence").

**Levels.**
1. A role is brought to its peak (hit −4, whoosh −9, riser −12, click/ui/pop −14, ambience −24 dBFS); `gain_db` is the
   deviation from the target. Equal peak is not equal loudness: a thin bright whoosh at the same peak is 15 dB quieter
   than a dark one. Within a role, sounds are brought to one **perceived** loudness (the median, at most ±6 dB, peak no
   higher than −1.5 dBFS) BEFORE the author's `gain_db` (`level:` in the output; `--no-level-roles`; `loud_after_db`,
   `level_adj_db` in resolved).
2. If `from_cues` knows the loudness of the replaced layer, the whole SFX layer is pulled up to it (`SFX layer: ... -> +N
   dB`; only upward). **The pull absorbs a global raise**: `sheet.py gain` on all cues changes nothing in the end. Louder
   than the replaced layer: `--no-match-layer` and gain; one quiet moment: gain on it alone.
3. **Event balance against the author's layer**: `levels.py RESOLVED WAV --json work/edits.json` reads the momentary
   loudness (BS.1770, 400 ms) of the new and the replaced layer around each event and writes a batch for `sheet.py
   apply`: typing, ticks and bells land where the author's sound was. The critique calls the same the `match` axis.
Warnings: `capped` (a quiet recording), a slice raised by more than 12 dB, **a cue peaks above 0 dBFS before the limiter**.

**What is not obvious about levels** (it came up for all four agents in the blind test):
- **`gain_db` is a deviation from the role level, and the roles are already quiet** (pop and click −14, chime −13 dBFS
  peak): small stuff is `0…−4`, not −7 (that is a −21 peak). What will really land is shown by `mix.py --plan` (the
  `gain` column) and `peak_after_db`.
- **The leveller trap.** A thin bright sound is raised to the role's perceived loudness (up to +6 dB), its **peak**
  becomes the highest in the film, the master gain drops, and the whole film loses 2–3 LU although no other sound was
  touched. The cure is to lower THAT sound (`peak_after_db` in resolved, `--plan`), not to raise the others;
  `--no-level-roles` turns the levelling off. `sheet.py freeze` pins files and layers, but not these level corrections.
- **Lowering a sound that hits the peak ceiling gives half as much**: the normalizer brings it back towards the role
  median. Measure the result by `peak_after_db`, not by the `gain_db` you wrote.
- **The ceiling after AAC.** Default −1.0 dB; the encoded file can be 0.1–0.2 dB higher, and in a film with short sharp
  sounds the codec sometimes throws ONE frame 2–4 dB above its input (the limiter before it cannot see this). `mix.py`
  re-measures the file and fixes such a place locally: a dip of ~0.1 s by exactly as much as the frame overshot (output
  `AAC overshoot: N place(s) ... dipped locally`); the whole ceiling is lowered only when the overshoot is everywhere.
  The whole ceiling used to be lowered, and the film lost up to 0.8 LU. `--ceiling-db -1.5` still works.
- **A cue's label stays from its kind** ("whoosh x0.25") after the sound is replaced by `id`: `sheet.py set --at T
  label=...`, otherwise the reports lie. A typing piece has the role `click`, like a mouse: `sheet.py gain --role click`
  moves both keys and clicks; separate them with `--label key`.
- **A thin sound and its loudness.** A shimmer peaking at −6 dBFS at −47 LUFS is common: such layers hold the limiter and
  the master gain and are barely heard. Lower the peak, raise the density.

**Loudness.** With no native sound the result is pulled to −14 LUFS. With the film's own sound the author's balance is
not touched; a base rebuilt without synthesis (script, stems) is pulled to the original's loudness by default and takes
its peak ceiling. **A sparse film cannot be raised to −14**: the loudest peak sets the loudness; the honest move is to
accept the measured value (−15..−16), raise the quietest events or lengthen the tails. Sub drops add 2–3 LU that a phone
speaker does not have: read the loudness without the lows too (`highpass 150`). `*_sfx_track_in_mix_level.wav` is the
SFX at the MP4's level.

**Under a voice.** `--voice-safe` ducks the SFX by the **voice stem** (`voice_stems` in resolved), otherwise by the whole
base. Console: how many dB the ducked track is quieter than the dry one in power. `normal` ≈ −9 dB on the sounds,
`light` ≈ −4, `deep` down to −24: quiet typing and ticks under `deep` and in a film with speech 75 % of the time vanish from
the mix (the critique calls this `audibility`). Move the sounds into pauses or keep `light`/`normal`.

### 6. The self-critique loop (required before showing the result)
```
python scripts/verify.py   RESOLVED.json WAV [--all]
python scripts/review.py   RESOLVED.json WAV --out result/review.png [--chunk 30]
python scripts/critique.py RESOLVED.json WAV [--moments M.json] [--list] [--style clean-sfx-refs] --rounds N --out result/critique.md
python scripts/levels.py   RESOLVED.json WAV --json work/edits.json        # against the author's layer, if known
```
1. `verify.py`: every sound is on the track in its place (`MISSING`: the render lost it, rebuild); a click is judged by
   its first burst, the layers of one moment together; for a short loop it prints `loop seam` (the seam is quiet); the
   `mono:` line says how many dB the track loses in mono (0 = channels equal, 3 = unrelated, 6+ = something cancels)
   and which sounds.
   `critique.py`: scores 1–10 for hook, sync, coverage, pacing, variety (by source recordings; a run of 5+ identical ones
   is a "machine gun", except clock ticks), hierarchy (by perceived loudness), peak headroom, loudness, balance,
   `doubling` (the synthesis is gone), `match` (events against the author's balance), `audibility` (after ducking the
   sound is still heard), `mono` (the mix summed to mono: a sound that cancels is named with a timecode and `sheet.py set
   ... mono=true`), and under a voice by speech and lows, plus the three worst with timecodes (`--list` prints every
   speech moment with the reduction it needs). `n/a` does not mean "passed". Thresholds: balance is good when an event's
   median is −12…+2 dB to the sound around it (large ones −8…+5); match ±3 dB; audibility: the sound's peak no lower than
   −30 dB to the film's sound around it (if the author had it that quiet too and `match` is fine, that is a note, not a
   fail); mono: a sound losing more than 6 dB in the sum is a fail, the track as a whole up to 3.5 dB is normal (a wide
   stereo recording).
   **The listen list**: at the end it prints up to five moments where the numbers are least sure (the hook, the loudest,
   misses in sync, balance, speech, mono, sounds that were pulled up or retuned; different kinds of risk, not one), with
   a question for the ear; `--listen-out FILE.wav` cuts them (3 s of the film's own sound each) into one file. The script
   cannot hear: this is what a person should listen to in headphones and once on a phone speaker. Do not say "sounds
   good" without it.
   **The only ears there are belong to a person; make them cheap.** `listen_page.py build FOLDER --moments FILM.mp4
   --critique RESOLVED WAV` cuts the list's moments into 3-second pieces and builds a page: the critique's question
   under each, a one-tap verdict (ok / loud / buried / harsh / extra / missing) and a note; `--ab LABEL v1.mp4 v2.mp4
   [v3]` puts versions of one film under 1 and 2 in random order (bed or not, two bed levels, original or the skill),
   switching on the fly; a pair can have its own question (`"label ## question"`), its own version names (`--labels` can
   repeat: the set matching the number of versions is used), pieces shorter than 8 s loop, up to nine versions.
   `listen_page.py serve FOLDER [--lan]` (with `--lan` the page also opens on a phone on the same network: that one time on
   a speaker); answers are written to `verdicts.json` on every tap; `results FOLDER [--log]` unblinds them (what won,
   which marks a version got) and with `--log` appends them to the skill's `listening_log.json`: data to check the
   numbers against (the masking model below, the thresholds). Do not fit the answers to the numbers: the page shows the
   question, not a number.
   **Taste by category (`taste_test.py`)**: which sound is good for a click, a transition or a hit is decided by one
   person, and the library holds hundreds of sounds per role. The test takes one and the same picture from the person's
   films (a button, a wipe, a cut to a title, a notification; `hosts.json` names the moment) and puts ten different sounds
   of one role on it: the three the picker would take first (so the skill's default is tested too) and the seven most
   unlike each other in brightness, attack, length and weight. Each category has a repeat of one sound and one sound of
   another role (controls: does one ear say the same thing twice, does the picture decide; marked in the results, the
   person is told). A clip is the sound where `mix.py` would put it (role level, no normalization). Verdicts: love / ok /
   not here (a good sound, but not for this picture: mark what it is better for) / never; reasons and "better for" as
   chips. `taste_test.py plan OUT --hosts hosts.json`, `render OUT`, `page OUT`, then `listen_page.py serve OUT/page`;
   `results OUT` prints by category the verdicts, the agreement of the repeat, what the picture said about the other
   role, how the loved differ from the rejected (median brightness, attack, length) and how the picker's first three
   were rated; `--apply` puts "love" into `taste.json` `love` (the picker prefers them), "never" into `ban` (never taken),
   "not here" into `not_for` (ranked 1.2 lower in that role, not a ban), "better for" into `better_for`, the rest into
   `notes`. Ratings accumulate in `taste_ratings.json` (a personal file, not packaged; one entry per role and sound: one
   file can sit in several roles); `taste_test.py round OUT --hosts H.json --roles ...` makes the next round in one
   command (rated sounds are not taken; `render --only ROLE` rebuilds one section). The `ambience` section is the bed: a
   recording is laid under the picture with three identical "loved" sounds on top (`accompany` in hosts.json), and the
   person judges the background; the controls there are a repeat and a "known" bad hum. `plan --reuse N` puts N
   already rated sounds (best and worst) into a new picture: does the verdict belong to the sound or to the picture;
   `ladder OUT --hosts H --sounds ...` lays one background recording at several levels and without it (blind, 1 / 2 / 3
   ...): the answer is a level, not a recording. An answer with chips only and no verdict is still an answer (the reasons
   are counted). **Interface sounds: library or pack.** A host with `"kind": "uisfx"` puts one cue (`press`, `select`,
   `success`) in all 12 uisfx packs next to two loved library sounds on one picture. taste.json gets `uisfx` ({cue:
   {pack: verdict}}; "synthetic" without a verdict counts against the pack) and `ui_source` ({cue: "library" |
   "uisfx"}, when the means differ by 0.5 or more). `from_cues.py` then takes a library sound for that cue (an explicit
   `--ui uisfx` still forces the pack), and when it takes a pack, the best by taste (`taste_pack`; a tie keeps the
   default); `notification` takes the verdict of `success` until it is tested separately. In the author's first test
   (2026-10-15) the library won `press` and `success` (clicks 2 of 2 "love" against 1 of 12 packs, "synthetic" on 11 of
   15), while for `select` the packs held (9 of 14 "love"). **Taste is not predicted from measured features or
   embeddings** (checked on the answers: within a role the correlation is 0.1–0.2), so the lists are explicit, and sounds
   nobody has heard yet are judged by a person, not a model. Until the person has answered, there is no taste: do not
   make it up from file names.
   **Tuning by ear and choosing a sound for a moment** (rounds 5 and 6, `adjust_test.py`, `moment_test.py`): two tests of
   another kind, on a piece of a real film with its music and voice. `adjust_test.py` gives the person a level slider for
   the new layer and accent variants, blind, with marks along the way ("loud", "harsh", "extra", "missing").
   `moment_test.py` puts ONE sound from the candidates on a moment of the film, blind and at one loudness (the film's
   current sound, the best by taste, ones far from them, ones named by hand, silence): the person says which sound
   belongs to the moment. `listen_page.py` builds the pages (kinds `adjust` and `moment`); details at the top of each
   script; they are not in the selftest (run by hand).
   **The masking model** (`mix.py --masking`, needs the venv: `listen.py install --yes`; or `maskmodel.py RESOLVED CLIPS`
   after `--export-clips`): each cue is a target, everything else at that moment (other cues, the bed, the native music
   and voice) is a masker, over 24 Bark critical bands, with masking spreading to neighbouring bands, forward masking and
   the absolute threshold of hearing; a sound is heard where its power over 192 ms stands above the threshold. It prints
   how many sounds are clear (10 dB or more above the threshold), fine (3–10), borderline (0–3), masked; **how many dB of
   headroom the bed takes from the sounds** and which sounds would be heard without it; the five least audible, with the
   band and what covers them (bed / other cues / native sound). Masked sounds go on the listen list with the question "is
   this heard at all". Layers, texture and background (ambience, vehicle) are not judged: they are meant to sit under the
   rest. **This is a textbook model of tones and noise applied to transients:** it puts the places in order, the ear
   checks the first ones; `--offset-db` tunes it to your verdicts from the page.
   **A model that describes sound in words** (`hear.py`, optional, about 3.1 GB: `hear.py install --yes`):
   MiDashengLM-0.6B on the CPU, offline, revision and code checked. `hear.py bench` on sounds with a known answer showed
   that **it is no ear for this skill's questions**: "is there a hum under the sounds" gets "yes" to everything (6 of 12 =
   chance), "how many clicks" gets "1" (0 of 6), "which is louder" gets "the first" (3 of 6); what the sound is
   (category): 12 of 27, good for hits, glass and typing, bad for whooshes, paper and ambience. So it is NOT built into the
   critique: what it cannot do is measured (the critique, the masking model); `hear.py describe FILE [--span T0 T1]
   [--ask ...]` stays a rough second opinion on WHAT the sound is.
   **Against the reference** (`--style clean-sfx-refs`, or your own style from `learn_style.py`): at the end, a table
   "this film | median of the references (middle half) [range] | inside / low / high / BELOW / ABOVE". No scores, it does
   not affect the verdict or the exit code. The SFX layer is measured by the same code as the references: gestures per
   10 s, the pause between gestures (median, P90, longest), the spread of gesture levels, the typical gesture against the
   loudest, the first sound, the share of gestures with lows, the 30–100 Hz bed, the quietest tenth under the loudest
   (`floor`), digital silence, loudness. Under every step outside the middle, a line on what usually moves the number
   (`texture.py`, `bed.py`, hierarchy, hook). **Read it honestly**: the references are SFX reels where the sound is the
   content; a film with its own music and voice should not look like them (the table says so itself), and "BELOW" on the
   bed means only "there is no such bed", not "bad". Your own references: `learn_style.py refs.txt --name mine`; a line
   `film.mp4 | | x0,y0,x1,y1` limits the picture to a region (an AE timeline under the animation is not motion).
   **How the critique counts pacing** (this was missing from the text and threw agents off): events are taken by cue; a
   run of one role with pauses up to 0.25 s (0.7 s for typing) is one event, layers within 80 ms are attached to their
   moment (the first key of typing is not attached to another sound), `click`, `ui`, `data`, sounds shorter than 0.15 s
   and the `texture.py` layer weigh half, `layers` are not counted. The norm is 3–9 weighted events per 10 s, a 1.2
   penalty for each above 9 (0.4 for a project list). **For density there is one definition: gestures per 10 s**, a
   gesture being sounds without a 0.25 s pause between them (layers and keys count, `common.gesture_times`). This is
   what the `--style` table, the `texture.py` target and "too many" for a film WITHOUT its own sound use: by the nine
   references (6.9–15.1, median 11.4) "too many" starts above 1.1 × 15.1 ≈ 16.6 gestures per 10 s, not above 9 weighted
   events; a film with its own music and voice keeps 3–9. Intervals where moments are not judged (still frames, a clip
   with its own sound): the sheet key `quiet`, `sheet.py top quiet='[[8.4,10.7]]'`.
   `--append` appends the round to `--out`: the history of the loop in one file.
2. `review.png` as a strict sound designer; fast places up close: `zoom.py RESOLVED WAV --at 12.4 --span 3 [--video FILM]`
   (`--out` defaults to next to the sheet); under a voice `masking.py RESOLVED WAV [--lowend]` (takes
   `*_sfx_ducked.wav` from the sheet itself; without that file it judges the dry track and warns that masking is
   overstated), `speech_map.py FILM --cues RESOLVED` (a map by the sheet's voice stem, not by the music under it).
3. Fix the **three worst** (`sheet.py`), rebuild, repeat. A new film gets at least 3 rounds, all axes 8+. Tell the user
   the scores and what was fixed. Typical: speech is buried → shorter sound, quieter by the amount stated, into a pause;
   lows → highpass ≥140 Hz; low balance → `gain` on the events and `--no-match-layer`, not `--sfx-trim-db`.
4. **An axis falls short because of the metric, not the sound**: explain it with timecodes, do not cure it by inserting
   a sound. This happens with: a recording under clips with their own sound; a short 4–5 s loop; still frames; waiting
   for a model's answer and reading (silence is right); a sparse film (loudness, balance); one physical object; density
   set by the author; a film where the voice runs 80 % of the time (balance is judged by events outside speech); a word
   starting under a sound (the attack frame), a breath in a phrase pause; a screen recording (pacing is the person's
   pace: `pacing` is n/a for it).

### 7. Deliver
The path to the MP4, the separate WAV (stems and clips if made), how many sounds from which libraries (the report names
`library`, `main pack N / fallback M / uisfx K`), what was left quiet and why, the final loudness, the five moments of the
listen list (with timecodes and a question for the ear; `critique.py --listen-out`). Ask the user to name sounds they
did not like: `taste.py ban ID --why "..."` / `love ID`. Handoff to HyperFrames / After Effects / Premiere:
`references/handoff.md` (ask before calling other skills). Round renders (`rounds/`, `_work/`) weigh hundreds of MB:
offer to delete them.

## Taste rules

- Hook: a sound in the first 2 s (music or voice is a hook too; if the picture's first event is later, the sound on it is
  the hook), then something new every 2–4 s; emptiness longer than 4–5 s without a reason (a still frame, native sound)
  is a hole.
- One big moment is layers (hit + pop + dust), not one loud file; at most 3. Layers within 80 ms count as one event for
  pacing; in `layers` they stay one moment for sync too.
- Not a hit on every cut (heavy ones at most a third); repeats of one file give the pack away; four takes of one
  recording are one sound.
- Auto-pick name filters (mouth pops; drum fills in ui / pop / click / chime; censor beeps in error; stretching, rubbing
  and belt creaks in cartoon) are lifted by a word in the query (`--query`, `says`, `like`) and by the person's love: a
  sound in `love` always passes them. A ban and a love apply to every copy of a recording (one recording can sit in the
  library twice).
- The interface language is one: buttons sound like one family. Typing: animated 8–14 keystrokes a second, live typing
  one sound per keystroke, one keyboard for the whole text.
- Under a voice, SFX 6–10 dB quieter without beds, but audible; under music do not add your own pulse, put what matters
  on the beat, tonal sounds on the note.
- A role label drives the pacing score (`click`, `ui`, `data` weigh half): a run of light texture goes in as `click`, but
  do not hide real accents behind the label. The `texture.py` layer weighs the same (`"texture": true`).
- A film whose sound is only SFX is denser than one with music: by the nine references 6.9–15.1 gestures per 10 s (median
  11.4, median pause between gestures 0.7 s), the longest hole a median of 2.5 s (`critique.py --style`). This is an
  example, not a law: a calm picture has its own silence.

## What is where

- `scripts/`: `setup`, `build_index`, `look`, `find_moments`, `ui_events`, `from_cues`, `from_synth`, `unbake`,
  `from_hyperframes`, `beats`, `suggest_cues`, `texture`, `bed`, `search`, `contact_sheet`, `sheet`, `mix`, `levels`, `tonal`,
  `listen_page`, `taste_test`, `adjust_test`, `moment_test`, `maskmodel`, `hear` (the optional describing model),
  `verify`, `review`, `zoom`, `masking`, `speech_map`, `critique`, `refstyle`, `taste`, `learn_style`, `listen`,
  `package`.
- `references/`, as needed: `project-audio.md` (synthesis in the render's sound, stems, a synthesizer script, the
  author's chain); `typed-cues.md` (the list format, kinds, time map); `screencast.md` (screen recordings);
  `event-map.md`, `recipes.md` (which sound for which event); `listening.md` (tags, spectrograms);
  `handoff.md` (handoff to other programs); `profiles/clean-sfx-refs.json` (the numbers of nine reference SFX reels for
  `critique.py --style`).
- `tests/selftest.py`: a selftest on synthetic material (189 checks, 188 without the skill's venv, ~5 min); run it after
  editing scripts, 3 times in a row.
- `tests/resound.py` (+ `tests/resound.md`): **the blind "resound" test**. Finished films with good sound (a list, as for
  `learn_style.py`) are cut down to one animation and stripped of all sound, a fresh agent voices each from `SKILL.md`
  alone, then both sounds are measured by one code and compared in numbers (density, pauses, first sound, lows, silence,
  timing agreement against chance) and with an A/B pair to listen to. Run it when you change what decides WHICH sound
  lands (choice, density, bed, critique), not only that nothing breaks. Steps: `prepare`, `snapshot`, `prompt` (the text
  for the agent), agents, `eval`, `check`; details in `tests/resound.md`.
