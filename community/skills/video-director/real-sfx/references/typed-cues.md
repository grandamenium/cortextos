# The project's event list (typed cues)

If a film is made with code (HyperFrames, Remotion, "a film as a function of time"), the author usually knows what
happens and when. Projects written for a synthesized score keep this knowledge in a list `docs/cues.json` or in the calls
of a synthesizer script (`audio.cjs`: `whoosh(4.2)`, `click(18.35)`): time, event kind, relative loudness. Such a list is
more precise than any frame analysis: a keystroke, a click, a coin, a wipe are named, not guessed. `from_cues.py` takes
the times and kinds and replaces the synthesis with **real** sounds (interface moments from uisfx, the rest from the
library).

```
python scripts/from_cues.py docs/cues.json --video renders/film.mp4 --out work/cues.json       # the list in a file
python scripts/from_cues.py PROJECT_FOLDER --video renders/film.mp4 --out work/cues.json         # the project's own list, otherwise the script's calls
echo '[{"t":1.2,"type":"click"}]' | python scripts/from_cues.py - --video film.mp4 --out work/cues.json
python scripts/mix.py work/cues.json --out result/film_sfx.mp4 --voice-safe
```
Sound already in the render (synthesis, stems, a script): `references/project-audio.md`. Screen recordings:
`references/screencast.md`.

## No project list: write it from the frames

Soft coloured animation (a UI preview, an illustration, motion graphics) has no list from the author, and automation
(`find_moments`, `suggest_cues`) sees 5–6 moves of ~40 and draws only whooshes. Then the event list **is written by
whoever looks at the frames** and fed to the same `from_cues.py`: the sounds are chosen by the same rules as for a project
list (typing from a real keyboard, levels by role, one render with the critique). All four blind tests on 2026-10-15
went this way.

```
python scripts/find_moments.py FILM.mp4 --out work/moments --fine          # candidates; chroma+luma, src in the moments
python scripts/look.py FILM.mp4 --at 2.2 --span 2.4 --step 0.1 --out work/at.png     # 24 frames, 0.1 s apart
cat work/events.json | python scripts/from_cues.py - --video FILM.mp4 --out work/cues.json --ui library \
     --moments work/moments/moments.json
```
`work/events.json` (any keys from the table below, nothing extra needed):

```
[{"t": 0.06, "type": "whoosh", "len": 0.7},            {"t": 0.80, "type": "pop"},
 {"t": 1.12, "type": "whoosh", "len": 0.5, "g": 0.8},  {"t": 2.19, "type": "key", "len": 1.4, "n": 17},
 {"t": 4.10, "type": "hit"},                           {"t": 5.53, "type": "wipe"},
 {"t": 9.60, "type": "chime"}]
```
What to write down: an element entering and leaving (`whoosh`, `pop`), a morph and a landing (a quieter `hit`, `thump`),
a cursor press (`click`; the cursor is visible by colour), a run of counter digits (`tick`), typing (`key` with a stretch:
`len` seconds, `n` characters), a scene change (`wipe`, `hit`), success or a badge appearing (`chime`). **The time is the
frame where something starts to happen**, not the still frame after it. Do not write down what the ear does not need:
flicker, background drift, static. `--ui library`: interface kinds from real recordings (otherwise `click`, `pop`,
`chime` go to uisfx, that is, to synthesis).
Pitch of repeats: `from_cues` cycles the pitch of repeated sounds by ±1–3 semitones; `--ui-pitch off` keeps the own pitch
of uisfx repeats and of the library's tonal sounds (chime, pop, glass, coin); for one sound: `sheet.py set --at T pitch=0`.

## Format

A JSON list (or `{"cues": [...]}` / `{"events": [...]}`) of objects:

| key | synonyms | meaning |
|---|---|---|
| `t` | `time`, `at`, `start` | seconds on the timeline of **the render you are voicing** (or in the author's time, see the time map) |
| `type` | `name`, `kind`, `event`, `sound` | the event kind, table below |
| `g` | `gain`, `volume`, `vol` | 1.0 = nominal; converted to dB relative to the role |
| `len` | `dur`, `duration`, `length` | seconds: the build of a riser, the length of a whoosh; for `key` the length = the typing stretch |
| `n` | `chars`, `count` | for a typing stretch, the number of keystrokes (otherwise `--type-rate` per second, 11 by default) |

Other fields (`notes`, `f0`, `seed`: synthesis parameters) are ignored. If a whoosh has no `len` in the list or in the
script, it is measured from the synthesized sound it replaces (`length: N ... measured`).

## Kinds and what they become

| kind (synonyms) | source | pick |
|---|---|---|
| `whoosh` (swoosh, swipe, slide, move, zoom, push, pan) | library | `whoosh`, length from `len`, pitch cycled |
| `wipe` (transition, scene, cut) | library | `whoosh` 0.7 s, 4 dB quieter |
| `hit` (impact, slam, stamp, stinger, boom) | library | `hit` with a sharp attack, pitch cycled |
| `thump` (kick, bass_hit) | library | **clean single foley hits** (body, floor, wood; 150 Hz highpass under music), otherwise a dark `hit`, otherwise `sub_drop` |
| `riser` (build, swell, tension) | library | `riser` of length `len`, starting at `t` |
| `drop` (sub_drop) | library | `sub_drop`, otherwise a dark `hit` of 1–3.5 s |
| `click` (press, tap, button, select) | uisfx `press` | pitch ±1–2 semitones cycled; from the library: single clicks of the main pack, then the first click of double-click recordings |
| `pop` (bubble, blip, appear) | uisfx `select` | the same; from the library the `pop` role (mouth pops are not taken without a word in the query) |
| `tick`, `tock` | uisfx `progress-step`, `snap` | the same; from the library `click`, then `water` drops |
| `chime` (bell, ding, notify) | uisfx `notification` | from the library the `chime` role (bell, ring) |
| `success` (ok, done, complete) | uisfx `success` | from the library `chime` with the Ding tag |
| `glass` (crystal) | library `chime` (a ringing "glass" ping, Star/Ding) | |
| `shatter` (smash, break) | library `glass`: **breaking** glass | |
| `magic` (sparkle, shimmer, glow, heal, reveal) | library `chime`, the word magic | sparkles, music box, harp |
| `water` (drip, splash, droplet) | library `water` | drops of 0.1–0.7 s |
| `coins` (cash, money, purchase) | library `coin`, otherwise uisfx `purchase` | |
| `key` (keystroke, type, typing) | **pieces of real typing recordings** | see below |
| `glitch` | library `glitch`; if there are no short ones, a piece (0.12–0.5 s) of static or noise | |
| `error`, `camera`, `paper`, `data`, `ambience` | library, the role of the same name | |

The script does not guess an unknown kind: it stays quiet and goes into the "NOT mapped" list (and into the summary line
`declared N events: M voiced, K silent`; the critique counts silent kinds as a hole in coverage). You can say what it is
**in one line, without a file**:

```
--kind bead=click                                      the project's kind = a kind the script knows
--kind soft=role:click,max_dur=0.3,onsets_max=1        a role with limits (any pick key)
--kind boop=uisfx:select                               one uisfx signal
--kind bead=slices:740,763,804                         single sounds of these recordings in turn (ids from search.py); the quietest, 12 dB under the loud ones, do not go into the bank: "clean singles" only for recordings where `listen.py onsets` showed them
--kind pop=key                                         a contact tick from real keystrokes
--map '{"stomp": {"pick": {"role": "hit", "dark": true}, "gain_db": 2}}'            JSON as a string or a file
--map '{"ball": {"ids": [800, 779, {"id": 780, "slice": [0.1, 0.12]}], "role": "hit"}}'   takes in turn; an id has its own slice
--map '{"click": {"pick": {"role": "click", "max_dur": 0.7, "tier": "main"}, "slice": "first"}}'
```
`--remember` keeps the mapping for all later projects. `--ui library` takes interface kinds from real recordings instead
of uisfx, `--from-library pop,bell` only these kinds (**kind names from the list**, not roles), `--only` / `--skip` select
kinds. `--one-source thump,pop` for one physical object (a ball, steps): **one family of recordings** is picked (takes of
one recording in turn), `same_source` in the cue: variety is not judged for them; it works the same for a kind defined
via `--map`/`--kind` (`--kind soft=role:pop --one-source soft`). One detail: `from_cues` prints `routes: kind ->
uisfx:name | library:role` so the route is visible.

**The source of interface kinds** (`click`, `pop`, `tick`, `tock`, `chime`, `success`): uisfx, **if the list itself names
real interface events** (`click`, `key`, `tick`, `tock`, `chime`, `success`, `error`); a mapping via `--kind` does not
count as interface: a ball and beads stay in the library. `from_cues` prints `ui: auto -> ...` with the reason.
`--ui uisfx|library` overrides it. For "one click" from the library it takes recordings with one sound inside, then
double-click recordings with `"slice": "first"`, not three-click gestures and not typing recordings.

## Typing

A run of `key` becomes separate real keystrokes: bursts are found in typing recordings (the `typing` role, folders
Keyboard, Typing, «клав»), each is cut to 40–85 ms and placed on the key's time with 6 ms of headroom for the attack.
**One keyboard per film**: the longest recording of the main pack is taken, the next one is added only while the first
ones have fewer keystrokes than the film needs; a real keyboard before a phone one, not too quiet ones. Keystrokes already
cut by the pack (one per file) go into the bank when the recordings run short. The recording's dynamics are kept: weak
keystrokes are quieter than strong ones. A run faster than `--max-rate` (14/s) is thinned: the eye reads 24 characters a
second, the ear needs 10–14. If the library has no typing recordings, the keys stay quiet and the script says so
(`--kind key=...`).
**Typing written as `click`** (in the script `for (c...) click(6.94 + c / 48, ...)` with a "typing" comment): a run of 8
or more `click` events 35–170 ms apart and at least 0.4 s long is recognized by `from_cues` as typing and given to the
keyboard (`typing: N click events ... are typing`); the author's `g` stays, `--no-typing-detect` keeps the clicks. A
single click does not count as typing.

**Clusters.** Events of one kind closer than `--fuse` (25 ms) are one sound: five beads in 40 ms are a rattle, not five
hits. `--fuse 0` keeps them all. The output shows `fused: N` and `thinned: kind N` (what the rate rule thinned).

## Checking "is this the right render"

A list of times belongs to one version of the film. After fitting to the voice or a retime, the times drift. The script
compares the declared structural events (`wipe`, `hit`, `thump`, `drop`, `camera`: they happen **on** a picture change)
with the picture changes in the render (`--video` runs the analysis, `--moments` takes a ready one). For a list that was
itself measured from the picture (`ui_events.py`), the check is skipped.

- "list belongs to this render": 60 % or more within 120 ms.
- "consistently ±X s from the picture": an even offset, rerun with `--shift ∓X`.
- "written for another cut": less than 60 % match and no offset explains it. Take the list written for this render, or
  moments from the picture.

Whooshes and interface ticks do not take part in the check (they are placed relative to motion). Next, `--moments` prints
**strong picture changes without sound** (±150 ms): events the project forgot to declare. One final verdict is printed
after the time map (before it, the picture may have complained about an offset the map already removed).

### A design-time list, a render fitted to the voice: the time map

Projects with a voice write the list in "design time", then stretch the scenes to the voice: stems and render are new,
the list is old, and the offset is uneven (up to +2.9 s along the film). A constant `--shift` does not cure it. What
`from_cues.py` does:

1. **The project's anchors**: `timing.js|json`, `timemap.*`, `retime.*` (searched in `src/`, `assets/`, the root, `docs/`)
   with `{"anchors": [[design_t, actual_t], ...]}` or `{"DUR": ..., "WARP": [[film_time, author_time], ...]}` (for `WARP`,
   its own monotonic cubic curve). Used if they improve the match with the stems' onsets (or when the list came from a
   script that reads this map).
2. Otherwise an **estimate from the onsets** of the synthesized stems: in 6 s windows it finds the offset at which most
   events land on an onset, with a smooth path (Viterbi); then the events (not whooshes and risers) take onsets by **one
   monotonic matching over the whole film** (one event per onset; layers of one moment share an onset), not greedily one
   by one.
3. The map is applied only if afterwards at least 60 % of events meet an onset and that is 20 points better than without
   it. It prints the range of offsets, the share before and after, the number of events that took an onset, and the
   picture's verdict.

`--time-map FILE.json` (`[[list_time, render_time], ...]`) sets the map by hand, `--warp off` turns it off,
`--warp stems|audio` forces it on. An event keeps `t_declared`.

**Onsets without an event.** Synthesis can be richer than the list (a stopwatch from the beat grid): `NOTE: N onsets in
the synthesized stems have no declared event` lists the times. `--add-unlisted tick` turns them into `tick` events
(loudness from the level in the stem); without the flag nothing replaces them: look at the frames there.

## The event time and the synthesized sound

`t` in a list made for synthesis can be the **peak** of the sound (the synthesis started earlier), its **start** or its
**centre** (`add(t - len * 0.5, ...)`); `len` and `dir` are often lost. A real sound is placed with its peak on `t`, so
without a correction a whoosh arrives 0.2–0.4 s before what the author heard. When the synthesis can be measured (stems,
or a track made of it alone), `from_cues.py` finds where the synthesized whoosh or wipe really peaks and moves the event
there (`retime: whoosh 6.00 -> 6.50 s (+0.50)`). **No move is made** when: on the way to the peak the loudness drops by
6 dB or more and something already sounds at the declared time (it is another sound: a pop, a bell, a click, not the tail
of a whoosh); a whoosh is already heard at the declared time and another declared event sits on its peak (the time was its
centre); the move is longer than the sound itself. Every reason is named (`retime: whoosh at 18.70 s NOT moved to 19.30
s: ...`), every move over 0.15 s is printed. `--no-retime` turns it off. If the list is not from this render, retiming is
skipped.

**The author's melody.** If events of one kind have a numeric `freq` (in the script `tick(t, 1800 * 2 ** (4 * i /
12))`), the frequency ratios become pitch steps of the real sound (`melody: N event(s) ...`): a rise of ticks export →
build → check stays a rise.

## How to give a new project such a list

When you write a composition yourself (HyperFrames, Remotion, your own engine), register sound events at the moment you
set the motion, and write them to `docs/cues.json` with `g` and `len`. Then the sound design does not guess from frames:

```js
const CUES = [];
const cue = (t, type, o = {}) => CUES.push({ t: +t.toFixed(3), type, ...o });
// right where the animation is: a card appeared, the cursor clicked, typing started
cue(tCard + 0.05, "whoosh", { len: 0.4, g: 0.6 });
cue(tClick, "click");
cue(tType, "typing", { len: 1.9, n: 99 });                     // a typing stretch: the keystrokes unfold by themselves
// after the build: JSON.stringify(CUES) into docs/cues.json
```
Write times on the timeline the film is rendered at (if the time is "design time" and is later stretched to the voice,
put `assets/timing.json` with anchors next to it). Take the kinds from the table above. If the file has no events but a
script makes the sound, `from_synth.py` extracts the calls itself.
